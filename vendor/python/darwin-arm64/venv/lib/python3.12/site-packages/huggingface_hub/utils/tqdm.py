# Copyright 2021 The HuggingFace Inc. team. All rights reserved.
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
# limitations under the License
"""Utility helpers to handle progress bars in `huggingface_hub`.

Example:
    1. Use `huggingface_hub.utils.tqdm` as you would use `tqdm.tqdm` or `tqdm.auto.tqdm`.
    2. To disable progress bars, either use `disable_progress_bars()` helper or set the
       environment variable `HF_HUB_DISABLE_PROGRESS_BARS` to 1.
    3. To re-enable progress bars, use `enable_progress_bars()`.
    4. To check whether progress bars are disabled, use `are_progress_bars_disabled()`.

NOTE: Environment variable `HF_HUB_DISABLE_PROGRESS_BARS` has the priority.

Example:
    ```py
    >>> from huggingface_hub.utils import are_progress_bars_disabled, disable_progress_bars, enable_progress_bars, tqdm

    # Disable progress bars globally
    >>> disable_progress_bars()

    # Use as normal `tqdm`
    >>> for _ in tqdm(range(5)):
    ...    pass

    # Still not showing progress bars, as `disable=False` is overwritten to `True`.
    >>> for _ in tqdm(range(5), disable=False):
    ...    pass

    >>> are_progress_bars_disabled()
    True

    # Re-enable progress bars globally
    >>> enable_progress_bars()

    # Progress bar will be shown !
    >>> for _ in tqdm(range(5)):
    ...   pass
    100%|███████████████████████████████████████| 5/5 [00:00<00:00, 117817.53it/s]
    ```

Group-based control:
    ```python
    # Disable progress bars for a specific group
    >>> disable_progress_bars("peft.foo")

    # Check state of different groups
    >>> assert not are_progress_bars_disabled("peft"))
    >>> assert not are_progress_bars_disabled("peft.something")
    >>> assert are_progress_bars_disabled("peft.foo"))
    >>> assert are_progress_bars_disabled("peft.foo.bar"))

    # Enable progress bars for a subgroup
    >>> enable_progress_bars("peft.foo.bar")

    # Check if enabling a subgroup affects the parent group
    >>> assert are_progress_bars_disabled("peft.foo"))
    >>> assert not are_progress_bars_disabled("peft.foo.bar"))

    # No progress bar for `name="peft.foo"`
    >>> for _ in tqdm(range(5), name="peft.foo"):
    ...     pass

    # Progress bar will be shown for `name="peft.foo.bar"`
    >>> for _ in tqdm(range(5), name="peft.foo.bar"):
    ...     pass
    100%|███████████████████████████████████████| 5/5 [00:00<00:00, 117817.53it/s]

    ```
"""

import io
import logging
import os
import threading
import warnings
from collections.abc import Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Callable, ContextManager, TypeVar, cast

from tqdm.auto import tqdm as old_tqdm

from ..constants import HF_HUB_DISABLE_PROGRESS_BARS


# The `HF_HUB_DISABLE_PROGRESS_BARS` environment variable can be True, False, or not set (None),
# allowing for control over progress bar visibility. When set, this variable takes precedence
# over programmatic settings, dictating whether progress bars should be shown or hidden globally.
# Essentially, the environment variable's setting overrides any code-based configurations.
#
# If `HF_HUB_DISABLE_PROGRESS_BARS` is not defined (None), it implies that users can manage
# progress bar visibility through code. By default, progress bars are turned on.

progress_bar_states: dict[str, bool] = {}


class disable_progress_bars:
    """
    Disable progress bars either globally or for a specified group.

    This function updates the state of progress bars based on a group name.
    If no group name is provided, all progress bars are disabled. The operation
    respects the `HF_HUB_DISABLE_PROGRESS_BARS` environment variable's setting.

    Works as both a regular call and a context manager:
        disable_progress_bars()           # disables until enable_progress_bars()
        with disable_progress_bars():     # disables for the block, re-enables on exit
            ...

    Args:
        name (`str`, *optional*):
            The name of the group for which to disable the progress bars. If None,
            progress bars are disabled globally.

    Raises:
        Warning: If the environment variable precludes changes.
    """

    def __init__(self, name: str | None = None) -> None:
        self.name = name

        if HF_HUB_DISABLE_PROGRESS_BARS is False:
            warnings.warn(
                "Cannot disable progress bars: environment variable `HF_HUB_DISABLE_PROGRESS_BARS=0` is set and has priority."
            )
            self._should_reenable = False
            return

        self._should_reenable = not are_progress_bars_disabled(name)
        if name is None:
            progress_bar_states.clear()
            progress_bar_states["_global"] = False
        else:
            keys_to_remove = [key for key in progress_bar_states if key.startswith(f"{name}.")]
            for key in keys_to_remove:
                del progress_bar_states[key]
            progress_bar_states[name] = False

    def __enter__(self) -> "disable_progress_bars":
        return self

    def __exit__(self, *exc) -> None:
        if self._should_reenable:
            enable_progress_bars(self.name)


def enable_progress_bars(name: str | None = None) -> None:
    """
    Enable progress bars either globally or for a specified group.

    This function sets the progress bars to enabled for the specified group or globally
    if no group is specified. The operation is subject to the `HF_HUB_DISABLE_PROGRESS_BARS`
    environment setting.

    Args:
        name (`str`, *optional*):
            The name of the group for which to enable the progress bars. If None,
            progress bars are enabled globally.

    Raises:
        Warning: If the environment variable precludes changes.
    """
    if HF_HUB_DISABLE_PROGRESS_BARS is True:
        warnings.warn(
            "Cannot enable progress bars: environment variable `HF_HUB_DISABLE_PROGRESS_BARS=1` is set and has priority."
        )
        return

    if name is None:
        progress_bar_states.clear()
        progress_bar_states["_global"] = True
    else:
        keys_to_remove = [key for key in progress_bar_states if key.startswith(f"{name}.")]
        for key in keys_to_remove:
            del progress_bar_states[key]
        progress_bar_states[name] = True


def are_progress_bars_disabled(name: str | None = None) -> bool:
    """
    Check if progress bars are disabled globally or for a specific group.

    This function returns whether progress bars are disabled for a given group or globally.
    It checks the `HF_HUB_DISABLE_PROGRESS_BARS` environment variable first, then the programmatic
    settings.

    Args:
        name (`str`, *optional*):
            The group name to check; if None, checks the global setting.

    Returns:
        `bool`: True if progress bars are disabled, False otherwise.
    """
    if HF_HUB_DISABLE_PROGRESS_BARS is True:
        return True

    if name is None:
        return not progress_bar_states.get("_global", True)

    while name:
        if name in progress_bar_states:
            return not progress_bar_states[name]
        name = ".".join(name.split(".")[:-1])

    return not progress_bar_states.get("_global", True)


def is_tqdm_disabled(log_level: int) -> bool | None:
    """
    Determine if tqdm progress bars should be disabled based on logging level and environment settings.

    see https://github.com/huggingface/huggingface_hub/pull/2000 and https://github.com/huggingface/huggingface_hub/pull/2698.
    """
    if log_level == logging.NOTSET:
        return True
    if os.getenv("TQDM_POSITION") == "-1":
        return False
    return None


class tqdm(old_tqdm):
    """
    Class to override `disable` argument in case progress bars are globally disabled.

    Taken from https://github.com/tqdm/tqdm/issues/619#issuecomment-619639324.
    """

    def __init__(self, *args, **kwargs):
        name = kwargs.pop("name", None)  # do not pass `name` to `tqdm`
        if are_progress_bars_disabled(name):
            kwargs["disable"] = True
        super().__init__(*args, **kwargs)

    def __delattr__(self, attr: str) -> None:
        """Fix for https://github.com/huggingface/huggingface_hub/issues/1603"""
        try:
            super().__delattr__(attr)
        except AttributeError:
            if attr != "_lock":
                raise


# Prevent tqdm's default multiprocessing write-lock from spawning a resource
# tracker subprocess via fork_exec(). That path fails when stderr has an invalid
# fd (e.g. Textual TUIs that return -1 from sys.stderr.fileno()). Inter-process
# bar coordination on the HF subclass is not a supported use case. See #4065.
tqdm.set_lock(threading.RLock())


class silent_tqdm:
    """Fake tqdm object that does nothing."""

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        pass

    def update(self, n: int | float | None = 1) -> None:
        pass


@contextmanager
def tqdm_stream_file(path: Path | str) -> Iterator[io.BufferedReader]:
    """
    Open a file as binary and wrap the `read` method to display a progress bar when it's streamed.

    First implemented in `transformers` in 2019 but removed when switched to git-lfs. Used in `huggingface_hub` to show
    progress bar when uploading an LFS file to the Hub. See github.com/huggingface/transformers/pull/2078#discussion_r354739608
    for implementation details.

    Note: currently implementation handles only files stored on disk as it is the most common use case. Could be
          extended to stream any `BinaryIO` object but we might have to debug some corner cases.

    Example:
    ```py
    >>> with tqdm_stream_file("config.json") as f:
    >>>     httpx.put(url, data=f)
    config.json: 100%|█████████████████████████| 8.19k/8.19k [00:02<00:00, 3.72kB/s]
    ```
    """
    if isinstance(path, str):
        path = Path(path)

    with path.open("rb") as f:
        total_size = path.stat().st_size
        pbar = tqdm(
            unit="B",
            unit_scale=True,
            total=total_size,
            initial=0,
            desc=path.name,
        )

        f_read = f.read

        def _inner_read(size: int | None = -1) -> bytes:
            data = f_read(size)
            pbar.update(len(data))
            return data

        f.read = _inner_read  # type: ignore

        yield f

        pbar.close()


def _create_progress_bar(*, cls: type[old_tqdm], log_level: int, name: str | None = None, **kwargs) -> old_tqdm:
    """Create a progress bar.

    For our `tqdm` subclass (or subclasses of it): respects all disable signals
    (`HF_HUB_DISABLE_PROGRESS_BARS`, `disable_progress_bars()`, log level) and uses
    `disable=None` for TTY auto-detection (see https://github.com/huggingface/huggingface_hub/pull/2000),
    unless `TQDM_POSITION=-1` forces bars on (https://github.com/huggingface/huggingface_hub/pull/2698).

    For other classes: does not inject `disable` or `name`. the custom class is fully
    responsible for its own behavior. Vanilla tqdm defaults to `disable=False` (bar shows).
    Omits `name` which vanilla tqdm rejects with `TqdmKeyError`. See https://github.com/huggingface/huggingface_hub/issues/4050.
    """
    # issubclass() crashes on non-class callables (e.g. functools.partial), guard with isinstance.
    if not (isinstance(cls, type) and issubclass(cls, tqdm)):
        return cls(**kwargs)  # type: ignore[return-value]

    # HF subclass: keep the historical log-level / TTY behavior. Group-based
    # disabling is already handled in `tqdm.__init__`.
    disable = is_tqdm_disabled(log_level)
    return cls(disable=disable, name=name, **kwargs)  # type: ignore[return-value]


def _get_progress_bar_context(
    *,
    desc: str,
    log_level: int,
    total: int | None = None,
    initial: int = 0,
    unit: str = "B",
    unit_scale: bool = True,
    name: str | None = None,
    tqdm_class: type[old_tqdm] | None = None,
    _tqdm_bar: tqdm | None = None,
) -> ContextManager[tqdm]:
    if _tqdm_bar is not None:
        return nullcontext(_tqdm_bar)
        # ^ `contextlib.nullcontext` mimics a context manager that does nothing
        #   Makes it easier to use the same code path for both cases but in the later
        #   case, the progress bar is not closed when exiting the context manager.

    return _create_progress_bar(  # type: ignore
        cls=tqdm_class or tqdm,
        log_level=log_level,
        name=name,
        unit=unit,
        unit_scale=unit_scale,
        total=total,
        initial=initial,
        desc=desc,
    )


T = TypeVar("T")
R = TypeVar("R")


def _make_thread_pool_executor(*, max_workers: int | None, bar_class: type[old_tqdm]) -> ThreadPoolExecutor:
    """Create a `ThreadPoolExecutor` that shares the tqdm lock with its worker threads.

    Like `tqdm.contrib.concurrent.thread_map`, we make sure the bar class has a lock and pass it to the
    worker threads, so that bars created inside the mapped function (e.g. the per-file download bars in
    `snapshot_download`) don't race on concurrent `update()` calls. `get_lock()` creates the shared
    class-level lock if needed. Classes that don't implement tqdm's locking API (e.g. `silent_tqdm`)
    render nothing anyway, so no lock is needed.
    """
    if hasattr(bar_class, "get_lock") and hasattr(bar_class, "set_lock"):
        return ThreadPoolExecutor(
            max_workers=max_workers, initializer=bar_class.set_lock, initargs=(bar_class.get_lock(),)
        )
    return ThreadPoolExecutor(max_workers=max_workers)


def hf_thread_map(
    fn: Callable[[T], R],
    iterable: Iterable[T],
    *,
    max_workers: int | None = None,
    tqdm_class: type[old_tqdm] | None = None,
    **tqdm_kwargs,
) -> list[R]:
    """Drop-in replacement for `tqdm.contrib.concurrent.thread_map`.

    The version shipped by `tqdm` consumes results in submission order and the progress bar only advances when the "next
    item in input order" finishes. A single slow early item pins the bar near zero while later items
    complete, with everything flushed at once at the end. This helper avoids that problem by consuming items in completion
    order.

    See https://github.com/huggingface/huggingface_hub/issues/4518 for more details.

    Args:
        fn (`Callable`):
            Function to apply to each item.
        iterable (`Iterable`):
            Items to process.
        max_workers (`int`, *optional*):
            Maximum number of worker threads. Defaults to tqdm's own default.
        tqdm_class (`type`, *optional*):
            Progress bar class to use. Defaults to `huggingface_hub`'s `tqdm`.
        **tqdm_kwargs:
            Additional keyword arguments forwarded to the progress bar (e.g. `desc`).

    Returns:
        `list`: Results in the same order as `iterable`.
    """
    items = list(iterable)
    if max_workers is None:
        max_workers = min(32, (os.cpu_count() or 1) + 4)
    tqdm_kwargs.setdefault("total", len(items))
    bar_class = tqdm_class or tqdm
    results: list[R | None] = [None] * len(items)
    with (
        bar_class(**tqdm_kwargs) as pbar,
        _make_thread_pool_executor(max_workers=max_workers, bar_class=bar_class) as executor,
    ):
        future_to_index = {executor.submit(fn, item): index for index, item in enumerate(items)}
        try:
            for future in as_completed(future_to_index):
                results[future_to_index[future]] = future.result()
                pbar.update(1)
        except BaseException:
            # Cancel not-yet-started tasks so a single failure doesn't keep the whole queue running
            # (mirrors `tqdm.contrib.concurrent.thread_map`, which relies on `Executor.map` for this).
            for future in future_to_index:
                future.cancel()
            raise
    return cast("list[R]", results)
