# coding=utf-8
# Copyright 2026-present, the HuggingFace Inc. team.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Streamed, multi-commit upload of a folder on top of the Xet upload protocol.

How it works:

- The **coordinator** (caller's thread) walks the list of files and asks the Hub, 256 files at a
  time, what each file is (regular git blob, xet file, ignored). Regular files are accumulated
  directly; xet files are registered into a `XetSession` upload-commit, which chunks, deduplicates,
  retries and uploads them in the background while the coordinator keeps going. No Python-side
  sha256 computation: `hf_xet` computes it during chunking (single read pass over each file).
- Whenever enough files have accumulated (adaptive batch size), the batch is handed over to the
  **committer** thread which joins the xet uploads, drops unchanged files, and creates a git
  commit for the batch. While a batch is being committed, the coordinator is already uploading
  the next one.
- Interrupted uploads are resumable by simply re-running the same call: already-committed files
  are dropped (no-op detection against the remote oid) and already-uploaded chunks are
  deduplicated by the xet storage backend, transferring ~0 bytes.
"""

import queue
import shutil
import sys
import threading
import time
from typing import TYPE_CHECKING, Any, Callable
from urllib.parse import quote

from . import constants
from ._commit_api import (
    CommitOperationAdd,
    CommitOperationDelete,
    _fetch_upload_modes,
    _send_commit,
    _warn_on_overwriting_operations,
)
from .errors import RepositoryNotFoundError
from .utils import are_progress_bars_disabled, logging
from .utils._xet import (
    XetTokenType,
    abort_xet_session,
    get_xet_session,
    xet_connection_info_refresh_url,
    xet_headers_without_auth,
)


if TYPE_CHECKING:
    from .hf_api import CommitInfo, HfApi

logger = logging.get_logger(__name__)

# Number of files sent to the "preupload" endpoint per call (server-side limit).
PREUPLOAD_BATCH_SIZE = 256

# Files per git commit: adaptive, scaled up after fast commits and down after failures.
COMMIT_SIZE_SCALE = [20, 50, 75, 100, 125, 200, 250, 400, 600, 1000]
INITIAL_COMMIT_SIZE_INDEX = 6  # start at 256 files per commit
TARGET_COMMIT_DURATION = 40.0  # seconds; scale up batch size if commits are faster than this
MAX_COMMIT_INTERVAL = 5 * 60.0  # seconds; force a commit if the current batch is older than this

# Budget of regular-file content per commit (regular files are base64-encoded in the payload).
REGULAR_CONTENT_BYTES_BUDGET = 100 * 1024 * 1024

_SENTINEL = object()  # Sentinel value for the batch queue to indicate the end of the upload

# Live display tuning
_BAR_WIDTH = 20
_REFRESH_INTERVAL = 0.5  # seconds between redraws on a TTY
_NON_TTY_LOG_INTERVAL = 30.0  # seconds between summary logs when stderr is not a TTY


def _bar(current: float, total: float, width: int = _BAR_WIDTH) -> str:
    if total <= 0:
        return "░" * width
    filled = int(min(current / total, 1.0) * width)
    return "█" * filled + "░" * (width - filled)


def _format_bytes(n: float) -> str:
    for unit in ("B", "kB", "MB", "GB", "TB"):
        if abs(n) < 1000:
            if n < 10:
                return f"{n:.2f}{unit}"
            elif n < 100:
                return f"{n:.1f}{unit}"
            return f"{n:.0f}{unit}"
        n /= 1000
    return f"{n:.1f}PB"


class _LiveDisplay:
    """Three-line live progress display on stderr::

        Preparing   ████████████████████  11,100 / 11,100 ✓
        Uploading   ██████████████░░░░░░  580 / 603 files  3.8GB · 19.7MB/s
        Committing  ██████████████████░░  10,800 / 11,100  14 commits

    A small renderer thread redraws the three lines in-place every ~0.5 s on a TTY
    (worker threads only update counters under a lock). When stderr is not a TTY,
    it falls back to a periodic ``logger.info`` summary instead.

    Disabling progress bars (e.g. agent output mode) only turns off the TTY renderer:
    the non-TTY log summaries are gated by the logger verbosity alone, so consumers
    tailing stderr during a long upload still see periodic progress.
    """

    _N_LINES = 3

    def __init__(self, total_files: int, enabled: bool = True) -> None:
        self._total = total_files
        self._tty = enabled and sys.stderr.isatty()
        self._active = self._tty or logger.isEnabledFor(logging.INFO)
        self._lock = threading.Lock()
        self._drawn = False
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

        # Counters (written by coordinator/committer threads, read by the renderer)
        self._prepared = 0
        self._ignored = 0
        self._xet_total = 0
        self._xet_done: set[str] = set()  # item names; unique across batches
        self._committed = 0  # committed or skipped-as-unchanged
        self._nb_commits = 0

        # Xet transfer bytes, summed across (possibly concurrent) upload-commits
        self._xet_bytes = 0
        self._speed_ema = 0.0
        self._prev_bytes = 0
        self._prev_time: float | None = None

    # -- lifecycle (main thread) ------------------------------------------------

    def start(self) -> None:
        if not self._active:
            return
        if self._tty:
            sys.stderr.write(f"Found {self._total:,} files to upload\n")
            sys.stderr.flush()
        else:
            logger.info(f"Found {self._total:,} files to upload")
        self._thread = threading.Thread(target=self._render_loop, name="hf-upload-display", daemon=True)
        self._thread.start()

    def close(self) -> None:
        if self._thread is not None:
            self._stop_event.set()
            self._thread.join()
        if self._tty:
            with self._lock:
                self._redraw()  # final state

    # -- counter updates (coordinator / committer / xet callback threads) --------

    def notify_prepared(self, n: int) -> None:
        with self._lock:
            self._prepared += n

    def notify_ignored(self, n: int) -> None:
        with self._lock:
            self._ignored += n

    def notify_xet_registered(self, n: int) -> None:
        with self._lock:
            self._xet_total += n

    def notify_xet_uploaded(self, names: list[str]) -> None:
        with self._lock:
            self._xet_done.update(names)

    def notify_skipped(self, n: int) -> None:
        with self._lock:
            self._committed += n

    def notify_commit(self, n_files: int) -> None:
        with self._lock:
            self._committed += n_files
            self._nb_commits += 1

    def new_xet_callback(self) -> "Callable | None":
        """Progress callback for one ``new_upload_commit``.

        The byte counters in ``group_report`` are cumulative *per upload-commit* and several
        upload-commits can be in flight at once (one finalizing, one filling), so each commit
        gets its own closure tracking its own previous value; increments are summed globally.
        """
        if not self._active:
            return None
        prev = 0

        def callback(group_report: Any, item_reports: Any) -> None:
            nonlocal prev
            with self._lock:
                completed = group_report.total_transfer_bytes_completed
                self._xet_bytes += max(0, completed - prev)
                prev = completed
                for item in item_reports.values():
                    if item.total_bytes > 0 and item.bytes_completed == item.total_bytes:
                        self._xet_done.add(item.item_name)

        return callback

    # -- rendering (display thread) ----------------------------------------------

    def _render_loop(self) -> None:
        last_log = 0.0
        while not self._stop_event.wait(_REFRESH_INTERVAL):
            with self._lock:
                self._update_speed()
                if self._tty:
                    self._redraw()
                elif time.monotonic() - last_log >= _NON_TTY_LOG_INTERVAL:
                    logger.info(self._summary())
                    last_log = time.monotonic()

    def _update_speed(self) -> None:
        now = time.monotonic()
        if self._prev_time is not None and now > self._prev_time:
            rate = (self._xet_bytes - self._prev_bytes) / (now - self._prev_time)
            self._speed_ema = rate if self._speed_ema == 0 else 0.3 * rate + 0.7 * self._speed_ema
        self._prev_time = now
        self._prev_bytes = self._xet_bytes

    def _redraw(self) -> None:
        if self._drawn:
            sys.stderr.write(f"\033[{self._N_LINES}A")
        width = shutil.get_terminal_size().columns
        for line in (self._line_preparing(), self._line_uploading(), self._line_committing()):
            truncated = line[: width - 4] + "..." if len(line) > width - 1 else line
            sys.stderr.write(f"\r\033[K{truncated}\n")
        sys.stderr.flush()
        self._drawn = True

    def _line_preparing(self) -> str:
        done = " ✓" if self._prepared >= self._total else ""
        return f"  Preparing   {_bar(self._prepared, self._total)}  {self._prepared:,} / {self._total:,}{done}"

    def _line_uploading(self) -> str:
        if self._xet_total == 0:
            bar = _bar(1, 1) if self._prepared >= self._total else _bar(0, 1)
            return f"  Uploading   {bar}  -"
        n_done = len(self._xet_done)
        parts = []
        if self._xet_bytes > 0:
            parts.append(_format_bytes(self._xet_bytes))
        if self._speed_ema > 0:
            parts.append(f"{_format_bytes(self._speed_ema)}/s")
        extra = f"  {' · '.join(parts)}" if parts else ""
        done = " ✓" if self._prepared >= self._total and n_done >= self._xet_total else ""
        return f"  Uploading   {_bar(n_done, self._xet_total)}  {n_done:,} / {self._xet_total:,} files{extra}{done}"

    def _line_committing(self) -> str:
        effective = self._total - self._ignored
        commits_str = f"  {self._nb_commits} commits" if self._nb_commits > 1 else ""
        done = " ✓" if self._committed >= effective > 0 else ""
        return (
            f"  Committing  {_bar(self._committed, effective)}  {self._committed:,} / {effective:,}{commits_str}{done}"
        )

    def _summary(self) -> str:
        return (
            f"Uploading... {self._prepared:,}/{self._total:,} files checked, "
            f"{len(self._xet_done):,}/{self._xet_total:,} uploaded ({_format_bytes(self._xet_bytes)} transferred), "
            f"{self._committed:,} committed in {self._nb_commits} commit(s)"
        )


class _CommitPacer:
    """Adaptive number of files per commit, to stay below server-side commit timeouts."""

    def __init__(self) -> None:
        self._index = INITIAL_COMMIT_SIZE_INDEX

    @property
    def target(self) -> int:
        return COMMIT_SIZE_SCALE[self._index]

    def record_success(self, duration: float, nb_files: int) -> None:
        if duration < TARGET_COMMIT_DURATION and nb_files >= self.target:
            self._index = min(self._index + 1, len(COMMIT_SIZE_SCALE) - 1)
        elif duration > TARGET_COMMIT_DURATION:
            self._index = max(self._index - 1, 0)

    def record_failure(self) -> None:
        self._index = max(self._index - 1, 0)


class _Batch:
    """A group of files destined to a single git commit, with their in-flight xet uploads."""

    def __init__(self) -> None:
        self.ops: list[CommitOperationAdd] = []
        self.regular_bytes: int = 0
        self.xet_commit: Any = None  # XetUploadCommit, opened lazily
        self.handles: list[tuple[CommitOperationAdd, Any]] = []  # (op, XetFileUpload)
        self.created_at: float = time.monotonic()


class _UploadPipeline:
    def __init__(
        self,
        api: "HfApi",
        *,
        repo_id: str,
        repo_type: str,
        add_operations: list[CommitOperationAdd],
        delete_operations: list[CommitOperationDelete],
        commit_message: str,
        commit_description: str | None,
        token: str | bool | None,
        revision: str | None,
        create_pr: bool,
        parent_commit: str | None,
    ) -> None:
        self.api = api
        self.repo_id = repo_id
        self.repo_type = repo_type
        self.add_operations = add_operations
        self.delete_operations = delete_operations
        self.commit_message = commit_message
        self.commit_description = commit_description
        self.token = token
        self.headers = api._build_hf_headers(token=token)
        self.revision = revision or constants.DEFAULT_REVISION
        self.create_pr = create_pr
        self.parent_commit = parent_commit

        # The base revision is used by the coordinator for ALL preupload calls and the xet token
        # refresh URL, with the `create_pr` flag — exactly like `create_commit` does. It never
        # changes during the run, even after a PR has been created.
        self.base_revision_quoted = quote(self.revision, safe="")

        # Committer state (mutated by the committer thread only)
        self.commit_revision_quoted = self.base_revision_quoted  # switched to the PR ref once created
        self.pr_url: str | None = None
        self.pr_revision: str | None = None
        self.nb_commits = 0
        self.last_commit_info: "CommitInfo | None" = None
        self.pacer = _CommitPacer()

        # Pipeline plumbing
        self.batch_queue: queue.Queue = queue.Queue(maxsize=1)
        self.errors: list[BaseException] = []
        self.abort_event = threading.Event()
        self.display = _LiveDisplay(total_files=len(add_operations), enabled=not are_progress_bars_disabled())

        # All xet uploads share the same token refresh URL. With `create_pr`, the final ref is not
        # known in advance: `?create_pr=1` makes the server grant a token valid for PR refs.
        refresh_url = xet_connection_info_refresh_url(
            token_type=XetTokenType.WRITE,
            repo_id=repo_id,
            repo_type=repo_type,
            revision=self.base_revision_quoted,
            endpoint=api.endpoint,
        )
        if create_pr:
            refresh_url += "?create_pr=1"
        self.xet_session = get_xet_session()
        self.xet_commit_kwargs = {
            "token_refresh_url": refresh_url,
            "token_refresh_headers": self.headers,
            "custom_headers": xet_headers_without_auth(self.headers),
        }

        # `.gitignore` rules are enforced server-side: forward the local one if it's being uploaded.
        self.gitignore_content: str | None = None
        for op in add_operations:
            if op.path_in_repo == ".gitignore":
                with op.as_file() as f:
                    self.gitignore_content = f.read().decode()
                break

    def run(self) -> "CommitInfo":
        _warn_on_overwriting_operations([*self.delete_operations, *self.add_operations])
        committer = threading.Thread(target=self._committer_loop, name="hf-upload-committer", daemon=True)
        committer.start()
        self.display.start()
        try:
            self._coordinator_loop()
        except BaseException:
            self.abort_event.set()
            abort_xet_session()
            raise
        finally:
            if self.abort_event.is_set():
                # The committer exits on its own once the queue is drained (see `_committer_loop`).
                # Bound the wait so a xet call blocked on the (aborted) session can never hang the
                # shutdown — the committer is a daemon thread.
                committer.join(timeout=10)
            else:
                self.batch_queue.put(_SENTINEL)
                committer.join()
            self.display.close()
            if self.abort_event.is_set() and self.pr_revision is not None:
                logger.warning(
                    f"Upload to pull request {self.pr_url} did not complete. To resume into the"
                    f' same PR, re-run with `revision="{self.pr_revision}"` (without `create_pr=True`). Re-running'
                    " with `create_pr=True` would open a new pull request."
                )
        if self.errors:
            raise self.errors[0]
        return self._final_commit_info()

    # ---------------------------------------------------------------- coordinator

    def _coordinator_loop(self) -> None:
        import hf_xet

        batch = _Batch()
        for start in range(0, len(self.add_operations), PREUPLOAD_BATCH_SIZE):
            if self.abort_event.is_set():
                self._abort_batch(batch)
                return
            chunk = self.add_operations[start : start + PREUPLOAD_BATCH_SIZE]
            try:
                _fetch_upload_modes(
                    additions=chunk,
                    repo_type=self.repo_type,
                    repo_id=self.repo_id,
                    headers=self.headers,
                    revision=self.base_revision_quoted,
                    endpoint=self.api.endpoint,
                    create_pr=self.create_pr,
                    gitignore_content=self.gitignore_content,
                )
            except RepositoryNotFoundError as e:
                from .hf_api import _CREATE_COMMIT_NO_REPO_ERROR_MESSAGE

                e.append_to_message(_CREATE_COMMIT_NO_REPO_ERROR_MESSAGE)
                raise
            self.display.notify_prepared(len(chunk))
            for op in chunk:
                if op._should_ignore:
                    logger.debug(f"Skipping upload for '{op.path_in_repo}' (ignored by gitignore rules).")
                    self.display.notify_ignored(1)
                    continue
                if op._upload_mode == "regular":
                    batch.regular_bytes += op.upload_info.size
                else:
                    if batch.xet_commit is None:
                        batch.xet_commit = self.xet_session.new_upload_commit(
                            progress_callback=self.display.new_xet_callback(), **self.xet_commit_kwargs
                        )
                    # Upload starts immediately in the background. sha256 is computed by hf_xet
                    # while chunking, unless already known (e.g. resumed operations).
                    sha_arg = op.upload_info.sha256.hex() if op.upload_info.is_hashed else hf_xet.COMPUTE_SHA256
                    if isinstance(op.path_or_fileobj, bytes):
                        handle = batch.xet_commit.start_upload_bytes(
                            op.path_or_fileobj, sha256=sha_arg, name=op.path_in_repo
                        )
                    else:
                        handle = batch.xet_commit.start_upload_file(str(op.path_or_fileobj), sha256=sha_arg)
                    batch.handles.append((op, handle))
                    self.display.notify_xet_registered(1)
                batch.ops.append(op)

                if (
                    len(batch.ops) >= self.pacer.target
                    or batch.regular_bytes >= REGULAR_CONTENT_BYTES_BUDGET
                    or (time.monotonic() - batch.created_at > MAX_COMMIT_INTERVAL and len(batch.ops) > 0)
                ):
                    self._enqueue(batch)
                    batch = _Batch()
        self._enqueue(batch)

    def _enqueue(self, batch: _Batch) -> None:
        if len(batch.ops) == 0 and not (self.nb_commits == 0 and len(self.delete_operations) > 0):
            return
        # Blocks if a batch is already waiting: natural backpressure on scanning/uploading.
        while not self.abort_event.is_set():
            try:
                self.batch_queue.put(batch, timeout=1.0)
                return
            except queue.Full:
                continue
        self._abort_batch(batch)

    def _abort_batch(self, batch: _Batch) -> None:
        if batch.xet_commit is not None:
            try:
                batch.xet_commit.abort()
            except Exception:
                pass

    # ---------------------------------------------------------------- committer

    def _committer_loop(self) -> None:
        while True:
            try:
                batch = self.batch_queue.get(timeout=0.5)
            except queue.Empty:
                if self.abort_event.is_set():
                    return  # aborted: exit once the queue is drained, no sentinel needed
                continue
            if batch is _SENTINEL:
                return
            try:
                if not self.abort_event.is_set():
                    self._process_batch(batch)
                else:
                    self._abort_batch(batch)
            except BaseException as e:
                self._abort_batch(batch)
                self.errors.append(e)
                self.abort_event.set()

    def _process_batch(self, batch: _Batch) -> None:
        # 1. Wait for all xet uploads of this batch and finalize them (atomic xet commit). Files
        #    can only be referenced by a git commit once their xet upload-commit is finalized.
        if batch.xet_commit is not None:
            batch.xet_commit.wait_to_finish()
            for op, handle in batch.handles:
                if not op.upload_info.is_hashed:
                    op.upload_info.sha256 = bytes.fromhex(handle.result().xet_info.sha256)
                op._is_uploaded = True
            # Files whose last progress tick was missed are still done at this point.
            self.display.notify_xet_uploaded(
                [
                    str(op.path_or_fileobj) if not isinstance(op.path_or_fileobj, bytes) else op.path_in_repo
                    for op, _ in batch.handles
                ]
            )

        # 2. Drop files that have not changed compared to the remote (prevents empty commits).
        #    Their chunks were deduplicated anyway (~0 bytes transferred).
        ops_to_commit = []
        for op in batch.ops:
            if op._remote_oid is not None and op._remote_oid == op._local_oid:
                logger.debug(f"Skipping commit for '{op.path_in_repo}' (file unchanged).")
                self.display.notify_skipped(1)
                continue
            ops_to_commit.append(op)

        # 3. Create the git commit(s). On failure, scale down and split the batch.
        if len(ops_to_commit) > 0 or (self.nb_commits == 0 and len(self.delete_operations) > 0):
            self._commit_with_split(ops_to_commit)

    def _commit_with_split(self, ops: list[CommitOperationAdd]) -> None:
        try:
            self._do_commit(ops)
        except Exception as e:
            self.pacer.record_failure()
            if len(ops) <= COMMIT_SIZE_SCALE[0]:
                raise
            logger.warning(f"Commit of {len(ops)} files failed ({e!r}). Retrying in smaller chunks.")
            target = self.pacer.target
            for start in range(0, len(ops), target):
                self._commit_with_split(ops[start : start + target])

    def _do_commit(self, ops: list[CommitOperationAdd]) -> None:
        if self.create_pr and self.pr_revision is None:
            # Create the (draft) pull request explicitly and push every commit to its ref. Committing
            # with `?create_pr=1` instead would risk opening a second PR if the commit POST is retried
            # after a lost response. Created lazily so that a fully-unchanged upload opens no PR.
            # Note: PRs created this way are always opened against the default branch, hence the
            # `create_pr` + `revision` combination being rejected in `upload_folder`.
            pr = self.api.create_pull_request(
                repo_id=self.repo_id,
                title=self.commit_message,
                token=self.token,
                description=self.commit_description,
                repo_type=self.repo_type,
            )
            if pr.git_reference is None:
                raise ValueError("Server did not return a git reference for the created pull request.")
            self.pr_url = pr.url
            self.pr_revision = pr.git_reference
            self.commit_revision_quoted = quote(pr.git_reference, safe="")

        operations: list[Any] = list(ops)
        if self.nb_commits == 0:
            # Deletions and `parent_commit` ride the first commit.
            operations = list(self.delete_operations) + operations

        commit_message = (
            self.commit_message if self.nb_commits == 0 else f"{self.commit_message} (part {self.nb_commits + 1})"
        )
        t0 = time.monotonic()
        # Retried with backoff on transient errors: safe because the commit targets an explicit
        # ref (`?create_pr=1` is never used, see above).
        self.last_commit_info = _send_commit(
            operations=operations,
            files_to_copy={},
            commit_message=commit_message,
            commit_description=self.commit_description or "",
            repo_type=self.repo_type,
            repo_id=self.repo_id,
            headers=self.headers,
            revision=self.commit_revision_quoted,
            endpoint=self.api.endpoint,
            parent_commit=self.parent_commit if self.nb_commits == 0 else None,
            retry_on_error=True,
        )
        duration = time.monotonic() - t0
        self.pacer.record_success(duration, len(ops))
        self.nb_commits += 1

        for op in ops:
            op._is_committed = True
        self.display.notify_commit(len(ops))
        logger.debug(f"Committed {len(ops)} file(s) in {duration:.1f}s: {self.last_commit_info.commit_url}")

    # ---------------------------------------------------------------- result

    def _final_commit_info(self) -> "CommitInfo":
        from .hf_api import CommitInfo

        if self.last_commit_info is None:
            # Nothing was committed (everything unchanged/ignored): mimic `create_commit` and
            # return info about the latest commit on the target revision.
            logger.warning("No files have been modified since last commit. Skipping to prevent empty commit.")
            info = self.api.repo_info(
                repo_id=self.repo_id, repo_type=self.repo_type, revision=self.revision, token=self.token
            )
            url_prefix = self.api.endpoint
            if self.repo_type != constants.REPO_TYPE_MODEL:
                url_prefix = f"{url_prefix}/{self.repo_type}s"
            return CommitInfo(
                commit_url=f"{url_prefix}/{self.repo_id}/commit/{info.sha}",
                commit_message=self.commit_message,
                commit_description=self.commit_description or "",
                oid=info.sha,  # type: ignore
                _endpoint=self.api.endpoint,
            )
        if self.nb_commits > 1:
            logger.info(f"Upload completed in {self.nb_commits} commits.")
        if self.pr_url is not None:
            # PR upload: attach the PR info (commit responses don't carry it; the PR is created separately).
            return CommitInfo(
                commit_url=self.last_commit_info.commit_url,
                commit_message=self.last_commit_info.commit_message,
                commit_description=self.last_commit_info.commit_description,
                oid=self.last_commit_info.oid,
                pr_url=self.pr_url,
                _endpoint=self.api.endpoint,
            )
        return self.last_commit_info


def pipelined_upload(
    api: "HfApi",
    *,
    repo_id: str,
    repo_type: str,
    add_operations: list[CommitOperationAdd],
    delete_operations: list[CommitOperationDelete],
    commit_message: str,
    commit_description: str | None = None,
    token: str | bool | None = None,
    revision: str | None = None,
    create_pr: bool = False,
    parent_commit: str | None = None,
) -> "CommitInfo":
    """Upload a prepared list of operations through the streamed multi-commit pipeline.

    Requires `hf_xet` to be installed. See module docstring for the architecture.
    """

    return _UploadPipeline(
        api,
        repo_id=repo_id,
        repo_type=repo_type,
        add_operations=add_operations,
        delete_operations=delete_operations,
        commit_message=commit_message,
        commit_description=commit_description,
        token=token,
        revision=revision,
        create_pr=create_pr,
        parent_commit=parent_commit,
    ).run()
