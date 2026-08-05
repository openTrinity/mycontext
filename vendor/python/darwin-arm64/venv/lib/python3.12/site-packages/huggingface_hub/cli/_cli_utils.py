# Copyright 2022 The HuggingFace Team. All rights reserved.
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
"""Contains CLI utilities (styling, helpers)."""

import difflib
import importlib.metadata
import os
import re
import shlex
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Any, Literal, TypeVar, cast

import click

from huggingface_hub import Volume, __version__, constants
from huggingface_hub.errors import CLIError
from huggingface_hub.utils import (
    get_session,
    hf_raise_for_status,
    installation_method,
    logging,
    parse_hf_mount,
)
from huggingface_hub.utils._dotenv import load_dotenv

from ._framework import Argument, HfCommand, HfGroup, Option
from ._help_formatter import StyledContext
from ._output import OutputFormat, out


logger = logging.get_logger()

# Arbitrary default limit for models/datasets/spaces list commands.
REPO_LIST_DEFAULT_LIMIT = 30

if TYPE_CHECKING:
    from huggingface_hub.hf_api import HfApi


def get_hf_api(token: str | None = None) -> "HfApi":
    # Import here to avoid circular import
    from huggingface_hub.hf_api import HfApi

    return HfApi(token=token, library_name="huggingface-cli", library_version=__version__)


#### TYPER UTILS

CLI_REFERENCE_URL = "https://huggingface.co/docs/huggingface_hub/en/guides/cli"


def generate_epilog(examples: list[str], docs_anchor: str | None = None) -> str:
    """Generate an epilog with examples and a Learn More section.

    Args:
        examples: List of example commands (without the `$ ` prefix).
        docs_anchor: Optional anchor for the docs URL (e.g., "#hf-download").

    Returns:
        Formatted epilog string.
    """
    docs_url = f"{CLI_REFERENCE_URL}{docs_anchor}" if docs_anchor else CLI_REFERENCE_URL
    examples_str = "\n".join(f"  $ {ex}" for ex in examples)
    return f"""\
Examples
{examples_str}

Learn more
  Use `hf <command> --help` for more information about a command.
  Read the documentation at {docs_url}
"""


TOPIC_T = Literal["main", "help"] | str
FallbackHandlerT = Callable[[list[str], set[str]], int | None]
ExpandPropertyT = TypeVar("ExpandPropertyT", bound=str)


def _format_epilog_no_indent(epilog: str | None, ctx: click.Context, formatter: click.HelpFormatter) -> None:
    """Write the epilog without indentation."""
    if epilog:
        formatter.write_paragraph()
        for line in epilog.split("\n"):
            formatter.write_text(line)


_ALIAS_SPLIT = re.compile(r"\s*\|\s*")


class HFCliTyperGroup(HfGroup):
    """
    CLI Group that:
    - lists commands alphabetically within sections.
    - separates commands by topic (main, help, etc.).
    - formats epilog without extra indentation.
    - supports aliases via pipe-separated names (e.g. ``name="list | ls"``).
    - consumes the global formatting flags (``--format``, ``--json``, ``-q`` / ``--quiet``, ``--no-truncate``)
      anywhere in the args of a leaf command and applies them to ``out``, so leaf
      commands don't need to declare these options themselves.
    - rewrites ``spaces/user/repo`` to ``user/repo --type space`` for commands that accept ``--type``.
    - enriches "No such option" / "No such command" errors with available options or commands.
    """

    context_class = StyledContext

    def invoke(self, ctx: click.Context) -> None:
        """Enrich unknown-option errors with available options or subcommands.

        Catches `NoSuchOption` raised during subcommand `make_context()`
        (option parsing).  For leaf commands (e.g. `hf repos create --test`)
        we list the command's options; for groups (e.g. `hf cache --test`)
        we list subcommands since groups have no user-facing options.
        """
        try:
            return super().invoke(ctx)
        except click.NoSuchOption as e:
            if e.ctx is not None and e.ctx.command is not None:
                cmd = e.ctx.command
                if isinstance(cmd, click.Group):
                    # Group has no user-facing options -> show subcommands instead
                    items = [
                        (name, sub.get_short_help_str(limit=80))
                        for name in cmd.list_commands(e.ctx)
                        if (sub := cmd.get_command(e.ctx, name)) is not None and not sub.hidden
                    ]
                    _enrich_usage_error(e, "commands", items)
                else:
                    # Leaf command -> show its options using Click's rich formatting
                    items = [
                        record
                        for p in cmd.get_params(e.ctx)
                        if isinstance(p, click.Option) and not p.hidden and (record := p.get_help_record(e.ctx))
                    ]
                    _enrich_usage_error(e, "options", items)
            raise

    def resolve_command(self, ctx: click.Context, args: list[str]) -> tuple:
        cmd_name = args[0] if args and not args[0].startswith("-") else None
        cmd = self.get_command(ctx, cmd_name) if cmd_name else None

        if cmd is not None:
            self._rewrite_repo_type_prefix(cmd, args)

        try:
            name, resolved_cmd, sub_args = super().resolve_command(ctx, args)
        except click.UsageError as e:
            # Unknown subcommand -> add fuzzy suggestions and list available commands.
            if cmd is None and cmd_name is not None:
                # Expand aliases ("list | ls" → ["list", "ls"]) for accurate fuzzy matching.
                visible_names = [
                    alias
                    for key, registered in self.commands.items()
                    if not registered.hidden
                    for alias in _ALIAS_SPLIT.split(key)
                ]
                matches = difflib.get_close_matches(cmd_name, visible_names)
                if matches:
                    suggestions = ", ".join(f"'{m}'" for m in matches)
                    setattr(e, "message", f"{e.message.rstrip('.')}. Did you mean {suggestions}?")
                items = [
                    (name, sub.get_short_help_str(limit=80))
                    for name in self.list_commands(ctx)
                    if (sub := self.get_command(ctx, name)) is not None and not sub.hidden
                ]
                _enrich_usage_error(e, "commands", items)
            raise

        # If we just resolved a leaf command, eagerly consume any global formatting
        # flags (--format / --json / -q / --quiet / --no-truncate) from its args before click parses
        # them.  Group resolution is recursive — leaves (and only leaves) need this.
        if resolved_cmd is not None and not isinstance(resolved_cmd, click.Group):
            _consume_format_flags_for_leaf(resolved_cmd, sub_args)

        return name, resolved_cmd, sub_args

    @staticmethod
    def _rewrite_repo_type_prefix(cmd: click.Command, args: list[str]) -> None:
        """Rewrite prefixed repo IDs (e.g. ``spaces/user/repo``) to ``user/repo --type space``.

        Only applies to commands that have a ``--type`` / ``--repo-type`` option and
        at least one repo-ID positional argument (any ``click.Argument`` whose name
        ends with ``_id``, e.g. ``repo_id``, ``from_id``, ``to_id``).  When the
        token that maps to such an argument matches ``{prefix}/org/repo`` (where
        *prefix* is one of ``spaces``, ``datasets``, or ``models``), the prefix is
        stripped and an implicit ``--type {type}`` is appended.  An error is raised
        if ``--type`` is also provided explicitly or if multiple prefixed arguments
        disagree on the repo type.

        Only repo-ID positional slots are inspected so that other positional
        arguments (filenames, local paths, patterns …) are never misinterpreted as
        prefixed repo IDs.
        """
        has_type_option = any(isinstance(param, click.Option) and "--type" in param.opts for param in cmd.params)
        if not has_type_option:
            return

        # Locate all repo-ID positional arguments and their indices among Arguments.
        repo_id_positions: set[int] = set()
        arg_idx = 0
        for param in cmd.params:
            if isinstance(param, click.Argument):
                if param.name in ("repo_id", "from_id", "to_id"):
                    repo_id_positions.add(arg_idx)
                arg_idx += 1

        if not repo_id_positions:
            return

        # Build a set of option names that consume a following value token.
        value_options: set[str] = set()
        for param in cmd.params:
            if isinstance(param, click.Option) and not param.is_flag:
                for opt in (*param.opts, *param.secondary_opts):
                    value_options.add(opt)

        # Walk through args (skipping args[0] = command name) to map positional
        # slots to their indices in `args`.
        positional_count = 0
        repo_id_arg_indices: list[int] = []
        i = 1
        while i < len(args):
            arg = args[i]
            if arg == "--":
                break  # everything after -- is positional literal; stop rewriting
            if arg.startswith("-"):
                if "=" in arg or arg not in value_options:
                    i += 1  # flag or --opt=val — single token
                else:
                    i += 2  # value-taking option — skip the value too
            else:
                if positional_count in repo_id_positions:
                    repo_id_arg_indices.append(i)
                positional_count += 1
                i += 1

        if not repo_id_arg_indices:
            return

        # Check each repo-ID arg for a type prefix and collect rewrites.
        inferred_type: str | None = None
        first_prefix: str | None = None
        rewrites: list[tuple[int, str]] = []  # (args index, new value without prefix)

        for arg_index in repo_id_arg_indices:
            parts = args[arg_index].split("/", 2)
            if len(parts) != 3 or parts[0] not in constants.REPO_TYPES_MAPPING:
                continue
            prefix = parts[0]
            mapped_type = constants.REPO_TYPES_MAPPING[prefix]
            if inferred_type is not None and mapped_type != inferred_type:
                raise click.UsageError(f"Conflicting repo type prefixes: '{first_prefix}/' and '{prefix}/'.")
            inferred_type = mapped_type
            first_prefix = prefix
            rewrites.append((arg_index, f"{parts[1]}/{parts[2]}"))

        if not rewrites:
            return

        # Error if --type / --repo-type was also provided explicitly.
        if any(
            arg == "--type" or arg.startswith("--type=") or arg == "--repo-type" or arg.startswith("--repo-type=")
            for arg in args
        ):
            raise click.UsageError(
                f"Ambiguous repo type: got prefix '{first_prefix}/' in repo ID and explicit --type. Use one or the other."
            )

        # Apply all rewrites and append --type once.
        for arg_index, new_value in rewrites:
            args[arg_index] = new_value
        args.extend(["--type", inferred_type])  # type: ignore

    def get_command(self, ctx: click.Context, cmd_name: str) -> click.Command | None:
        # Try exact match first
        cmd = super().get_command(ctx, cmd_name)
        if cmd is not None:
            return cmd
        # Fall back to alias lookup: check if cmd_name matches any alias
        # taken from https://github.com/fastapi/typer/issues/132#issuecomment-2417492805
        for registered_name, registered_cmd in self.commands.items():
            aliases = _ALIAS_SPLIT.split(registered_name)
            if cmd_name in aliases:
                return registered_cmd
        return None

    def _alias_map(self) -> dict[str, list[str]]:
        """Build a mapping from primary command name to its aliases (if any)."""
        result: dict[str, list[str]] = {}
        for registered_name in self.commands:
            parts = _ALIAS_SPLIT.split(registered_name)
            primary = parts[0]
            result[primary] = parts[1:]
        return result

    def format_commands(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        topics: dict[str, list] = {}
        alias_map = self._alias_map()

        for name in self.list_commands(ctx):
            cmd = self.get_command(ctx, name)
            if cmd is None or cmd.hidden:
                continue
            help_text = cmd.get_short_help_str(limit=formatter.width)
            aliases = alias_map.get(name, [])
            if aliases:
                help_text = f"{help_text} [alias: {', '.join(aliases)}]"
            topic = getattr(cmd, "topic", "main")
            topics.setdefault(topic, []).append((name, help_text))

        with formatter.section("Main commands"):
            formatter.write_dl(topics["main"])
        for topic in sorted(topics.keys()):
            if topic == "main":
                continue
            with formatter.section(f"{topic.capitalize()} commands"):
                formatter.write_dl(topics[topic])

    def format_epilog(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        # Collect only the first example from each command (to keep group help concise)
        # Full examples are shown in individual subcommand help (e.g. `hf buckets sync --help`)
        all_examples: list[str] = []
        for name in self.list_commands(ctx):
            cmd = self.get_command(ctx, name)
            if cmd is None or cmd.hidden:
                continue
            cmd_examples = getattr(cmd, "examples", [])
            if cmd_examples:
                all_examples.append(cmd_examples[0])

        if all_examples:
            epilog = generate_epilog(all_examples)
            _format_epilog_no_indent(epilog, ctx, formatter)
        elif self.epilog:
            _format_epilog_no_indent(self.epilog, ctx, formatter)

    def list_commands(self, ctx: click.Context) -> list[str]:  # type: ignore[name-defined]
        # For aliased commands ("list | ls"), use the primary name (first entry).
        primary_names: list[str] = []
        for name in self.commands:
            primary = _ALIAS_SPLIT.split(name)[0]
            primary_names.append(primary)
        return sorted(primary_names)

    def command(  # type: ignore  # adds topic/examples on top of HfGroup.command
        self,
        name: str | None = None,
        *,
        topic: TOPIC_T = "main",
        examples: list[str] | None = None,
        epilog: str | None = None,
        **kwargs: Any,
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        # Generate the epilog from examples when not provided explicitly, then build the
        # command with a topic/examples-aware command class.
        if epilog is None and examples:
            epilog = generate_epilog(examples)
        return super().command(name, cls=HFCliCommand(topic, examples), epilog=epilog, **kwargs)


_FORMATTING_OPTIONS_HELP_RECORDS: list[tuple[str, str]] = [
    (
        "--format [auto|human|agent|json|quiet]",
        "Output format. Defaults to 'auto' which picks 'agent' or 'human' based on the terminal.",
    ),
    ("--json", "JSON output. Equivalent to '--format json'."),
    ("-q, --quiet", "Quiet output (one ID per line). Equivalent to '--format quiet'."),
    ("--no-truncate", "Do not truncate scalar values in human tables (list/dict columns stay shortened)."),
]


def _format_formatting_options_section(formatter: click.HelpFormatter) -> None:
    with formatter.section("Formatting options"):
        formatter.write_dl(_FORMATTING_OPTIONS_HELP_RECORDS)


def _has_local_formatting_option(cmd: click.Command) -> bool:
    """Return True if the command defines its own --format, --json or --quiet / -q.

    Used to skip the global formatting flag pre-processor and the duplicated "Formatting options" help section for
    legacy commands like 'hf jobs ls' that have their own format/quiet options.
    """
    for param in cmd.params:
        if not isinstance(param, click.Option):
            continue
        opts = (*param.opts, *param.secondary_opts)
        if "--format" in opts or "--json" in opts or "--quiet" in opts or "-q" in opts:
            return True
    return False


def _consume_format_flags_for_leaf(cmd: click.Command, args: list[str]) -> None:
    """Apply global formatting flags from 'args' to a leaf command.

    Two modes, depending on the command:

    * **Pass-through commands** (ignore_unknown_options=True, e.g. 'hf extensions exec'):
      args are forwarded verbatim to an external binary; we don't touch them.

    * **Legacy commands with a local --format option** (e.g. 'hf jobs ls' whose '--format' accepts Go templates):
      the global flags are rewritten in-place to the legacy form ('--json' → '--format json', '--quiet'/'-q' → '--format quiet'
      when the cmd has no own '--quiet') so click can parse them locally. This preserves backwards compatibility with the previous shorthand behavior.

    * **Modern commands** (no local format/quiet/json options): the flags '--format <value>' / '--json' / '--quiet' / '-q' are stripped from 'args' and applied to the singleton 'out'.

    '--no-truncate' is stripped for all non-pass-through commands; when present, human table cells are not truncated.

    Raises click.UsageError if multiple conflicting flags are supplied (e.g. '--json' together with '--format table').
    """
    if cmd.context_settings.get("ignore_unknown_options"):
        return

    no_truncate = _consume_no_truncate_flags(args)
    out.set_no_truncate(no_truncate)

    has_local_format = False
    has_local_quiet = False
    has_local_json = False
    for param in cmd.params:
        if not isinstance(param, click.Option):
            continue
        opts = (*param.opts, *param.secondary_opts)
        if "--format" in opts:
            has_local_format = True
        if "--quiet" in opts or "-q" in opts:
            has_local_quiet = True
        if "--json" in opts:
            has_local_json = True

    if has_local_format:
        _rewrite_legacy_shorthands(args, rewrite_json=not has_local_json, rewrite_quiet=not has_local_quiet)
        return

    # Strip --format/--json/-q/--quiet from 'args' and apply to 'out'
    chosen_mode: OutputFormat = OutputFormat.auto
    chosen_flag: str | None = None

    def _check_conflict(new_flag: str) -> None:
        # Reject any second formatting flag before parsing values, so the user gets
        # a "mutually exclusive" error rather than e.g. an "invalid value" error
        # from the second flag's argument.
        if chosen_flag is not None:
            raise click.UsageError(f"'{chosen_flag}' and '{new_flag}' are mutually exclusive.")

    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            break  # everything after '--' is a positional literal
        if arg == "--format":
            _check_conflict("--format")
            if i + 1 >= len(args):
                raise click.UsageError("Option '--format' requires a value.")
            chosen_mode = _parse_format_value(args[i + 1])
            chosen_flag = "--format"
            del args[i : i + 2]  # --format value => 2 args removed
            continue
        if arg.startswith("--format="):
            _check_conflict("--format")
            chosen_mode = _parse_format_value(arg[len("--format=") :])
            chosen_flag = "--format"
            del args[i : i + 1]
            continue
        if arg == "--json":
            _check_conflict("--json")
            chosen_mode = OutputFormat.json
            chosen_flag = "--json"
            del args[i : i + 1]
            continue
        if arg in ("-q", "--quiet"):
            _check_conflict(arg)
            chosen_mode = OutputFormat.quiet
            chosen_flag = arg
            del args[i : i + 1]
            continue
        i += 1

    out.set_mode(chosen_mode)


def _consume_no_truncate_flags(args: list[str]) -> bool:
    """Strip all global --no-truncate flags from args and return whether any was provided."""
    no_truncate = False
    i = 0
    while i < len(args):
        arg = args[i]
        if arg == "--":
            break  # everything after '--' is a positional literal
        if arg == "--no-truncate":
            no_truncate = True
            del args[i : i + 1]
            continue
        if arg.startswith("--no-truncate="):
            raise click.UsageError("Option '--no-truncate' does not take a value.")
        i += 1
    return no_truncate


def _rewrite_legacy_shorthands(args: list[str], *, rewrite_json: bool, rewrite_quiet: bool) -> None:
    """Rewrite --json / -q / --quiet to --format ... for legacy commands.

    Used for commands like 'hf jobs ls' that still own their '--format' option.
    The rewrite lets users keep using the global shorthand while click parses
    '--format <value>' locally.
    """
    has_format_in_args = any(arg == "--format" or arg.startswith("--format=") for arg in args)

    if rewrite_json and "--json" in args:
        if has_format_in_args:
            raise click.UsageError("'--json' and '--format' are mutually exclusive.")
        idx = args.index("--json")
        args[idx : idx + 1] = ["--format", "json"]
        has_format_in_args = True

    if rewrite_quiet:
        flag = "-q" if "-q" in args else ("--quiet" if "--quiet" in args else None)
        if flag is not None:
            if has_format_in_args:
                raise click.UsageError(f"'{flag}' and '--format' are mutually exclusive.")
            idx = args.index(flag)
            args[idx : idx + 1] = ["--format", "quiet"]


def _parse_format_value(value: str) -> "OutputFormat":
    try:
        return OutputFormat(value)
    except ValueError:
        valid = ", ".join(m.value for m in OutputFormat)
        raise click.UsageError(f"Invalid value for '--format': '{value}'. Valid values: {valid}.") from None


def _enrich_usage_error(error: click.UsageError, label: str, items: list[tuple[str, str]]) -> None:
    """Append a list of available options or commands to a usage error message."""
    if not items or error.ctx is None or f"Available {label} for" in error.message:
        return
    cmd_path = error.ctx.command_path
    lines = [f"\n\nAvailable {label} for '{cmd_path}':"]
    for name, help_text in items:
        lines.append(f"  {name:30s} {help_text}")
    lines.append(f"\nRun '{cmd_path} --help' for full details.")
    if isinstance(error, click.NoSuchOption) and error.possibilities:
        lines.append(f"\nDid you mean: {', '.join(sorted(error.possibilities))}?")
        setattr(error, "possibilities", [])
    setattr(error, "message", error.message + "\n".join(lines))


def fallback_typer_group_factory(
    fallback_handler: FallbackHandlerT,
    extra_commands_provider: Callable[[], list[tuple[str, str]]] | None = None,
) -> type[HFCliTyperGroup]:
    """Return a Typer group class that runs a fallback handler before command resolution."""

    class FallbackTyperGroup(HFCliTyperGroup):
        def resolve_command(self, ctx: click.Context, args: list[str]) -> tuple:
            fallback_exit_code = fallback_handler(args, set(self.commands.keys()))
            if fallback_exit_code is not None:
                raise SystemExit(fallback_exit_code)
            return super().resolve_command(ctx, args)

        def format_commands(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
            super().format_commands(ctx, formatter)
            if extra_commands_provider is not None:
                entries = extra_commands_provider()
                if entries:
                    with formatter.section("Extension commands"):
                        formatter.write_dl(entries)

    return FallbackTyperGroup


def HFCliCommand(topic: TOPIC_T, examples: list[str] | None = None) -> type[HfCommand]:
    def format_epilog(self: click.Command, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        _format_epilog_no_indent(self.epilog, ctx, formatter)

    def format_options(self: HfCommand, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        HfCommand.format_options(self, ctx, formatter)
        # Skip the section for commands that define their own --format / --quiet / --json,
        # or for pass-through commands that forward args to an external binary.
        if _has_local_formatting_option(self):
            return
        if self.context_settings.get("ignore_unknown_options"):
            return
        _format_formatting_options_section(formatter)

    def parse_args(self: click.Command, ctx: click.Context, args: list[str]) -> list[str]:
        # Show help when a command with required arguments is invoked without any args
        # (mirrors group behavior: `hf jobs` prints help, so `hf download` should too).
        if not args and not ctx.resilient_parsing:
            if any(isinstance(p, click.Argument) and p.required for p in self.params):
                click.echo(ctx.get_help(), color=ctx.color)
                ctx.exit()
        return HfCommand.parse_args(self, ctx, args)

    return type(
        f"HfCommand{topic.capitalize()}",
        (HfCommand,),
        {
            "context_class": StyledContext,
            "topic": topic,
            "examples": examples or [],
            "format_epilog": format_epilog,
            "format_options": format_options,
            "parse_args": parse_args,
        },
    )


def typer_factory(help: str, epilog: str | None = None, cls: type[HFCliTyperGroup] | None = None) -> "HFCliTyperGroup":
    """Create a CLI command group with consistent settings.

    The returned group is the app: register commands with ``@group.command(...)``,
    subgroups with ``group.add_group(sub, name=...)``, and a group-level callback
    with ``@group.callback(...)``.

    Args:
        help: Help text for the group.
        epilog: Optional epilog text (use `generate_epilog` to create one).
        cls: Optional group class to use (defaults to `HFCliTyperGroup`).

    Returns:
        A configured `HFCliTyperGroup` instance.
    """
    if cls is None:
        cls = HFCliTyperGroup
    return cls(
        help=help,
        epilog=epilog,
        no_args_is_help=True,
        # Increase max content width for better readability
        context_settings={
            "max_content_width": 120,
            "help_option_names": ["-h", "--help"],
        },
    )


class SoftChoice(click.Choice):
    """A click Choice that suggests choices for autocompletion/docs but accepts any string.

    Unlike `click.Choice`, unknown values are passed through as-is instead of raising an error.
    This makes CLI options future-compatible when new server-side values are added.

    Accepts either a sequence of strings or an Enum class:
    ```python
    SoftChoice(SpaceHardware)        # from an enum
    SoftChoice(["a", "b", "c"])      # from a list
    ```
    """

    def __init__(self, choices: Sequence[str] | type[Enum]) -> None:
        values = (
            [m.value for m in choices] if isinstance(choices, type) and issubclass(choices, Enum) else list(choices)
        )
        super().__init__(values, case_sensitive=True)

    def convert(self, value: Any, param: click.Parameter | None, ctx: click.Context | None) -> str:
        try:
            return super().convert(value, param, ctx)
        except click.exceptions.BadParameter:
            return str(value)


class RepoType(str, Enum):
    model = "model"
    dataset = "dataset"
    space = "space"


RepoIdArg = Annotated[
    str,
    Argument(
        help="The ID of the repo (e.g. `username/repo-name` or `spaces/username/repo-name`).",
    ),
]


RepoTypeOpt = Annotated[
    RepoType,
    Option(
        "--type",
        "--repo-type",
        help="The type of repository (model, dataset, or space).",
    ),
]

# Same as `RepoTypeOpt` but optional (defaults to `None` rather than `model`). Used by commands that
# accept an `hf://` URI as repo id: a `None` default lets us tell apart "user did not pass --repo-type"
# from "user explicitly passed --repo-type model", which is required to detect conflicts with the URI.
RepoTypeOptionalOpt = Annotated[
    RepoType | None,
    Option(
        "--type",
        "--repo-type",
        help="The type of repository (model, dataset, or space).",
        show_default="model",
    ),
]

TokenOpt = Annotated[
    str | None,
    Option(
        help="A User Access Token generated from https://huggingface.co/settings/tokens.",
    ),
]

PrivateOpt = Annotated[
    bool | None,
    Option(
        help="Whether to create a private repo if repo doesn't exist on the Hub. Ignored if the repo already exists.",
    ),
]

RevisionOpt = Annotated[
    str | None,
    Option(
        help="Git revision id which can be a branch name, a tag, or a commit hash.",
    ),
]


LimitOpt = Annotated[
    int,
    Option(help="Limit the number of results."),
]

AuthorOpt = Annotated[
    str | None,
    Option(help="Filter by author or organization."),
]

FilterOpt = Annotated[
    list[str] | None,
    Option(help="Filter by tags (e.g. 'text-classification'). Can be used multiple times."),
]

SearchOpt = Annotated[
    str | None,
    Option(help="Search query."),
]


# --- Env / Secrets shared options and parsing helpers (used by jobs, repos, etc.) ---

EnvOpt = Annotated[
    list[str] | None,
    Option(
        "-e",
        "--env",
        help="Set environment variables. E.g. --env ENV=value",
    ),
]

SecretsOpt = Annotated[
    list[str] | None,
    Option(
        "-s",
        "--secrets",
        help=(
            "Set secret environment variables. E.g. --secrets SECRET=value"
            " or `--secrets HF_TOKEN` to pass your Hugging Face token."
        ),
    ),
]

EnvFileOpt = Annotated[
    str | None,
    Option(
        "--env-file",
        help="Read in a file of environment variables.",
    ),
]

SecretsFileOpt = Annotated[
    str | None,
    Option(
        help="Read in a file of secret environment variables.",
    ),
]


def _get_extended_environ() -> dict[str, str]:
    """Return a copy of ``os.environ`` with the user's HF token injected (if available)."""
    from huggingface_hub import get_token

    extended_environ = os.environ.copy()
    if (token := get_token()) is not None:
        extended_environ["HF_TOKEN"] = token
    return extended_environ


def parse_env_map(
    env: list[str] | None = None,
    env_file: str | None = None,
) -> dict[str, str | None]:
    """Parse ``-e``/``--env``/``-s``/``--secrets`` and ``--env-file``/``--secrets-file`` CLI args into a dict.

    Uses an extended environment that includes the user's HF token so that
    bare ``--secrets HF_TOKEN`` resolves correctly.
    """
    extended_environ = _get_extended_environ()
    env_map: dict[str, str | None] = {}
    if env_file:
        env_map.update(load_dotenv(Path(env_file).read_text(), environ=extended_environ))
    for env_value in env or []:
        env_map.update(load_dotenv(env_value, environ=extended_environ))
    return env_map


def env_map_to_key_value_list(env_map: dict[str, str | None]) -> list[dict[str, str]] | None:
    """Convert an env/secrets dict to the ``[{"key": ..., "value": ...}]`` format used by the Hub API."""
    if not env_map:
        return None
    return [{"key": k, "value": v or ""} for k, v in env_map.items()]


VolumesOpt = Annotated[
    list[str] | None,
    Option(
        "-v",
        "--volume",
        help="Mount one or more volumes. Format: hf://[TYPE/]SOURCE:/MOUNT_PATH[:ro]. "
        "TYPE is one of: models, datasets, spaces, buckets. "
        "TYPE defaults to models if omitted. "
        "models, datasets and spaces are always mounted read-only. buckets are read+write by default. "
        "E.g. -v hf://org/m:/data or -v hf://datasets/org/ds:/data or -v hf://buckets/org/b:/mnt:ro",
    ),
]


def parse_volumes(volumes: list[str] | None) -> "list[Volume] | None":
    """Parse volume specs from CLI arguments.

    Format: hf://[TYPE/]SOURCE[/PATH]:/MOUNT_PATH[:ro|:rw]
    Where TYPE is one of: models, datasets, spaces, buckets (defaults to models if omitted).
    SOURCE is the repo/bucket identifier (e.g. 'username/my-model').
    PATH is an optional subfolder inside the repo/bucket.
    MOUNT_PATH starts with '/'.
    Optional ':ro' or ':rw' suffix for read-only or read-write.

    Examples:
        hf://my-org/my-model:/data                (model, implicit type)
        hf://models/my-org/my-model:/data         (model, explicit type)
        hf://datasets/my-org/my-dataset:/data:ro
        hf://buckets/my-org/my-bucket:/mnt
        hf://spaces/my-org/my-space:/app
        hf://datasets/org/ds/train:/data          (with path inside repo)
        hf://buckets/org/b/sub/dir:/mnt           (with path inside bucket)
    """
    if not volumes:
        return None

    result: list[Volume] = []
    for raw_spec in volumes:
        mount = parse_hf_mount(raw_spec)
        result.append(
            Volume(
                type=mount.source.type,
                source=mount.source.id,
                mount_path=mount.mount_path,
                read_only=mount.read_only,
                path=mount.source.path_in_repo or None,
                revision=mount.source.revision or None,
            )
        )
    return result


def make_expand_properties_parser(valid_properties: Sequence[ExpandPropertyT]):
    """Create a callback to parse and validate comma-separated expand properties."""

    def _parse_expand_properties(value: str | None) -> list[ExpandPropertyT] | None:
        if value is None:
            return None
        properties = [p.strip() for p in value.split(",")]
        for prop in properties:
            if prop not in valid_properties:
                raise click.BadParameter(
                    f"Invalid expand property: '{prop}'. Valid values are: {', '.join(valid_properties)}"
                )
        return [cast(ExpandPropertyT, prop) for prop in properties]

    return _parse_expand_properties


### SSH


SshIdentityFileOpt = Annotated[
    Path | None,
    Option("-i", "--identity-file", help="Path to the SSH identity file (forwarded to `ssh -i`)."),
]

SshDryRunOpt = Annotated[
    bool,
    Option("--dry-run", help="Print the SSH command instead of running it."),
]


def exec_ssh(
    destination: str, *, port: int | None = None, identity_file: Path | None = None, dry_run: bool = False
) -> None:
    """Run an interactive `ssh` command to `destination` (`user@host`) and exit with its return code.

    With `dry_run`, print the command instead of running it.
    """
    cmd = ["ssh"]
    if identity_file is not None:
        cmd += ["-i", str(identity_file)]
    if port is not None:
        cmd += ["-p", str(port)]
    cmd.append(destination)
    if dry_run:
        out.text(shlex.join(cmd))
        return
    out.text(f"Running `{shlex.join(cmd)}`")
    result = subprocess.run(cmd)
    raise click.exceptions.Exit(code=result.returncode)


### PyPI VERSION CHECKER


def check_cli_update(library: Literal["huggingface_hub", "transformers"]) -> None:
    """
    Check whether a newer version of a library is available on PyPI.

    If a newer version is found, print a hint pointing at `hf update`.

    If current version is a pre-release (e.g. `1.0.0.rc1`), or a dev version (e.g. `1.0.0.dev1`), no check is performed.
    If `HF_HUB_DISABLE_UPDATE_CHECK` is set, the check is skipped entirely.

    This function is called at the entry point of the CLI. It only performs the check once every 24 hours, and any error
    during the check is caught and logged, to avoid breaking the CLI.

    Args:
        library: The library to check for updates. Currently supports "huggingface_hub" and "transformers".
    """
    try:
        _check_cli_update(library)
    except Exception:
        # We don't want the CLI to fail on version checks, no matter the reason.
        logger.debug("Error while checking for CLI update.", exc_info=True)


def _check_cli_update(library: Literal["huggingface_hub", "transformers"]) -> None:
    if constants.HF_HUB_DISABLE_UPDATE_CHECK:
        return

    current_version = importlib.metadata.version(library)

    # Skip if current version is a pre-release or dev version
    if any(tag in current_version for tag in ["rc", "dev"]):
        return

    # Skip if already checked in the last 24 hours
    if os.path.exists(constants.CHECK_FOR_UPDATE_DONE_PATH):
        mtime = os.path.getmtime(constants.CHECK_FOR_UPDATE_DONE_PATH)
        if (time.time() - mtime) < 24 * 3600:
            return

    # Touch the file to mark that we did the check now
    Path(constants.CHECK_FOR_UPDATE_DONE_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(constants.CHECK_FOR_UPDATE_DONE_PATH).touch()

    # Check latest version from the appropriate registry
    if library == "huggingface_hub" and installation_method() == "brew":
        latest_version = _fetch_latest_brew_version()
    else:
        latest_version = _fetch_latest_pypi_version(library)
    if latest_version is None or current_version == latest_version:
        return

    if library == "huggingface_hub":
        update_command = _get_huggingface_hub_update_command()
    else:
        update_command = _get_transformers_update_command()

    message = f"A new version of {library} ({latest_version}) is available! You are using version {current_version}."
    if update_command is not None:
        match library:
            case "huggingface_hub":
                message += "\nTo update, run: hf update"
            case _:
                message += f"\nTo update, run: {' '.join(update_command)}"
    out.hint(message)


def _fetch_latest_pypi_version(library: str) -> str | None:
    """Fetch the latest version of a library from PyPI. Returns None if the request fails."""
    try:
        response = get_session().get(f"https://pypi.org/pypi/{library}/json", timeout=2)
        hf_raise_for_status(response)
        return response.json()["info"]["version"]
    except Exception:
        logger.debug("Error while fetching latest version from PyPI.", exc_info=True)
        return None


def _fetch_latest_brew_version() -> str | None:
    """Fetch the latest version of the `hf` formula from the Homebrew registry. Returns None if the request fails."""
    try:
        response = get_session().get("https://formulae.brew.sh/api/formula/hf.json", timeout=2)
        hf_raise_for_status(response)
        return response.json()["versions"]["stable"]
    except Exception:
        logger.debug("Error while fetching latest version from Homebrew.", exc_info=True)
        return None


def run_update() -> int:
    """Run the install-method-appropriate update command for the `hf` CLI.

    Raises CLIError if the installation method can't be determined.
    Returns the subprocess exit code on success/failure of the update itself.
    """
    cmd = _get_huggingface_hub_update_command()
    if cmd is None:
        raise CLIError(
            "Cannot determine how to update huggingface_hub (unknown installation method). Please update manually."
        )
    return subprocess.call(cmd)


def _get_huggingface_hub_update_command() -> list[str] | None:
    """Return the command to update huggingface_hub as an argv list, or None if the installation method is unknown."""
    match installation_method():
        case "brew":
            return ["brew", "upgrade", "hf"]
        case "hf_installer" if os.name == "nt":
            return ["powershell", "-NoProfile", "-Command", "iwr -useb https://hf.co/cli/install.ps1 | iex"]
        case "hf_installer":
            return ["bash", "-c", "curl -LsSf https://hf.co/cli/install.sh | bash -"]
        case "pip":
            return [sys.executable, "-m", "pip", "install", "-U", "huggingface_hub"]
        case _:
            return None


def _get_transformers_update_command() -> list[str] | None:
    """Return the command to update transformers as an argv list, or None if the installation method is unknown."""
    match installation_method():
        case "hf_installer" if os.name == "nt":
            return [
                "powershell",
                "-NoProfile",
                "-Command",
                "iwr -useb https://hf.co/cli/install.ps1 | iex -WithTransformers",
            ]
        case "hf_installer":
            return ["bash", "-c", "curl -LsSf https://hf.co/cli/install.sh | bash -s -- --with-transformers"]
        case "pip":
            return [sys.executable, "-m", "pip", "install", "-U", "transformers"]
        case _:
            return None
