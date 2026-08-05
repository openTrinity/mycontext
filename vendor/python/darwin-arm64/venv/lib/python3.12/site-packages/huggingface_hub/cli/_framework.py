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
"""Minimal declaration layer over Click 8.x for the ``hf`` CLI.

This module vendors *only* the slice of Typer the CLI actually uses: turning
annotated function signatures (``Annotated[T, Option(...)]`` / ``Argument(...)``)
into Click parameters, and rendering argument/option help the way Typer did.
It exists so the CLI depends on Click's stable public API instead of Typer's
now-internal vendored Click (``typer._click``), which Typer reserves the right
to refactor at any release.

Deliberately *not* implemented (add a case here only when a command needs it):
rich rendering, shell-completion install commands, prompts/confirmation options,
env-var options, ``File``/``UUID`` params, ``count`` options, ``default_factory``.
Click's own machinery already handles exceptions, aborts, exits, and native
``_HF_COMPLETE`` shell completion, so none of Typer's ``main()`` overrides are
reproduced here.

The interesting logic mirrors four Typer functions, kept faithful so ``--help``
output stays byte-identical:
- :func:`_get_click_type`          <- ``typer.main.get_click_type``
- :func:`_build_click_param`       <- ``typer.main.get_click_param``
- :func:`_make_handler`            <- ``typer.main.get_callback``
- :class:`HfArgument` / :class:`HfOption` help records <- ``typer.core.Typer*``
"""

import enum
import functools
import inspect
from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from types import UnionType
from typing import Annotated, Any, Literal, Union, get_args, get_origin

import click


def get_command_name(name: str) -> str:
    """Normalize a Python identifier to a CLI name (``force_download`` -> ``force-download``)."""
    return name.lower().replace("_", "-")


# ---------------------------------------------------------------------------
# 1. Declaration markers — replace ``typer.Option`` / ``typer.Argument``.
#    Attached in ``Annotated[T, Option(...)]``; the ``= value`` in the function
#    signature carries the default (never the marker).
# ---------------------------------------------------------------------------


class ParameterInfo:
    """Base marker holding the (tiny) set of Click knobs the CLI actually sets.

    ``callback`` is a Typer-style value parser ``fn(value) -> parsed`` — it does NOT
    receive Click's ``(ctx, param, value)``. It consumes the enum/list convertors, so
    ``value`` is already converted when it runs.
    """

    def __init__(
        self,
        *param_decls: str,
        help: str | None = None,
        show_default: bool | str = True,
        hidden: bool = False,
        is_eager: bool = False,
        callback: Callable[..., Any] | None = None,
        min: int | None = None,
        click_type: click.ParamType | None = None,
    ) -> None:
        self.param_decls = list(param_decls)
        self.help = help
        self.show_default = show_default
        self.hidden = hidden
        self.is_eager = is_eager
        self.callback = callback
        self.min = min
        self.click_type = click_type


class Option(ParameterInfo):
    """Declare a CLI option, e.g. ``Annotated[str | None, Option("--revision")]``."""


class Argument(ParameterInfo):
    """Declare a positional CLI argument, e.g. ``Annotated[str, Argument()]``."""


# ---------------------------------------------------------------------------
# 2. Annotation -> Click type + value convertors.
# ---------------------------------------------------------------------------


def _get_click_type(annotation: Any, info: ParameterInfo) -> click.ParamType:
    """Map a (already unwrapped) annotation to a Click ``ParamType``."""
    if info.click_type is not None:
        return info.click_type
    if annotation is str:
        return click.STRING
    if annotation is bool:
        return click.BOOL
    if annotation is int:
        return click.IntRange(min=info.min) if info.min is not None else click.INT
    if annotation is float:
        return click.FloatRange(min=info.min) if info.min is not None else click.FLOAT
    if annotation is Path:
        return click.Path(path_type=Path)
    if annotation is datetime:
        return click.DateTime()
    if isinstance(annotation, type) and issubclass(annotation, enum.Enum):
        values = [item.value for item in annotation]
        if not all(isinstance(value, str) for value in values):
            # A non-str member default would fail Choice validation at parse time with a
            # cryptic error; fail at build time with a clear one instead.
            raise TypeError(f"Unsupported enum {annotation.__name__!r}: only str-valued enums are supported.")
        return click.Choice(values)
    if get_origin(annotation) is Literal:
        return click.Choice([str(value) for value in get_args(annotation)])
    raise TypeError(f"Unsupported CLI annotation {annotation!r}. Add a case in `_framework._get_click_type()`.")


def _enum_convertor(enum_type: type[enum.Enum]) -> Callable[[Any], Any]:
    """Map a parsed choice string back to its ``Enum`` member (mirrors Typer)."""
    value_map = {str(member.value): member for member in enum_type}

    def convertor(value: Any) -> Any:
        if value is not None:
            return value_map.get(str(value))
        return None

    return convertor


def _list_convertor(
    inner: Callable[[Any], Any] | None, default_value: Any | None
) -> Callable[[Sequence[Any] | None], list[Any] | None]:
    """Turn Click's tuple (from ``multiple=True``) into a list, applying ``inner`` per item."""

    def convertor(value: Sequence[Any] | None) -> list[Any] | None:
        if value is None or (default_value is None and len(value) == 0):
            return None
        return [inner(item) if inner else item for item in value]

    return convertor


def _make_convertor(
    annotation: Any, is_list: bool, default_value: Any | None, info: ParameterInfo
) -> Callable[[Any], Any] | None:
    """Build the value convertor for a param (``None`` when no coercion is needed).

    An explicit ``click_type`` (e.g. ``SoftChoice``) owns its own conversion, so no
    enum convertor is added on top of it.
    """
    inner = None
    if info.click_type is None and isinstance(annotation, type) and issubclass(annotation, enum.Enum):
        inner = _enum_convertor(annotation)
    if is_list:
        return _list_convertor(inner, default_value)
    return inner


def _unwrap_optional_and_list(annotation: Any) -> tuple[Any, bool]:
    """Strip ``T | None`` / ``Optional[T]`` and ``list[T]``; return ``(base_type, is_list)``."""
    origin = get_origin(annotation)
    if origin in (Union, UnionType):
        non_none = [arg for arg in get_args(annotation) if arg is not type(None)]
        if len(non_none) != 1:
            raise TypeError(f"Unsupported union annotation {annotation!r}; only ``T | None`` is supported.")
        annotation = non_none[0]
        origin = get_origin(annotation)
    if origin in (list, Sequence):
        return get_args(annotation)[0], True
    return annotation, False


def _split_annotated(annotation: Any) -> tuple[Any, ParameterInfo | None]:
    """Split ``Annotated[T, Option(...)]`` into ``(T, marker)``; ``(annotation, None)`` otherwise."""
    if get_origin(annotation) is Annotated:
        args = get_args(annotation)
        marker = next((meta for meta in args[1:] if isinstance(meta, ParameterInfo)), None)
        if marker is None and (typer_marker := next((meta for meta in args[1:] if _is_typer_marker(meta)), None)):
            marker = _from_typer_marker(typer_marker, from_annotated=True)
        return args[0], marker
    return annotation, None


# ---------------------------------------------------------------------------
# Typer-marker compatibility shim (transition helper).
#
# ``typer_factory`` is exposed publicly and downstream CLIs (e.g. `transformers`)
# still register commands whose parameters carry ``typer.Option`` /
# ``typer.Argument`` markers. Recognize those markers structurally (no typer
# import required) and translate the fields this framework supports, so such
# commands keep working while downstream migrates.
# TODO: remove once transformers pins huggingface_hub>=1.22.0.
# ---------------------------------------------------------------------------


def _is_typer_marker(obj: Any) -> bool:
    return type(obj).__module__.partition(".")[0] == "typer" and type(obj).__name__ in ("OptionInfo", "ArgumentInfo")


def _from_typer_marker(meta: Any, *, from_annotated: bool) -> ParameterInfo:
    """Translate a ``typer.models.OptionInfo`` / ``ArgumentInfo`` into our marker."""
    param_decls = list(getattr(meta, "param_decls", None) or ())
    if type(meta).__name__ == "OptionInfo":
        # In ``Annotated[...]`` usage typer stores the first flag name in ``default``
        # (``Option("--flag", "-f")`` -> ``default="--flag"``, ``param_decls=("-f",)``).
        default = getattr(meta, "default", ...)
        if from_annotated and isinstance(default, str):
            param_decls = [default, *param_decls]
        cls: type[ParameterInfo] = Option
    else:
        cls = Argument
    return cls(
        *param_decls,
        help=getattr(meta, "help", None),
        show_default=getattr(meta, "show_default", True),
        hidden=getattr(meta, "hidden", False),
        is_eager=getattr(meta, "is_eager", False),
        callback=getattr(meta, "callback", None),
        min=getattr(meta, "min", None),
        click_type=getattr(meta, "click_type", None),
    )


# ---------------------------------------------------------------------------
# 3. Signature -> Click parameters (mirrors ``typer.main.get_click_param``).
# ---------------------------------------------------------------------------


def _wrap_param_callback(
    user_callback: Callable[[Any], Any], convertor: Callable[[Any], Any] | None
) -> Callable[[click.Context, click.Parameter, Any], Any]:
    """Adapt a Typer-style value parser ``fn(value) -> parsed`` to a Click param callback."""

    def click_callback(ctx: click.Context, param: click.Parameter, value: Any) -> Any:
        return user_callback(convertor(value) if convertor else value)

    return click_callback


def _build_click_param(
    name: str, annotation: Any, info: ParameterInfo | None, signature_default: Any
) -> tuple[click.Parameter, Callable[[Any], Any] | None]:
    """Build a Click ``Parameter`` (and its post-parse value convertor) for one function param."""
    required = signature_default is inspect.Parameter.empty
    default_value = None if required else signature_default
    if isinstance(default_value, enum.Enum):
        default_value = default_value.value
    if info is None:
        # A bare annotation with no marker: required positional -> Argument, else Option.
        info = Argument() if required else Option()

    base_type, is_list = _unwrap_optional_and_list(annotation)
    convertor = _make_convertor(base_type, is_list, default_value, info)

    # A user ``callback`` consumes the value itself (and the convertor with it); otherwise the
    # convertor runs later in the command handler wrapper. This keeps conversion single-pass.
    if info.callback is not None:
        param_callback: Callable[..., Any] | None = _wrap_param_callback(info.callback, convertor)
        handler_convertor: Callable[[Any], Any] | None = None
    else:
        param_callback = None
        handler_convertor = convertor

    if isinstance(info, Argument):
        argument = HfArgument(
            [name],
            type=_get_click_type(base_type, info),
            required=required,
            default=default_value,
            nargs=-1 if is_list else 1,
            is_eager=info.is_eager,
            callback=param_callback,
            help=info.help,
            show_default=info.show_default,
            hidden=info.hidden,
        )
        return argument, handler_convertor

    # Option: prepend the Python name so ``click.Parameter.name`` matches the function kwarg,
    # regardless of the user-facing flag names ("-v"/"--version", "--type"/"--repo-type", ...).
    is_flag = base_type is bool
    decls = [name]
    if info.param_decls:
        decls.extend(info.param_decls)
    else:
        kebab = get_command_name(name)
        decls.append(f"--{kebab}/--no-{kebab}" if is_flag else f"--{kebab}")
    option = HfOption(
        decls,
        # Click infers the flag type itself; passing a type alongside ``is_flag`` is rejected.
        type=None if is_flag else _get_click_type(base_type, info),
        required=required,
        default=default_value,
        is_flag=is_flag,
        multiple=is_list,
        is_eager=info.is_eager,
        callback=param_callback,
        help=info.help,
        show_default=info.show_default,
        hidden=info.hidden,
    )
    return option, handler_convertor


def _build_params(
    func: Callable[..., Any],
) -> tuple[list[click.Parameter], dict[str, Callable[[Any], Any]], str | None]:
    """Introspect ``func`` and return ``(params, convertors, context_param_name)``."""
    params: list[click.Parameter] = []
    convertors: dict[str, Callable[[Any], Any]] = {}
    context_param_name: str | None = None
    for name, sig_param in inspect.signature(func).parameters.items():
        # Read raw signature annotations rather than ``typing.get_type_hints``: the CLI never uses
        # ``from __future__ import annotations``, so annotations are already live objects, and
        # get_type_hints mangles ``Annotated[X | None, ...]`` on Python 3.10 (drops the origin).
        annotation = sig_param.annotation if sig_param.annotation is not inspect.Parameter.empty else str
        base_type, info = _split_annotated(annotation)
        if isinstance(base_type, type) and (
            issubclass(base_type, click.Context)
            # typer.Context subclasses typer's *vendored* click since typer 0.26, so an
            # issubclass check against real click misses it. Match it structurally.
            or (base_type.__module__.partition(".")[0] == "typer" and base_type.__name__ == "Context")
        ):
            context_param_name = name
            continue
        signature_default = sig_param.default
        if _is_typer_marker(signature_default):
            # Old typer style: the marker *is* the signature default and carries the value.
            if info is None:
                info = _from_typer_marker(signature_default, from_annotated=False)
            marker_default = getattr(signature_default, "default", ...)
            signature_default = inspect.Parameter.empty if marker_default is ... else marker_default
        click_param, convertor = _build_click_param(name, base_type, info, signature_default)
        if convertor is not None and click_param.name is not None:
            convertors[click_param.name] = convertor
        params.append(click_param)
    return params, convertors, context_param_name


def _make_handler(
    func: Callable[..., Any],
    convertors: dict[str, Callable[[Any], Any]],
    context_param_name: str | None,
) -> Callable[..., Any]:
    """Wrap ``func`` so Click's kwargs map back to it, applying convertors and injecting the ctx."""

    def handler(**kwargs: Any) -> Any:
        call_kwargs = {key: (convertors[key](value) if key in convertors else value) for key, value in kwargs.items()}
        if context_param_name is not None:
            call_kwargs[context_param_name] = click.get_current_context()
        return func(**call_kwargs)

    functools.update_wrapper(handler, func)
    return handler


# ---------------------------------------------------------------------------
# 4. Click parameter subclasses — port Typer's help records so arguments show up
#    in ``--help`` (plain ``click.Argument`` renders none) and defaults/metavars
#    read identically. Rich/env-var branches are dropped (never enabled here).
# ---------------------------------------------------------------------------


def _split_opt(opt: str) -> tuple[str, str]:
    """Split an option string into ``(prefix, name)`` (Click's ``split_opt``, inlined)."""
    first = opt[:1]
    if first.isalnum():
        return "", opt
    if opt[1:2] == first:
        return opt[:2], opt[2:]
    return first, opt[1:]


def _extract_default_help_str(param: click.Parameter, ctx: click.Context) -> Any:
    # Resilient parsing avoids type casting failing while rendering the default.
    resilient = ctx.resilient_parsing
    ctx.resilient_parsing = True
    try:
        return param.get_default(ctx, call=False)
    finally:
        ctx.resilient_parsing = resilient


def _default_string(
    param: "HfArgument | HfOption", ctx: click.Context, show_default_is_str: bool, default_value: Any
) -> str:
    if show_default_is_str:
        return f"({param.show_default})"
    if isinstance(default_value, (list, tuple)):
        return ", ".join(_default_string(param, ctx, show_default_is_str, item) for item in default_value)
    if isinstance(default_value, enum.Enum):
        return str(default_value.value)
    if inspect.isfunction(default_value):
        return "(dynamic)"
    if isinstance(param, HfOption) and param.is_bool_flag and param.secondary_opts:
        # Boolean toggle: show the opt name (without prefix) matching the current default.
        if default_value:
            return _split_opt(param.opts[0])[1] if param.opts else str(default_value)
        return _split_opt(param.secondary_opts[0])[1]
    if isinstance(param, HfOption) and param.is_bool_flag and not param.secondary_opts and not default_value:
        return ""
    return str(default_value)


def _describe_number_range(param_type: "click.IntRange | click.FloatRange") -> str:
    """Human-readable range hint like ``x>=1`` or ``1<=x<10``.

    Reproduces click's private ``_NumberRangeBase._describe_range()`` using the public
    ``IntRange``/``FloatRange`` attributes, so the framework stays on Click's public API.
    """
    if param_type.min is None:
        return f"x{'<' if param_type.max_open else '<='}{param_type.max}"
    if param_type.max is None:
        return f"x{'>' if param_type.min_open else '>='}{param_type.min}"
    left = "<" if param_type.min_open else "<="
    right = "<" if param_type.max_open else "<="
    return f"{param_type.min}{left}x{right}{param_type.max}"


def _build_help_extra(param: "HfArgument | HfOption", ctx: click.Context, base_help: str) -> str:
    """Append the ``[default: ...; required]`` suffix to a help string (shared by arg/option)."""
    extra: list[str] = []
    default_value = _extract_default_help_str(param, ctx)
    show_default_is_str = isinstance(param.show_default, str)
    if show_default_is_str or (default_value is not None and (param.show_default or ctx.show_default)):
        default_string = _default_string(param, ctx, show_default_is_str, default_value)
        if default_string:
            extra.append(f"default: {default_string}")
    # Numeric range hints are shown for options only (matches Typer; arguments omit them).
    if isinstance(param, HfOption) and isinstance(param.type, (click.IntRange, click.FloatRange)):
        range_str = _describe_number_range(param.type)
        if range_str:
            extra.append(range_str)
    if param.required:
        extra.append("required")
    if extra:
        suffix = f"[{'; '.join(extra)}]"
        return f"{base_help}  {suffix}" if base_help else suffix
    return base_help


class HfArgument(click.Argument):
    """Positional argument that renders help text and a metavar (Click's does neither)."""

    def __init__(
        self,
        param_decls: Sequence[str],
        *,
        help: str | None = None,
        show_default: bool | str = True,
        hidden: bool = False,
        **attrs: Any,
    ) -> None:
        self.help = help
        self.show_default = show_default
        self.hidden = hidden
        super().__init__(param_decls, **attrs)

    def make_metavar(self, ctx: click.Context) -> str:
        if self.metavar is not None:
            var = self.metavar
            if not self.required and not var.startswith("["):
                var = f"[{var}]"
            return var
        var = (self.name or "").upper()
        if not self.required:
            var = f"[{var}]"
        type_var = self.type.get_metavar(self, ctx=ctx)
        if type_var:
            var += f":{type_var}"
        if self.nargs != 1:
            var += "..."
        return var

    def get_help_record(self, ctx: click.Context) -> tuple[str, str] | None:
        if self.hidden:
            return None
        return self.make_metavar(ctx=ctx), _build_help_extra(self, ctx, self.help or "")


class HfOption(click.Option):
    """Option whose help record ports Typer's default/metavar rendering verbatim."""

    show_default: bool | str

    def get_help_record(self, ctx: click.Context) -> tuple[str, str] | None:
        if self.hidden:
            return None

        any_prefix_is_slash = False

        def _write_opts(opts: Sequence[str]) -> str:
            nonlocal any_prefix_is_slash
            rv, any_slashes = click.formatting.join_options(opts)
            if any_slashes:
                any_prefix_is_slash = True
            if not self.is_flag and not self.count:
                rv += f" {self.make_metavar(ctx=ctx)}"
            return rv

        rv = [_write_opts(self.opts)]
        if self.secondary_opts:
            rv.append(_write_opts(self.secondary_opts))

        help_text = _build_help_extra(self, ctx, self.help or "")
        return ("; " if any_prefix_is_slash else " / ").join(rv), help_text


# ---------------------------------------------------------------------------
# 5. Command / group base classes and the decorator API (replace ``typer.Typer``).
# ---------------------------------------------------------------------------


def _format_params(command: click.Command, ctx: click.Context, formatter: click.HelpFormatter) -> None:
    """Render params split into "Arguments" and "Options" sections (mirrors Typer)."""
    args: list[tuple[str, str]] = []
    opts: list[tuple[str, str]] = []
    for param in command.get_params(ctx):
        record = param.get_help_record(ctx)
        if record is None:
            continue
        if param.param_type_name == "argument":
            args.append(record)
        elif param.param_type_name == "option":
            opts.append(record)
    if args:
        with formatter.section("Arguments"):
            formatter.write_dl(args)
    if opts:
        with formatter.section("Options"):
            formatter.write_dl(opts)


class HfCommand(click.Command):
    """Leaf command that renders arguments and options in separate help sections."""

    def format_options(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        _format_params(self, ctx, formatter)


def build_command(
    func: Callable[..., Any],
    *,
    name: str | None = None,
    cls: type[click.Command] | None = None,
    help: str | None = None,
    epilog: str | None = None,
    short_help: str | None = None,
    options_metavar: str = "[OPTIONS]",
    add_help_option: bool = True,
    no_args_is_help: bool = False,
    hidden: bool = False,
    deprecated: bool = False,
    context_settings: dict[str, Any] | None = None,
) -> click.Command:
    """Build a Click ``Command`` from a function with ``Annotated`` params.

    Replaces ``typer.main.get_command_from_info``.
    """
    params, convertors, context_param_name = _build_params(func)
    handler = _make_handler(func, convertors, context_param_name)
    command_help = inspect.cleandoc(help) if help else inspect.getdoc(func)
    return (cls or HfCommand)(
        name=name if name is not None else get_command_name(func.__name__),
        callback=handler,
        params=params,
        help=command_help,
        epilog=epilog,
        short_help=short_help,
        options_metavar=options_metavar,
        add_help_option=add_help_option,
        no_args_is_help=no_args_is_help,
        hidden=hidden,
        deprecated=deprecated,
        context_settings=context_settings or {},
    )


class HfGroup(click.Group):
    """Command group with the decorator API the CLI relies on (``command``/``callback``/``add_group``).

    Subclasses (see ``HFCliTyperGroup``) layer on styling, aliases, topics and error
    enrichment; this base only wires functions to Click via :func:`build_command`.
    """

    #: Command class used by ``@group.command()`` unless overridden per call.
    command_class: type[click.Command] = HfCommand

    def format_options(self, ctx: click.Context, formatter: click.HelpFormatter) -> None:
        _format_params(self, ctx, formatter)
        self.format_commands(ctx, formatter)

    def list_commands(self, ctx: click.Context) -> list[str]:
        # Preserve declaration order rather than Click's alphabetical default.
        return list(self.commands)

    def command(  # type: ignore  # deliberately narrows click.Group.command (builds from annotated signatures)
        self, name: str | None = None, *, cls: type[click.Command] | None = None, **kwargs: Any
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            command = build_command(func, name=name, cls=cls or self.command_class, **kwargs)
            self.add_command(command, command.name)
            return func

        return decorator

    def add_group(self, group: click.Group, *, name: str, hidden: bool = False) -> None:
        """Register a subgroup under ``name`` (which may carry pipe aliases, e.g. ``"repos | repo"``)."""
        group.name = name
        group.hidden = hidden
        self.add_command(group, name)

    def group_callback(
        self, *, invoke_without_command: bool = False
    ) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        """Register the function invoked for this group (named ``group_callback`` because Click
        already uses the ``callback`` attribute for the group's own handler)."""

        def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
            params, convertors, context_param_name = _build_params(func)
            self.callback = _make_handler(func, convertors, context_param_name)
            self.params = [*self.params, *params]
            self.invoke_without_command = invoke_without_command
            if invoke_without_command:
                # Match Typer: the subcommand is optional when the group runs without one.
                self.subcommand_metavar = "[COMMAND] [ARGS]..."
            if self.help is None and func.__doc__:
                self.help = inspect.cleandoc(func.__doc__)
            return func

        return decorator
