# Copyright 2026 The HuggingFace Team. All rights reserved.
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
"""Contains helper utilities for hf CLI extensions."""

import errno
import json
import os
import re
import shutil
import subprocess
import venv
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Annotated, Literal

import click

from huggingface_hub.errors import CLIError, CLIExtensionInstallError, ConfirmationError
from huggingface_hub.utils import get_session, logging

from ._cli_utils import typer_factory
from ._framework import Argument, Option
from ._output import out


DEFAULT_EXTENSION_OWNER = "huggingface"
EXTENSIONS_ROOT = Path("~/.local/share/hf/extensions")
MANIFEST_FILENAME = "manifest.json"
EXTENSIONS_HELP = (
    "Manage hf CLI extensions.\n\n"
    "Security Warning: extensions are third-party executables or Python packages. "
    "Install only from sources you trust."
)
extensions_cli = typer_factory(help=EXTENSIONS_HELP)
_EXTENSIONS_GITHUB_TOPIC = "hf-extension"
_EXTENSIONS_DOWNLOAD_TIMEOUT = 10
_EXTENSIONS_PIP_INSTALL_TIMEOUT = 300

logger = logging.get_logger(__name__)


class _ExtensionUpdateStatus(str, Enum):
    UPDATED = "updated"
    UP_TO_DATE = "up_to_date"
    SKIPPED = "skipped"


@dataclass
class ExtensionManifest:
    owner: str
    repo: str
    repo_id: str
    short_name: str
    executable_path: str
    type: Literal["binary", "python"]
    installed_at: datetime
    description: str | None = None
    commit_sha: str | None = None

    @classmethod
    def load(cls, path: Path) -> "ExtensionManifest":
        manifest_path = path / MANIFEST_FILENAME
        if not manifest_path.is_file():
            raise CLIError(f"Manifest file not found at {manifest_path}. Your extension may be corrupted.")
        data = json.loads(manifest_path.read_text())
        # Ignore keys not in the dataclass (e.g. fields dropped since the manifest was written).
        data = {key: value for key, value in data.items() if key in cls.__dataclass_fields__}
        data["installed_at"] = datetime.fromisoformat(data["installed_at"])
        return ExtensionManifest(**data)

    def save(self, path: Path) -> None:
        manifest_path = path / MANIFEST_FILENAME
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        data = asdict(self)
        data["installed_at"] = self.installed_at.isoformat()
        manifest_path.write_text(json.dumps(data, indent=2, sort_keys=True))


@extensions_cli.command(
    "install",
    examples=[
        "hf extensions install hf-claude",
        "hf extensions install hanouticelina/hf-claude",
        "hf extensions install alvarobartt/hf-mem",
    ],
)
def extension_install(
    ctx: click.Context,
    repo_id: Annotated[
        str,
        Argument(help="GitHub extension repository in `[OWNER/]hf-<name>` format."),
    ],
    force: Annotated[bool, Option("--force", help="Overwrite if already installed.")] = False,
) -> None:
    """Install an extension from a public GitHub repository.

    Security warning: this installs a third-party executable or Python package.
    Install only from sources you trust.
    """
    owner, repo_name, short_name = _normalize_repo_id(repo_id)
    root_ctx = ctx.find_root()
    reserved_commands = set(getattr(root_ctx.command, "commands", {}).keys())
    if short_name in reserved_commands:
        raise CLIError(
            f"Cannot install extension '{short_name}' because it conflicts with an existing `hf {short_name}` command."
        )

    extension_dir = _get_extension_dir(short_name)
    if extension_dir.exists() and not force:
        raise CLIError(f"Extension '{short_name}' is already installed. Use --force to overwrite.")

    branch, description = _fetch_github_repo_info(owner=owner, repo_name=repo_name)
    if extension_dir.exists():
        # --force reinstall: only remove the previous install once the repo metadata is resolved.
        shutil.rmtree(extension_dir)
    manifest = _install_extension(
        owner=owner, repo_name=repo_name, short_name=short_name, branch=branch, description=description
    )
    ext_type = manifest.type.capitalize()
    out.result(
        f"{ext_type} extension installed",
        source=f"{owner}/{repo_name}",
        command=f"hf {short_name}",
    )
    out.hint(f"Run it with: hf {short_name}")


@extensions_cli.command(
    "update",
    examples=[
        "hf extensions update",
        "hf extensions update hf-claude",
        "hf extensions update alvarobartt/hf-mem",
    ],
)
def extension_update(
    name: Annotated[
        str | None,
        Argument(
            help=(
                "Extension to update (with or without `hf-` prefix, optionally as `OWNER/hf-<name>`). "
                "If omitted, all installed extensions are checked and the outdated ones are updated."
            ),
        ),
    ] = None,
) -> None:
    """Update installed extension(s) to their latest version."""
    if name is not None:
        manifest = _load_installed_extension_for_update(name)
        update_status = _update_installed_extension(manifest)
        match update_status:
            case _ExtensionUpdateStatus.UPDATED:
                out.result("Extension updated", name=manifest.short_name, source=manifest.repo_id)
            case _ExtensionUpdateStatus.UP_TO_DATE:
                out.result(f"Extension '{manifest.short_name}' is already up to date", name=manifest.short_name)
            case _ExtensionUpdateStatus.SKIPPED:
                pass  # warning already emitted by _update_installed_extension
        return

    manifests = _list_installed_extensions()
    if not manifests:
        out.warning("No extensions installed.")
        out.hint("Install one with: hf extensions install <repo_id>")
        return

    updated = []
    up_to_date = []
    for manifest in manifests:
        out.log(f"Checking '{manifest.short_name}' ({manifest.repo_id})...")
        try:
            update_status = _update_installed_extension(manifest)
        except Exception as error:
            # Keep updating the other extensions even if one fails.
            out.warning(f"Could not update '{manifest.short_name}' ({manifest.repo_id}): {error}. Skipping.")
            continue
        match update_status:
            case _ExtensionUpdateStatus.UPDATED:
                updated.append(manifest.short_name)
            case _ExtensionUpdateStatus.UP_TO_DATE:
                up_to_date.append(manifest.short_name)
            case _ExtensionUpdateStatus.SKIPPED:
                pass  # warning already emitted by _update_installed_extension
    out.result(
        "Extensions update complete",
        updated=", ".join(updated) if updated else None,
        up_to_date=", ".join(up_to_date) if up_to_date else None,
    )


@extensions_cli.command(
    "exec",
    context_settings={"allow_extra_args": True, "allow_interspersed_args": False, "ignore_unknown_options": True},
    examples=[
        "hf extensions exec claude -- --help",
        "hf extensions exec claude --model zai-org/GLM-5",
    ],
)
def extension_exec(
    ctx: click.Context,
    name: Annotated[
        str,
        Argument(help="Extension name (with or without `hf-` prefix)."),
    ],
) -> None:
    """Execute an installed extension."""
    short_name = _normalize_extension_name(name)
    executable_path = _resolve_installed_executable_path(short_name)

    if not executable_path.is_file():
        raise CLIError(f"Extension '{short_name}' is not installed.")

    exit_code = _execute_extension_binary(executable_path=executable_path, args=list(ctx.args))
    raise click.exceptions.Exit(code=exit_code)


@extensions_cli.command("list | ls", examples=["hf extensions list"])
def extension_list() -> None:
    """List installed extension commands."""
    rows = [
        {
            "command": f"hf {manifest.short_name}",
            "source": str(manifest.repo_id),
            "type": str(manifest.type),
            "installed": manifest.installed_at.strftime("%Y-%m-%d"),
            "description": manifest.description,
        }
        for manifest in _list_installed_extensions()
    ]
    out.table(rows, id_key="command")


@extensions_cli.command("search", examples=["hf extensions search"])
def extension_search() -> None:
    """Search extensions available on GitHub (tagged with 'hf-extension' topic)."""
    response = _github_get(
        "https://api.github.com/search/repositories",
        params={"q": f"topic:{_EXTENSIONS_GITHUB_TOPIC}", "sort": "stars", "order": "desc", "per_page": 100},
    )
    data = response.json()

    installed = {m.short_name for m in _list_installed_extensions()}

    rows = []
    for repo in data.get("items", []):
        short_name = repo["name"].removeprefix("hf-")
        rows.append(
            {
                "name": short_name,
                "repo": repo["full_name"],
                "stars": repo.get("stargazers_count", 0),
                "description": repo.get("description") or "",
                "installed": "yes" if short_name in installed else "",
            }
        )

    out.table(rows, id_key="repo")


@extensions_cli.command("remove | rm", examples=["hf extensions remove claude"])
def extension_remove(
    name: Annotated[
        str,
        Argument(help="Extension name to remove (with or without `hf-` prefix)."),
    ],
) -> None:
    """Remove an installed extension."""
    short_name = _normalize_extension_name(name)
    extension_dir = _get_extension_dir(short_name)

    if not extension_dir.is_dir():
        raise CLIError(f"Extension '{short_name}' is not installed.")

    shutil.rmtree(extension_dir)
    out.result("Extension removed", name=short_name)


### HELPER FUNCTIONS


def _list_installed_extensions() -> list[ExtensionManifest]:
    """Return manifests for all validly-installed extensions, sorted by directory name."""
    root_dir = EXTENSIONS_ROOT.expanduser()
    if not root_dir.is_dir():
        return []
    manifests = []
    for extension_dir in sorted(root_dir.iterdir()):
        if not extension_dir.is_dir() or not extension_dir.name.startswith("hf-"):
            continue
        try:
            manifests.append(ExtensionManifest.load(extension_dir))
        except Exception as e:
            logger.debug(f"Failed to load manifest for extension '{extension_dir.name}': {e}")
            continue
    return manifests


def list_installed_extensions_for_help() -> list[tuple[str, str]]:
    entries = []
    for manifest in _list_installed_extensions():
        tag = f"[extension {manifest.repo_id}]"
        help_text = f"{manifest.description} {tag}" if manifest.description is not None else tag
        entries.append((manifest.short_name, help_text))
    return entries


def dispatch_unknown_top_level_extension(args: list[str], known_commands: set[str]) -> int | None:
    if not args:
        return None

    command_name = args[0]
    if command_name.startswith("-"):
        return None
    all_known = {a.strip() for cmd in known_commands for a in cmd.split("|")}
    if command_name in all_known:
        return None

    try:
        short_name = _validate_extension_short_name(command_name.removeprefix("hf-"), original_input=command_name)
    except CLIError:
        return None

    executable_path: Path | None
    try:
        executable_path = _resolve_installed_executable_path(short_name)
    except Exception:
        executable_path = _auto_install_official_extension(short_name)

    if executable_path is None or not executable_path.is_file():
        return None

    return _execute_extension_binary(executable_path=executable_path, args=list(args[1:]))


def _auto_install_official_extension(short_name: str) -> Path | None:
    """Try to auto-install huggingface/hf-<name>. Returns executable path or None."""
    owner, repo_name = DEFAULT_EXTENSION_OWNER, f"hf-{short_name}"
    if _get_extension_dir(short_name).exists():
        return None

    try:
        branch, description = _fetch_github_repo_info(owner=owner, repo_name=repo_name)
    except Exception:
        return None

    try:
        out.confirm(f"'{short_name}' is an official Hugging Face extension ({owner}/{repo_name}). Install it?")
    except ConfirmationError:
        return None
    try:
        manifest = _install_extension(
            owner=owner, repo_name=repo_name, short_name=short_name, branch=branch, description=description
        )
        return Path(manifest.executable_path).expanduser()
    except Exception:
        return None


def _load_installed_extension_for_update(name: str) -> ExtensionManifest:
    short_name = _normalize_extension_name(name)
    extension_dir = _get_extension_dir(short_name)
    if not extension_dir.is_dir():
        owner, _, _ = name.strip().rpartition("/")
        install_target = f"{owner}/hf-{short_name}" if owner else f"hf-{short_name}"
        raise CLIError(
            f"Extension '{short_name}' is not installed. Install it first with: hf extensions install {install_target}"
        )
    return ExtensionManifest.load(extension_dir)


def _update_installed_extension(manifest: ExtensionManifest) -> _ExtensionUpdateStatus:
    owner, repo_name, short_name = manifest.owner, manifest.repo, manifest.short_name

    try:
        branch, description = _fetch_github_repo_info(owner=owner, repo_name=repo_name)
    except Exception as error:
        out.warning(f"Could not check updates for '{short_name}' ({owner}/{repo_name}): {error}. Skipping.")
        return _ExtensionUpdateStatus.SKIPPED

    latest_sha = _fetch_latest_commit_sha(owner=owner, repo_name=repo_name, branch=branch, warn=False)
    if latest_sha is None:
        out.warning(
            f"Could not check updates for '{short_name}' ({owner}/{repo_name}): GitHub is unreachable. Skipping."
        )
        return _ExtensionUpdateStatus.SKIPPED

    if latest_sha == manifest.commit_sha:
        return _ExtensionUpdateStatus.UP_TO_DATE

    _install_extension(
        owner=owner,
        repo_name=repo_name,
        short_name=short_name,
        branch=branch,
        description=description,
        commit_sha=latest_sha,
    )
    return _ExtensionUpdateStatus.UPDATED


def _install_extension(
    *,
    owner: str,
    repo_name: str,
    short_name: str,
    branch: str,
    description: str | None = None,
    commit_sha: str | None = None,
) -> ExtensionManifest:
    """Fetch and install an extension (binary or Python package), then persist its manifest.

    Installs in place: an existing install is overwritten without being removed first, so a failed
    update keeps the previous version working. A failed fresh install is cleaned up entirely.
    """
    extension_dir = _get_extension_dir(short_name)
    fresh_install = not extension_dir.exists()
    installed = False
    try:
        try:
            binary = _fetch_remote_binary(owner=owner, repo_name=repo_name, branch=branch, short_name=short_name)
        except Exception:
            binary = None

        if binary is not None:
            executable_path = _install_binary_extension(
                extension_dir=extension_dir, short_name=short_name, binary=binary
            )
        else:
            executable_path = _install_python_extension(
                extension_dir=extension_dir, owner=owner, repo_name=repo_name, short_name=short_name, branch=branch
            )

        manifest = ExtensionManifest(
            owner=owner,
            repo=repo_name,
            repo_id=f"{owner}/{repo_name}",
            short_name=short_name,
            executable_path=str(executable_path),
            type="binary" if binary is not None else "python",
            installed_at=datetime.now(timezone.utc),
            description=_try_fetch_remote_description(
                owner=owner, repo_name=repo_name, branch=branch, candidate_description=description
            ),
            commit_sha=commit_sha or _fetch_latest_commit_sha(owner=owner, repo_name=repo_name, branch=branch),
        )
        manifest.save(extension_dir)
        installed = True
        return manifest
    except CLIError:
        raise
    except subprocess.TimeoutExpired as e:
        raise CLIExtensionInstallError(
            f"Pip install timed out after {_EXTENSIONS_PIP_INSTALL_TIMEOUT}s for '{owner}/{repo_name}'. "
            "See pip output above for details."
        ) from e
    except subprocess.CalledProcessError as e:
        raise CLIExtensionInstallError(
            f"Failed to install pip package from '{owner}/{repo_name}' (exit code {e.returncode}). "
            "See pip output above for details."
        ) from e
    except Exception as e:
        raise CLIExtensionInstallError(f"Failed to install extension from '{owner}/{repo_name}': {e}") from e
    finally:
        if not installed and fresh_install:
            shutil.rmtree(extension_dir, ignore_errors=True)


def _fetch_latest_commit_sha(*, owner: str, repo_name: str, branch: str, warn: bool = True) -> str | None:
    """Best-effort fetch of the latest commit SHA for a branch, used to detect available updates."""
    try:
        response = _github_get(
            f"https://api.github.com/repos/{owner}/{repo_name}/commits/{branch}",
            headers={"Accept": "application/vnd.github.sha"},
        )
        return response.text.strip() or None
    except Exception as error:
        if warn:
            out.warning(f"Could not fetch latest commit SHA for '{repo_name}' ({owner}/{repo_name}): {error}")
        return None


def _fetch_remote_binary(*, owner: str, repo_name: str, branch: str, short_name: str) -> bytes:
    executable_name = _get_executable_name(short_name)
    raw_url = f"https://raw.githubusercontent.com/{owner}/{repo_name}/refs/heads/{branch}/{executable_name}"
    response = _github_get(raw_url)
    return response.content


def _install_binary_extension(*, extension_dir: Path, short_name: str, binary: bytes) -> Path:
    extension_dir.mkdir(parents=True, exist_ok=True)
    executable_path = extension_dir / _get_executable_name(short_name)
    executable_path.write_bytes(binary)

    if os.name != "nt":
        os.chmod(executable_path, 0o755)

    return executable_path


def _install_python_extension(
    *, extension_dir: Path, owner: str, repo_name: str, short_name: str, branch: str
) -> Path:
    source_url = f"https://github.com/{owner}/{repo_name}/archive/refs/heads/{branch}.zip"
    venv_dir = extension_dir / "venv"
    venv_python = _get_venv_bin_path(venv_dir, "python.exe" if os.name == "nt" else "python")
    uv_path = shutil.which("uv")

    status = out.status()
    if not venv_python.is_file():
        status.update(f"Creating virtual environment in {venv_dir}")
        extension_dir.mkdir(parents=True, exist_ok=True)
        if uv_path:
            subprocess.run([uv_path, "venv", str(venv_dir)], check=True)
        else:
            venv.EnvBuilder(with_pip=True).create(str(venv_dir))
        status.done(f"Virtual environment created in {venv_dir}")

    status.update(f"Installing package from {source_url}")
    if uv_path:
        # --reinstall: the source URL is the same for every commit, so cached data must be refreshed.
        install_cmd = [uv_path, "pip", "install", "--reinstall", "--python", str(venv_python), source_url]
    else:
        install_cmd = [
            str(venv_python),
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--force-reinstall",
            source_url,
        ]
    subprocess.run(install_cmd, check=True, timeout=_EXTENSIONS_PIP_INSTALL_TIMEOUT)
    status.done(f"Package installed from {source_url}")

    executable_name = _get_executable_name(short_name)
    venv_executable = _get_venv_bin_path(venv_dir, executable_name)
    if not venv_executable.is_file():
        raise CLIError(
            f"Installed package from '{owner}/{repo_name}' does not expose the required console script "
            f"'{executable_name}'."
        )
    return venv_executable.resolve()


def _try_fetch_remote_description(
    owner: str, repo_name: str, branch: str, candidate_description: str | None
) -> str | None:
    """Try to fetch project description either from:
    - manifest.json
    - pyproject.toml

    Only best effort, no error handling.
    """
    base = f"https://raw.githubusercontent.com/{owner}/{repo_name}/refs/heads/{branch}"

    # from manifest.json
    try:
        response = _github_get(f"{base}/{MANIFEST_FILENAME}")
        description = response.json().get("description")
        if isinstance(description, str):
            return description
    except Exception:
        pass

    # from pyproject.toml
    try:
        response = _github_get(f"{base}/pyproject.toml")

        # Weak parser but ok for "best effort"
        for line in response.text.splitlines():
            line = line.strip()
            if line.startswith("description"):
                _, _, value = line.partition("=")
                return value.strip().strip("\"'")
    except Exception:
        pass

    # fallback to value fetched from GH API directly
    return candidate_description


def _get_extension_dir(short_name: str) -> Path:
    # Callers validate at the parse boundary already; re-validate here as defense-in-depth since
    # this path is rmtree'd on removal.
    _validate_extension_short_name(short_name, original_input=short_name)
    return EXTENSIONS_ROOT.expanduser() / f"hf-{short_name}"


def _github_get(url: str, *, params: dict | None = None, headers: dict | None = None):
    """Perform a GitHub GET request.

    Shared by every GitHub/Raw fetch in this module so the timeout and redirect policy are shared.
    """
    response = get_session().get(
        url,
        params=params,
        headers=headers,
        follow_redirects=True,
        timeout=_EXTENSIONS_DOWNLOAD_TIMEOUT,
    )
    response.raise_for_status()
    return response


def _fetch_github_repo_info(*, owner: str, repo_name: str) -> tuple[str, str | None]:
    """Fetch `default_branch` + `description` for a GitHub repo from `GET /repos/{owner}/{repo}`."""
    response = _github_get(f"https://api.github.com/repos/{owner}/{repo_name}")
    data = response.json()
    return data["default_branch"], data.get("description")


def _get_executable_name(short_name: str) -> str:
    name = f"hf-{short_name}"
    if os.name == "nt":
        name += ".exe"
    return name


def _resolve_installed_executable_path(short_name: str) -> Path:
    extension_dir = _get_extension_dir(short_name)
    manifest = ExtensionManifest.load(extension_dir)
    return Path(manifest.executable_path).expanduser()


def _get_venv_bin_path(venv_dir: Path, executable_name: str) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / executable_name
    return venv_dir / "bin" / executable_name


_ALLOWED_EXTENSION_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def _validate_extension_short_name(short_name: str, *, original_input: str) -> str:
    name = short_name.strip()
    if not name:
        raise CLIError("Extension name cannot be empty.")
    if any(sep in name for sep in ("/", "\\")):
        raise CLIError(f"Invalid extension name '{original_input}'.")
    if ".." in name or ":" in name:
        raise CLIError(f"Invalid extension name '{original_input}'.")
    if not _ALLOWED_EXTENSION_NAME.fullmatch(name):
        raise CLIError(
            f"Invalid extension name '{original_input}'. Allowed characters: letters, digits, '.', '_' and '-'."
        )
    return name


def _normalize_repo_id(repo_id: str) -> tuple[str, str, str]:
    if "://" in repo_id:
        raise CLIError("Only GitHub repositories in `[OWNER/]hf-<name>` format are supported.")

    parts = repo_id.split("/")
    if len(parts) == 1:
        owner = DEFAULT_EXTENSION_OWNER
        repo_name = parts[0]
    elif len(parts) == 2 and all(parts):
        owner, repo_name = parts
    else:
        raise CLIError(f"Expected `[OWNER/]REPO` format, got '{repo_id}'.")

    if not repo_name.startswith("hf-"):
        raise CLIError(f"Extension repository name must start with 'hf-', got '{repo_name}'.")

    short_name = repo_name.removeprefix("hf-")
    if not short_name:
        raise CLIError("Invalid extension repository name 'hf-'.")
    _validate_extension_short_name(short_name, original_input=repo_id)

    return owner, repo_name, short_name


def _normalize_extension_name(name: str) -> str:
    repo_name = name.strip().rsplit("/", 1)[-1]
    return _validate_extension_short_name(repo_name.removeprefix("hf-"), original_input=name)


def _execute_extension_binary(executable_path: Path, args: list[str]) -> int:
    try:
        return subprocess.call([str(executable_path)] + args)
    except OSError as e:
        if os.name == "nt" or e.errno != errno.ENOEXEC:
            raise
        return subprocess.call(["sh", str(executable_path)] + args)
