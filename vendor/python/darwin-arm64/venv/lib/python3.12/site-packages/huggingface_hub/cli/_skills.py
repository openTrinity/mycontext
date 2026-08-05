"""Internal helpers for Hugging Face marketplace skill installation and upgrades."""

import json
import re
import shutil
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from huggingface_hub._buckets import BucketFile
from huggingface_hub.errors import CLIError

from ..utils import disable_progress_bars
from ._cli_utils import get_hf_api


DEFAULT_SKILL_ID = "hf-cli"
DEFAULT_SKILLS_BUCKET_ID = "huggingface/skills"
MARKETPLACE_PATH = "marketplace.json"
# Empty marker file dropped into managed skill installs so `hf skills update` knows
# to touch them and leave user-placed skill dirs alone. Filename is historical (used
# to be a JSON manifest with a revision); we keep it for backward compat with installs
# made by previous versions.
MANAGED_MARKER_FILENAME = ".hf-skill-manifest.json"

SkillUpdateStatus = Literal["up_to_date", "unmanaged", "source_unreachable"]


@dataclass(frozen=True)
class MarketplaceSkill:
    name: str
    repo_path: str
    description: str | None = None


@dataclass(frozen=True)
class SkillUpdateInfo:
    name: str
    skill_dir: Path
    status: SkillUpdateStatus
    detail: str | None = None


def add_skill(skill_name: str, destination_root: Path, force: bool = False) -> Path:
    """Resolve a marketplace skill by name and install it."""
    api = get_hf_api()
    with disable_progress_bars():
        marketplace_skills = _load_marketplace_skills(api)
        skill = _select_marketplace_skill(marketplace_skills, skill_name)
        if skill is None:
            raise CLIError(
                f"Skill '{skill_name}' not found in {DEFAULT_SKILLS_BUCKET_ID}. "
                "Try `hf skills add` to install `hf-cli` or use a known skill name."
            )
        return _install_marketplace_skill(api, skill, destination_root, force=force)


def install_generated_skill(content: str, destination_root: Path, force: bool = False) -> Path:
    """Install the `hf-cli` skill from locally generated SKILL.md content (no bucket download)."""

    def populate(install_dir: Path) -> None:
        install_dir.mkdir(parents=True, exist_ok=True)
        (install_dir / "SKILL.md").write_text(content, encoding="utf-8")
        (install_dir / MANAGED_MARKER_FILENAME).touch()

    return _install_skill(DEFAULT_SKILL_ID, destination_root, populate=populate, force=force)


def update_skills(roots: list[Path], selector: str | None = None, *, hf_cli_content: str) -> list[SkillUpdateInfo]:
    """Re-sync managed skill installs (`hf-cli` is rewritten from `hf_cli_content`, the rest from the bucket)."""
    skill_dirs = _iter_unique_skill_dirs(roots)
    if selector is not None:
        selector_lower = selector.strip().lower()
        skill_dirs = [d for d in skill_dirs if d.name.lower() == selector_lower]
        if not skill_dirs:
            raise CLIError(f"No installed skill matches '{selector}'. Install it with `hf skills add {selector}`.")

    # `hf-cli` is regenerated locally, so only hit the marketplace when another managed skill needs it.
    needs_marketplace = any(d.name != DEFAULT_SKILL_ID and (d / MANAGED_MARKER_FILENAME).exists() for d in skill_dirs)
    api = None
    marketplace_skills: dict[str, MarketplaceSkill] = {}
    if needs_marketplace:
        api = get_hf_api()
        with disable_progress_bars():
            marketplace_skills = {skill.name.lower(): skill for skill in _load_marketplace_skills(api)}

    return [_apply_single_update(api, skill_dir, marketplace_skills, hf_cli_content) for skill_dir in skill_dirs]


def _load_marketplace_skills(api) -> list[MarketplaceSkill]:
    payload = _load_marketplace_payload(api)
    plugins = payload.get("plugins")
    if not isinstance(plugins, list):
        raise CLIError("Invalid marketplace payload: expected a top-level 'plugins' list.")

    skills: list[MarketplaceSkill] = []
    for plugin in plugins:
        if not isinstance(plugin, dict):
            continue
        name = plugin.get("name")
        source = plugin.get("source")
        if not isinstance(name, str) or not isinstance(source, str):
            continue
        description = plugin.get("description")
        skills.append(
            MarketplaceSkill(
                name=name,
                repo_path=_normalize_repo_path(source),
                description=description if isinstance(description, str) else None,
            )
        )
    return skills


def _install_marketplace_skill(api, skill: MarketplaceSkill, destination_root: Path, force: bool = False) -> Path:
    """Install a marketplace skill into a local skills directory."""

    def populate(install_dir: Path) -> None:
        install_dir.mkdir(parents=True, exist_ok=True)
        bucket_files = _list_skill_files(api, skill)
        _download_skill_files(api, skill, bucket_files, install_dir)
        _validate_installed_skill_dir(install_dir)
        (install_dir / MANAGED_MARKER_FILENAME).touch()

    return _install_skill(skill.name, destination_root, populate=populate, force=force)


_VALID_SKILL_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def _install_skill(
    name: str,
    destination_root: Path,
    populate: Callable[[Path], None],
    force: bool = False,
) -> Path:
    """Install a skill into ``destination_root`` by calling ``populate(install_dir)`` to fill it.

    Used by both the marketplace install (populate = download from bucket) and the
    locally-generated install (populate = write content). When the install already
    exists and ``force`` is set, the new content is staged in a sibling tempdir and
    atomically swapped in, so the existing install stays intact if ``populate``
    fails halfway through.
    """
    # `name` may come from the remote marketplace payload and the install dir is removed on
    # reinstall: validate it as defense-in-depth against path traversal.
    if not _VALID_SKILL_NAME.fullmatch(name):
        raise CLIError(f"Invalid skill name '{name}'.")
    destination_root = destination_root.expanduser().resolve()
    destination_root.mkdir(parents=True, exist_ok=True)
    install_dir = destination_root / name
    already_exists = install_dir.exists()

    if already_exists and not force:
        raise FileExistsError(f"Skill already exists: {install_dir}")

    if already_exists:
        with tempfile.TemporaryDirectory(dir=destination_root, prefix=f".{install_dir.name}.install-") as tmp_dir_str:
            staged_dir = Path(tmp_dir_str) / install_dir.name
            populate(staged_dir)
            _atomic_replace_directory(existing_dir=install_dir, staged_dir=staged_dir)
        return install_dir

    try:
        populate(install_dir)
    except Exception:
        if install_dir.exists():
            shutil.rmtree(install_dir)
        raise
    return install_dir


def _load_marketplace_payload(api) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp_dir:
        local_path = Path(tmp_dir) / "marketplace.json"
        api.download_bucket_files(
            DEFAULT_SKILLS_BUCKET_ID,
            [(MARKETPLACE_PATH, local_path)],
            raise_on_missing_files=True,
        )
        parsed = json.loads(local_path.read_text(encoding="utf-8"))

    if not isinstance(parsed, dict):
        raise CLIError("Invalid marketplace payload: expected a JSON object.")
    return parsed


def _select_marketplace_skill(skills: list[MarketplaceSkill], selector: str) -> MarketplaceSkill | None:
    selector_lower = selector.strip().lower()
    for skill in skills:
        if skill.name.lower() == selector_lower:
            return skill
    return None


def _normalize_repo_path(path: str) -> str:
    normalized = path.strip()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    normalized = normalized.strip("/")
    if not normalized:
        raise CLIError("Invalid marketplace entry: empty source path.")
    return normalized


def _validate_installed_skill_dir(skill_dir: Path) -> None:
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.is_file():
        raise RuntimeError(f"Installed skill is missing SKILL.md: {skill_file}")


def _list_skill_files(api, skill: MarketplaceSkill) -> list[BucketFile]:
    """List all files under `skill.repo_path` in the marketplace bucket."""
    prefix = skill.repo_path.rstrip("/")
    files: list[BucketFile] = [
        item
        for item in api.list_bucket_tree(DEFAULT_SKILLS_BUCKET_ID, prefix=prefix, recursive=True)
        if isinstance(item, BucketFile)
    ]
    if not files:
        raise FileNotFoundError(f"Path '{prefix}' not found in bucket '{DEFAULT_SKILLS_BUCKET_ID}'.")
    return files


def _download_skill_files(api, skill: MarketplaceSkill, files: list[BucketFile], install_dir: Path) -> None:
    """Download bucket files into `install_dir`."""
    prefix = skill.repo_path.rstrip("/")
    prefix_with_slash = f"{prefix}/"

    # `list_bucket_tree(prefix=...)` matches as a raw string prefix, so e.g. asking for
    # "skills/gradio" can also return "skills/gradio-tools/...". Filter on the trailing
    # slash to keep only files actually inside the directory, then strip it so files land
    # directly under `install_dir` preserving any nested structure.
    download_specs: list[tuple[str | BucketFile, str | Path]] = []
    for bucket_file in files:
        if not bucket_file.path.startswith(prefix_with_slash):
            continue
        relative = bucket_file.path[len(prefix_with_slash) :]
        local_file = install_dir.joinpath(*PurePosixPath(relative).parts)
        local_file.parent.mkdir(parents=True, exist_ok=True)
        download_specs.append((bucket_file, local_file))

    if not download_specs:
        raise FileNotFoundError(f"No files found under '{prefix}' in bucket '{DEFAULT_SKILLS_BUCKET_ID}'.")

    api.download_bucket_files(DEFAULT_SKILLS_BUCKET_ID, download_specs)


def _atomic_replace_directory(existing_dir: Path, staged_dir: Path) -> None:
    backup_dir = staged_dir.parent / f"{existing_dir.name}.backup"
    try:
        existing_dir.rename(backup_dir)
        staged_dir.rename(existing_dir)
        shutil.rmtree(backup_dir)
    except Exception:
        if backup_dir.exists() and not existing_dir.exists():
            backup_dir.rename(existing_dir)
        raise


def _iter_unique_skill_dirs(roots: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    discovered: list[Path] = []
    for root in roots:
        root = root.expanduser().resolve()
        if not root.is_dir():
            continue
        for child in sorted(root.iterdir()):
            if child.name.startswith("."):
                continue
            if not child.is_dir() and not child.is_symlink():
                continue
            resolved = child.resolve()
            if resolved in seen or not resolved.is_dir():
                continue
            seen.add(resolved)
            discovered.append(resolved)
    return discovered


def _apply_single_update(
    api, skill_dir: Path, marketplace_skills: dict[str, MarketplaceSkill], hf_cli_content: str
) -> SkillUpdateInfo:
    base = SkillUpdateInfo(name=skill_dir.name, skill_dir=skill_dir, status="unmanaged")

    if not (skill_dir / MANAGED_MARKER_FILENAME).exists():
        return base

    if skill_dir.name == DEFAULT_SKILL_ID:
        try:
            install_generated_skill(hf_cli_content, skill_dir.parent, force=True)
        except Exception as exc:
            return replace(base, status="source_unreachable", detail=str(exc))
        return replace(base, status="up_to_date")

    skill = marketplace_skills.get(skill_dir.name.lower())
    if skill is None:
        return replace(
            base,
            status="source_unreachable",
            detail=f"Skill '{skill_dir.name}' is no longer available in {DEFAULT_SKILLS_BUCKET_ID}.",
        )

    try:
        _install_marketplace_skill(api, skill, skill_dir.parent, force=True)
    except Exception as exc:
        return replace(base, status="source_unreachable", detail=str(exc))

    return replace(base, status="up_to_date")
