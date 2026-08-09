import copy
import os
import pathlib
import re
import string
import sys
import types
import warnings
from contextlib import contextmanager
from enum import Enum
from textwrap import dedent
from typing import (
    Any,
    Dict,
    Iterator,
    List,
    Optional,
    Tuple,
    Type,
    Union,
    get_type_hints,
)

import yaml

from .errors import (
    ConfigIndexError,
    ConfigTypeError,
    ConfigValueError,
    GrammarParseError,
    OmegaConfBaseException,
    ValidationError,
)
from .grammar_parser import SIMPLE_INTERPOLATION_PATTERN, parse

try:
    import dataclasses

except ImportError:  # pragma: no cover
    dataclasses = None  # type: ignore # pragma: no cover

try:
    import attr

except ImportError:  # pragma: no cover
    attr = None  # type: ignore # pragma: no cover

NoneType: Type[None] = type(None)

BUILTIN_VALUE_TYPES: Tuple[Type[Any], ...] = (
    int,
    float,
    bool,
    str,
    bytes,
    NoneType,
)

# Regexprs to match key paths like: a.b, a[b], ..a[c].d, etc.
# We begin by matching the head (in these examples: a, a, ..a).
# This can be read as "dots followed by any character but `.` or `[`"
# Note that a key starting with brackets, like [a], is purposedly *not*
# matched here and will instead be handled in the next regex below (this
# is to keep this regex simple).
KEY_PATH_HEAD = re.compile(r"(\.)*[^.[]*")
# Then we match other keys. The following expression matches one key and can
# be read as a choice between two syntaxes:
#   - `.` followed by anything except `.` or `[` (ex: .b, .d)
#   - `[` followed by anything then `]` (ex: [b], [c])
KEY_PATH_OTHER = re.compile(r"\.([^.[]*)|\[(.*?)\]")


# source: https://yaml.org/type/bool.html
YAML_BOOL_TYPES = [
    "y",
    "Y",
    "yes",
    "Yes",
    "YES",
    "n",
    "N",
    "no",
    "No",
    "NO",
    "true",
    "True",
    "TRUE",
    "false",
    "False",
    "FALSE",
    "on",
    "On",
    "ON",
    "off",
    "Off",
    "OFF",
]


class Marker:
    def __init__(self, desc: str):
        self.desc = desc

    def __repr__(self) -> str:
        return self.desc


# To be used as default value when `None` is not an option.
_DEFAULT_MARKER_: Any = Marker("_DEFAULT_MARKER_")


class OmegaConfDumper(yaml.Dumper):  # type: ignore
    str_representer_added = False

    @staticmethod
    def str_representer(dumper: yaml.Dumper, data: str) -> yaml.ScalarNode:
        with_quotes = yaml_is_bool(data) or is_int(data) or is_float(data)
        return dumper.represent_scalar(
            yaml.resolver.BaseResolver.DEFAULT_SCALAR_TAG,
            data,
            style=("'" if with_quotes else None),
        )


def get_omega_conf_dumper() -> Type[OmegaConfDumper]:
    if not OmegaConfDumper.str_representer_added:
        OmegaConfDumper.add_representer(str, OmegaConfDumper.str_representer)
        OmegaConfDumper.str_representer_added = True
    return OmegaConfDumper


def yaml_is_bool(b: str) -> bool:
    return b in YAML_BOOL_TYPES


def get_yaml_loader() -> Any:
    class OmegaConfLoader(yaml.SafeLoader):  # type: ignore
        def construct_mapping(self, node: yaml.Node, deep: bool = False) -> Any:
            keys = set()
            for key_node, value_node in node.value:
                if key_node.tag != yaml.resolver.BaseResolver.DEFAULT_SCALAR_TAG:
                    continue
                if key_node.value in keys:
                    raise yaml.constructor.ConstructorError(
                        "while constructing a mapping",
                        node.start_mark,
                        f"found duplicate key {key_node.value}",
                        key_node.start_mark,
                    )
                keys.add(key_node.value)
            return super().construct_mapping(node, deep=deep)

    loader = OmegaConfLoader
    loader.add_implicit_resolver(
        "tag:yaml.org,2002:float",
        re.compile(
            """^(?:
         [-+]?[0-9]+(?:_[0-9]+)*\\.[0-9_]*(?:[eE][-+]?[0-9]+)?
        |[-+]?[0-9]+(?:_[0-9]+)*(?:[eE][-+]?[0-9]+)
        |\\.[0-9]+(?:_[0-9]+)*(?:[eE][-+][0-9]+)?
        |[-+]?[0-9]+(?:_[0-9]+)*(?::[0-5]?[0-9])+\\.[0-9_]*
        |[-+]?\\.(?:inf|Inf|INF)
        |\\.(?:nan|NaN|NAN))$""",
            re.X,
        ),
        list("-+0123456789."),
    )
    loader.yaml_implicit_resolvers = {
        key: [
            (tag, regexp)
            for tag, regexp in resolvers
            if tag != "tag:yaml.org,2002:timestamp"
        ]
        for key, resolvers in loader.yaml_implicit_resolvers.items()
    }

    loader.add_constructor(
        "tag:yaml.org,2002:python/object/apply:pathlib.Path",
        lambda loader, node: pathlib.Path(*loader.construct_sequence(node)),
    )
    loader.add_constructor(
        "tag:yaml.org,2002:python/object/apply:pathlib.PosixPath",
        lambda loader, node: pathlib.PosixPath(*loader.construct_sequence(node)),
    )
    loader.add_constructor(
        "tag:yaml.org,2002:python/object/apply:pathlib.WindowsPath",
        lambda loader, node: pathlib.WindowsPath(*loader.construct_sequence(node)),
    )

    return loader


def _get_class(path: str) -> type:
    from importlib import import_module

    module_path, _, class_name = path.rpartition(".")
    mod = import_module(module_path)
    try:
        klass: type = getattr(mod, class_name)
    except AttributeError:
        raise ImportError(f"Class {class_name} is not in module {module_path}")
    return klass


def is_union_annotation(type_: Any) -> bool:
    if sys.version_info >= (3, 10):  # pragma: no cover
        if isinstance(type_, types.UnionType):
            return True
    return getattr(type_, "__origin__", None) is Union


def _resolve_optional(type_: Any) -> Tuple[bool, Any]:
    """Check whether `type_` is equivalent to `typing.Optional[T]` for some T."""
    if is_union_annotation(type_):
        args = type_.__args__
        if NoneType in args:
            optional = True
            args = tuple(a for a in args if a is not NoneType)
        else:
            optional = False
        if len(args) == 1:
            return optional, args[0]
        elif len(args) >= 2:
            return optional, Union[args]
        else:
            assert False

    if type_ is Any:
        return True, Any

    if type_ in (None, NoneType):
        return True, NoneType

    return False, type_


def _is_optional(obj: Any, key: Optional[Union[int, str]] = None) -> bool:
    """Check `obj` metadata to see if the given node is optional."""
    from .base import Container, Node

    if key is not None:
        assert isinstance(obj, Container)
        obj = obj._get_node(key)
    assert isinstance(obj, Node)
    return obj._is_optional()


def _resolve_forward(type_: Type[Any], module: str) -> Type[Any]:
    import typing  # lgtm [py/import-and-import-from]

    forward = typing.ForwardRef if hasattr(typing, "ForwardRef") else typing._ForwardRef  # type: ignore
    if type(type_) is forward:
        return _get_class(f"{module}.{type_.__forward_arg__}")
    else:
        if is_dict_annotation(type_):
            kt, vt = get_dict_key_value_types(type_)
            if kt is not None:
                kt = _resolve_forward(kt, module=module)
            if vt is not None:
                vt = _resolve_forward(vt, module=module)
            return Dict[kt, vt]  # type: ignore
        if is_list_annotation(type_):
            et = get_list_element_type(type_)
            if et is not None:
                et = _resolve_forward(et, module=module)
            return List[et]  # type: ignore
        if is_tuple_annotation(type_):
            its = get_tuple_item_types(type_)
            its = tuple(_resolve_forward(it, module=module) for it in its)
            return Tuple[its]  # type: ignore

        return type_


def extract_dict_subclass_data(obj: Any, parent: Any) -> Optional[Dict[str, Any]]:
    """Check if obj is an instance of a subclass of Dict. If so, extract the Dict keys/values."""
    from omegaconf.omegaconf import _maybe_wrap

    is_type = isinstance(obj, type)
    obj_type = obj if is_type else type(obj)
    subclasses_dict = is_dict_subclass(obj_type)

    if subclasses_dict:
        warnings.warn(
            f"Class `{obj_type.__name__}` subclasses `Dict`."
            + " Subclassing `Dict` in Structured Config classes is deprecated,"
            + " see github.com/omry/omegaconf/issues/663",
            UserWarning,
            stacklevel=9,
        )

    if is_type:
        return None
    elif subclasses_dict:
        dict_subclass_data = {}
        key_type, element_type = get_dict_key_value_types(obj_type)
        for name, value in obj.items():
            is_optional, type_ = _resolve_optional(element_type)
            type_ = _resolve_forward(type_, obj.__module__)
            try:
                dict_subclass_data[name] = _maybe_wrap(
                    ref_type=type_,
                    is_optional=is_optional,
                    key=name,
                    value=value,
                    parent=parent,
                )
            except ValidationError as ex:
                format_and_raise(
                    node=None, key=name, value=value, cause=ex, msg=str(ex)
                )
        return dict_subclass_data
    else:
        return None


def get_attr_class_fields(obj: Any) -> List["attr.Attribute[Any]"]:
    is_type = isinstance(obj, type)
    obj_type = obj if is_type else type(obj)
    fields = attr.fields_dict(obj_type).values()
    return [f for f in fields if f.metadata.get("omegaconf_ignore") is not True]


def get_attr_data(obj: Any, allow_objects: Optional[bool] = None) -> Dict[str, Any]:
    from omegaconf.omegaconf import OmegaConf, _maybe_wrap

    flags = {"allow_objects": allow_objects} if allow_objects is not None else {}

    from omegaconf import MISSING

    d = {}
    is_type = isinstance(obj, type)
    obj_type = obj if is_type else type(obj)
    dummy_parent = OmegaConf.create({}, flags=flags)
    dummy_parent._metadata.object_type = obj_type
    resolved_hints = get_type_hints(obj_type)

    for attrib in get_attr_class_fields(obj):
        name = attrib.name
        is_optional, type_ = _resolve_optional(resolved_hints[name])
        type_ = _resolve_forward(type_, obj.__module__)
        if not is_type:
            value = getattr(obj, name)
        else:
            value = attrib.default
            if value == attr.NOTHING:
                value = MISSING
        if is_union_annotation(type_) and not is_supported_union_annotation(type_):
            e = ConfigValueError(
                f"Unions of containers are not supported:\n{name}: {type_str(type_)}"
            )
            format_and_raise(node=None, key=None, value=value, cause=e, msg=str(e))

        try:
            d[name] = _maybe_wrap(
                ref_type=type_,
                is_optional=is_optional,
                key=name,
                value=value,
                parent=dummy_parent,
            )
        except (ValidationError, GrammarParseError) as ex:
            format_and_raise(
                node=dummy_parent, key=name, value=value, cause=ex, msg=str(ex)
            )
        d[name]._set_parent(None)
    dict_subclass_data = extract_dict_subclass_data(obj=obj, parent=dummy_parent)
    if dict_subclass_data is not None:
        d.update(dict_subclass_data)
    return d


def get_dataclass_fields(obj: Any) -> List["dataclasses.Field[Any]"]:
    fields = dataclasses.fields(obj)
    return [f for f in fields if f.metadata.get("omegaconf_ignore") is not True]


def get_dataclass_data(
    obj: Any, allow_objects: Optional[bool] = None
) -> Dict[str, Any]:
    from omegaconf.omegaconf import MISSING, OmegaConf, _maybe_wrap

    flags = {"allow_objects": allow_objects} if allow_objects is not None else {}
    d = {}
    is_type = isinstance(obj, type)
    obj_type = get_type_of(obj)
    dummy_parent = OmegaConf.create({}, flags=flags)
    dummy_parent._metadata.object_type = obj_type
    resolved_hints = get_type_hints(obj_type)
    for field in get_dataclass_fields(obj):
        name = field.name
        is_optional, type_ = _resolve_optional(resolved_hints[field.name])
        type_ = _resolve_forward(type_, obj.__module__)
        has_default = field.default != dataclasses.MISSING
        has_default_factory = field.default_factory != dataclasses.MISSING

        if not is_type:
            value = getattr(obj, name)
        else:
            if has_default:
                value = field.default
            elif has_default_factory:
                value = field.default_factory()  # type: ignore
            else:
                value = MISSING

        if is_union_annotation(type_) and not is_supported_union_annotation(type_):
            e = ConfigValueError(
                f"Unions of containers are not supported:\n{name}: {type_str(type_)}"
            )
            format_and_raise(node=None, key=None, value=value, cause=e, msg=str(e))
        try:
            d[name] = _maybe_wrap(
                ref_type=type_,
                is_optional=is_optional,
                key=name,
                value=value,
                parent=dummy_parent,
            )
        except (ValidationError, GrammarParseError) as ex:
            format_and_raise(
                node=dummy_parent, key=name, value=value, cause=ex, msg=str(ex)
            )
        d[name]._set_parent(None)
    dict_subclass_data = extract_dict_subclass_data(obj=obj, parent=dummy_parent)
    if dict_subclass_data is not None:
        d.update(dict_subclass_data)
    return d


def is_dataclass(obj: Any) -> bool:
    from omegaconf.base import Node

    if dataclasses is None or isinstance(obj, Node):
        return False
    return dataclasses.is_dataclass(obj)


def is_attr_class(obj: Any) -> bool:
    from omegaconf.base import Node

    if attr is None or isinstance(obj, Node):
        return False
    return attr.has(obj)


def is_structured_config(obj: Any) -> bool:
    return is_attr_class(obj) or is_dataclass(obj)


def is_dataclass_frozen(type_: Any) -> bool:
    return type_.__dataclass_params__.frozen  # type: ignore


def is_attr_frozen(type_: type) -> bool:
    # This is very hacky and probably fragile as well.
    # Unfortunately currently there isn't an official API in attr that can detect that.
    # noinspection PyProtectedMember
    return type_.__setattr__ == attr._make._frozen_setattrs  # type: ignore


def get_type_of(class_or_object: Any) -> Type[Any]:
    type_ = class_or_object
    if not isinstance(type_, type):
        type_ = type(class_or_object)
    assert isinstance(type_, type)
    return type_


def is_structured_config_frozen(obj: Any) -> bool:
    type_ = get_type_of(obj)

    if is_dataclass(type_):
        return is_dataclass_frozen(type_)
    if is_attr_class(type_):
        return is_attr_frozen(type_)
    return False


def get_structured_config_init_field_names(obj: Any) -> List[str]:
    fields: Union[List["dataclasses.Field[Any]"], List["attr.Attribute[Any]"]]
    if is_dataclass(obj):
        fields = get_dataclass_fields(obj)
    elif is_attr_class(obj):
        fields = get_attr_class_fields(obj)
    else:
        raise ValueError(f"Unsupported type: {type(obj).__name__}")
    return [f.name for f in fields if f.init]


def get_structured_config_data(
    obj: Any, allow_objects: Optional[bool] = None
) -> Dict[str, Any]:
    if is_dataclass(obj):
        return get_dataclass_data(obj, allow_objects=allow_objects)
    elif is_attr_class(obj):
        return get_attr_data(obj, allow_objects=allow_objects)
    else:
        raise ValueError(f"Unsupported type: {type(obj).__name__}")


class ValueKind(Enum):
    VALUE = 0
    MANDATORY_MISSING = 1
    INTERPOLATION = 2


def _is_missing_value(value: Any) -> bool:
    from omegaconf import Node

    if isinstance(value, Node):
        value = value._value()
    return _is_missing_literal(value)


def _is_missing_literal(value: Any) -> bool:
    # Uses literal '???' instead of the MISSING const for performance reasons.
    return isinstance(value, str) and value == "???"


def _is_none(
    value: Any, resolve: bool = False, throw_on_resolution_failure: bool = True
) -> bool:
    from omegaconf import Node

    if not isinstance(value, Node):
        return value is None

    if resolve:
        value = value._maybe_dereference_node(
            throw_on_resolution_failure=throw_on_resolution_failure
        )
        if not throw_on_resolution_failure and value is None:
            # Resolution failure: consider that it is *not* None.
            return False
        assert isinstance(value, Node)

    return value._is_none()


def get_value_kind(
    value: Any, strict_interpolation_validation: bool = False
) -> ValueKind:
    """
    Determine the kind of a value
    Examples:
    VALUE: "10", "20", True
    MANDATORY_MISSING: "???"
    INTERPOLATION: "${foo.bar}", "${foo.${bar}}", "${foo:bar}", "[${foo}, ${bar}]",
                   "ftp://${host}/path", "${foo:${bar}, [true], {'baz': ${baz}}}"

    :param value: Input to classify.
    :param strict_interpolation_validation: If `True`, then when `value` is a string
        containing "${", it is parsed to validate the interpolation syntax. If `False`,
        this parsing step is skipped: this is more efficient, but will not detect errors.
    """

    if _is_missing_value(value):
        return ValueKind.MANDATORY_MISSING

    if _is_interpolation(value, strict_interpolation_validation):
        return ValueKind.INTERPOLATION

    return ValueKind.VALUE


def _is_interpolation(v: Any, strict_interpolation_validation: bool = False) -> bool:
    from omegaconf import Node

    if isinstance(v, Node):
        v = v._value()

    if isinstance(v, str) and _is_interpolation_string(
        v, strict_interpolation_validation
    ):
        return True
    return False


def _is_interpolation_string(value: str, strict_interpolation_validation: bool) -> bool:
    # We identify potential interpolations by the presence of "${" in the string.
    # Note that escaped interpolations (ex: "esc: \${bar}") are identified as
    # interpolations: this is intended, since they must be processed as interpolations
    # for the string to be properly un-escaped.
    # Keep in mind that invalid interpolations will only be detected when
    # `strict_interpolation_validation` is True.
    if "${" in value:
        if strict_interpolation_validation:
            # First try the cheap regex matching that detects common interpolations.
            if SIMPLE_INTERPOLATION_PATTERN.match(value) is None:
                # If no match, do the more expensive grammar parsing to detect errors.
                parse(value)
        return True
    return False


def _is_special(value: Any) -> bool:
    """Special values are None, MISSING, and interpolation."""
    return _is_none(value) or get_value_kind(value) in (
        ValueKind.MANDATORY_MISSING,
        ValueKind.INTERPOLATION,
    )


def is_float(st: str) -> bool:
    try:
        float(st)
        return True
    except ValueError:
        return False


def is_int(st: str) -> bool:
    try:
        int(st)
        return True
    except ValueError:
        return False


def is_primitive_list(obj: Any) -> bool:
    return isinstance(obj, (list, tuple))


def is_primitive_dict(obj: Any) -> bool:
    t = get_type_of(obj)
    return t is dict


def is_dict_annotation(type_: Any) -> bool:
    if type_ in (dict, Dict):
        return True
    origin = getattr(type_, "__origin__", None)
    # type_dict is a bit hard to detect.
    # this support is tentative, if it eventually causes issues in other areas it may be dropped.
    if sys.version_info < (3, 7, 0):  # pragma: no cover
        typed_dict = hasattr(type_, "__base__") and type_.__base__ == Dict
        return origin is Dict or type_ is Dict or typed_dict
    else:  # pragma: no cover
        typed_dict = hasattr(type_, "__base__") and type_.__base__ == dict
        return origin is dict or typed_dict


def is_list_annotation(type_: Any) -> bool:
    if type_ in (list, List):
        return True
    origin = getattr(type_, "__origin__", None)
    if sys.version_info < (3, 7, 0):
        return origin is List or type_ is List  # pragma: no cover
    else:
        return origin is list  # pragma: no cover


def is_tuple_annotation(type_: Any) -> bool:
    if type_ in (tuple, Tuple):
        return True
    origin = getattr(type_, "__origin__", None)
    if sys.version_info < (3, 7, 0):
        return origin is Tuple or type_ is Tuple  # pragma: no cover
    else:
        return origin is tuple  # pragma: no cover


def is_supported_union_annotation(obj: Any) -> bool:
    """Currently only primitive types are supported in Unions, e.g. Union[int, str]"""
    if not is_union_annotation(obj):
        return False
    args = obj.__args__
    return all(is_primitive_type_annotation(arg) for arg in args)


def is_dict_subclass(type_: Any) -> bool:
    return type_ is not None and isinstance(type_, type) and issubclass(type_, Dict)


def is_dict(obj: Any) -> bool:
    return is_primitive_dict(obj) or is_dict_annotation(obj) or is_dict_subclass(obj)


def is_primitive_container(obj: Any) -> bool:
    return is_primitive_list(obj) or is_primitive_dict(obj)


def get_list_element_type(ref_type: Optional[Type[Any]]) -> Any:
    args = getattr(ref_type, "__args__", None)
    if ref_type is not List and args is not None and args[0]:
        element_type = args[0]
    else:
        element_type = Any
    return element_type


def get_tuple_item_types(ref_type: Type[Any]) -> Tuple[Any, ...]:
    args = getattr(ref_type, "__args__", None)
    if args in (None, ()):
        args = (Any, ...)
    assert isinstance(args, tuple)
    return args


def get_dict_key_value_types(ref_type: Any) -> Tuple[Any, Any]:
    args = getattr(ref_type, "__args__", None)
    if args is None:
        bases = getattr(ref_type, "__orig_bases__", None)
        if bases is not None and len(bases) > 0:
            args = getattr(bases[0], "__args__", None)

    key_type: Any
    element_type: Any
    if ref_type is None or ref_type == Dict:
        key_type = Any
        element_type = Any
    else:
        if args is not None:
            key_type = args[0]
            element_type = args[1]
        else:
            key_type = Any
            element_type = Any

    return key_type, element_type


def is_valid_value_annotation(type_: Any) -> bool:
    _, type_ = _resolve_optional(type_)
    return (
        type_ is Any
        or is_primitive_type_annotation(type_)
        or is_structured_config(type_)
        or is_container_annotation(type_)
        or is_supported_union_annotation(type_)
    )


def _valid_dict_key_annotation_type(type_: Any) -> bool:
    from omegaconf import DictKeyType

    return type_ is None or type_ is Any or issubclass(type_, DictKeyType.__args__)  # type: ignore


def is_primitive_type_annotation(type_: Any) -> bool:
    type_ = get_type_of(type_)
    return issubclass(type_, (Enum, pathlib.Path)) or type_ in BUILTIN_VALUE_TYPES


def _get_value(value: Any) -> Any:
    from .base import Container, UnionNode
    from .nodes import ValueNode

    if isinstance(value, ValueNode):
        return value._value()
    elif isinstance(value, Container):
        boxed = value._value()
        if boxed is None or _is_missing_literal(boxed) or _is_interpolation(boxed):
            return boxed
    elif isinstance(value, UnionNode):
        boxed = value._value()
        if boxed is None or _is_missing_literal(boxed) or _is_interpolation(boxed):
            return boxed
        else:
            return _get_value(boxed)  # pass through value of boxed node

    # return primitives and regular OmegaConf Containers as is
    return value


def get_type_hint(obj: Any, key: Any = None) -> Optional[Type[Any]]:
    from omegaconf import Container, Node

    if isinstance(obj, Container):
        if key is not None:
            obj = obj._get_node(key)
    else:
        if key is not None:
            raise ValueError("Key must only be provided when obj is a container")

    if isinstance(obj, Node):
        ref_type = obj._metadata.ref_type
        if obj._is_optional() and ref_type is not Any:
            return Optional[ref_type]  # type: ignore
        else:
            return ref_type
    else:
        return Any  # type: ignore


def _raise(ex: Exception, cause: Exception) -> None:
    # Set the environment variable OC_CAUSE=1 to get a stacktrace that includes the
    # causing exception.
    env_var = os.environ["OC_CAUSE"] if "OC_CAUSE" in os.environ else None
    debugging = sys.gettrace() is not None
    full_backtrace = (debugging and not env_var == "0") or (env_var == "1")
    if full_backtrace:
        ex.__cause__ = cause
    else:
        ex.__cause__ = None
    raise ex.with_traceback(sys.exc_info()[2])  # set env var OC_CAUSE=1 for full trace


def format_and_raise(
    node: Any,
    key: Any,
    value: Any,
    msg: str,
    cause: Exception,
    type_override: Any = None,
) -> None:
    from omegaconf import OmegaConf
    from omegaconf.base import Node

    if isinstance(cause, AssertionError):
        raise

    if isinstance(cause, OmegaConfBaseException) and cause._initialized:
        ex = cause
        if type_override is not None:
            ex = type_override(str(cause))
            ex.__dict__ = copy.deepcopy(cause.__dict__)
        _raise(ex, cause)

    object_type: Optional[Type[Any]]
    object_type_str: Optional[str] = None
    ref_type: Optional[Type[Any]]
    ref_type_str: Optional[str]

    child_node: Optional[Node] = None
    if node is None:
        full_key = key if key is not None else ""
        object_type = None
        ref_type = None
        ref_type_str = None
    else:
        if key is not None and not node._is_none():
            child_node = node._get_node(key, validate_access=False)

        try:
            full_key = node._get_full_key(key=key)
        except Exception as exc:
            # Since we are handling an exception, raising a different one here would
            # be misleading. Instead, we display it in the key.
            full_key = f"<unresolvable due to {type(exc).__name__}: {exc}>"

        object_type = OmegaConf.get_type(node)
        object_type_str = type_str(object_type)

        ref_type = get_type_hint(node)
        ref_type_str = type_str(ref_type)

    msg = string.Template(msg).safe_substitute(
        REF_TYPE=ref_type_str,
        OBJECT_TYPE=object_type_str,
        KEY=key,
        FULL_KEY=full_key,
        VALUE=value,
        VALUE_TYPE=type_str(type(value), include_module_name=True),
        KEY_TYPE=f"{type(key).__name__}",
    )

    if ref_type not in (None, Any):
        template = dedent(
            """\
            $MSG
                full_key: $FULL_KEY
                reference_type=$REF_TYPE
                object_type=$OBJECT_TYPE"""
        )
    else:
        template = dedent(
            """\
            $MSG
                full_key: $FULL_KEY
                object_type=$OBJECT_TYPE"""
        )
    s = string.Template(template=template)

    message = s.substitute(
        REF_TYPE=ref_type_str, OBJECT_TYPE=object_type_str, MSG=msg, FULL_KEY=full_key
    )
    exception_type = type(cause) if type_override is None else type_override
    if exception_type == TypeError:
        exception_type = ConfigTypeError
    elif exception_type == IndexError:
        exception_type = ConfigIndexError

    ex = exception_type(f"{message}")
    if issubclass(exception_type, OmegaConfBaseException):
        ex._initialized = True
        ex.msg = message
        ex.parent_node = node
        ex.child_node = child_node
        ex.key = key
        ex.full_key = full_key
        ex.value = value
        ex.object_type = object_type
        ex.object_type_str = object_type_str
        ex.ref_type = ref_type
        ex.ref_type_str = ref_type_str

    _raise(ex, cause)


def type_str(t: Any, include_module_name: bool = False) -> str:
    is_optional, t = _resolve_optional(t)
    if t is NoneType:
        return str(t.__name__)
    if t is Any:
        return "Any"
    if t is ...:
        return "..."

    if hasattr(t, "__name__"):
        name = str(t.__name__)
    elif getattr(t, "_name", None) is not None:  # pragma: no cover
        name = str(t._name)
    elif getattr(t, "__origin__", None) is not None:  # pragma: no cover
        name = type_str(t.__origin__)
    else:
        name = str(t)
        if name.startswith("typing."):  # pragma: no cover
            name = name[len("typing.") :]

    args = getattr(t, "__args__", None)
    if args is not None:
        args = ", ".join(
            [type_str(t, include_module_name=include_module_name) for t in t.__args__]
        )
        ret = f"{name}[{args}]"
    else:
        ret = name
    if include_module_name:
        if (
            hasattr(t, "__module__")
            and t.__module__ != "builtins"
            and t.__module__ != "typing"
            and not t.__module__.startswith("omegaconf.")
        ):
            module_prefix = str(t.__module__) + "."
        else:
            module_prefix = ""
        ret = module_prefix + ret
    if is_optional:
        return f"Optional[{ret}]"
    else:
        return ret


def _ensure_container(target: Any, flags: Optional[Dict[str, bool]] = None) -> Any:
    from omegaconf import OmegaConf

    if is_primitive_container(target):
        assert isinstance(target, (list, dict))
        target = OmegaConf.create(target, flags=flags)
    elif is_structured_config(target):
        target = OmegaConf.structured(target, flags=flags)
    elif not OmegaConf.is_config(target):
        raise ValueError(
            "Invalid input. Supports one of "
            + "[dict,list,DictConfig,ListConfig,dataclass,dataclass instance,attr class,attr class instance]"
        )

    return target


def is_generic_list(type_: Any) -> bool:
    """
    Checks if a type is a generic list, for example:
    list returns False
    typing.List returns False
    typing.List[T] returns True

    :param type_: variable type
    :return: bool
    """
    return is_list_annotation(type_) and get_list_element_type(type_) is not None


def is_generic_dict(type_: Any) -> bool:
    """
    Checks if a type is a generic dict, for example:
    list returns False
    typing.List returns False
    typing.List[T] returns True

    :param type_: variable type
    :return: bool
    """
    return is_dict_annotation(type_) and len(get_dict_key_value_types(type_)) > 0


def is_container_annotation(type_: Any) -> bool:
    return is_list_annotation(type_) or is_dict_annotation(type_)


def split_key(key: str) -> List[str]:
    """
    Split a full key path into its individual components.

    This is similar to `key.split(".")` but also works with the getitem syntax:
        "a.b"       -> ["a", "b"]
        "a[b]"      -> ["a", "b"]
        ".a.b[c].d" -> ["", "a", "b", "c", "d"]
        "[a].b"     -> ["a", "b"]
    """
    # Obtain the first part of the key (in docstring examples: a, a, .a, '')
    first = KEY_PATH_HEAD.match(key)
    assert first is not None
    first_stop = first.span()[1]

    # `tokens` will contain all elements composing the key.
    tokens = key[0:first_stop].split(".")

    # Optimization in case `key` has no other component: we are done.
    if first_stop == len(key):
        return tokens

    if key[first_stop] == "[" and not tokens[-1]:
        # This is a special case where the first key starts with brackets, e.g.
        # [a] or ..[a]. In that case there is an extra "" in `tokens` that we
        # need to get rid of:
        #   [a]   -> tokens = [""] but we would like []
        #   ..[a] -> tokens = ["", "", ""] but we would like ["", ""]
        tokens.pop()

    # Identify other key elements (in docstring examples: b, b, b/c/d, b)
    others = KEY_PATH_OTHER.findall(key[first_stop:])

    # There are two groups in the `KEY_PATH_OTHER` regex: one for keys starting
    # with a dot (.b, .d) and one for keys starting with a bracket ([b], [c]).
    # Only one group can be non-empty.
    tokens += [dot_key if dot_key else bracket_key for dot_key, bracket_key in others]

    return tokens


# Similar to Python 3.7+'s `contextlib.nullcontext` (which should be used instead,
# once support for Python 3.6 is dropped).
@contextmanager
def nullcontext(enter_result: Any = None) -> Iterator[Any]:
    yield enter_result
