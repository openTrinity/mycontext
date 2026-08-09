import os
import string
import warnings
from typing import Any, Optional

from omegaconf import Container, Node
from omegaconf._utils import _DEFAULT_MARKER_, _get_value
from omegaconf.basecontainer import BaseContainer
from omegaconf.errors import ConfigKeyError
from omegaconf.grammar_parser import parse
from omegaconf.resolvers.oc import dict


def create(obj: Any, _parent_: Container) -> Any:
    """Create a config object from `obj`, similar to `OmegaConf.create`"""
    from omegaconf import OmegaConf

    assert isinstance(_parent_, BaseContainer)
    return OmegaConf.create(obj, parent=_parent_)


def env(key: str, default: Any = _DEFAULT_MARKER_) -> Optional[str]:
    """
    :param key: Environment variable key
    :param default: Optional default value to use in case the key environment variable is not set.
                    If default is not a string, it is converted with str(default).
                    None default is returned as is.
    :return: The environment variable 'key'. If the environment variable is not set and a default is
            provided, the default is used. If used, the default is converted to a string with str(default).
            If the default is None, None is returned (without a string conversion).
    """
    try:
        return os.environ[key]
    except KeyError:
        if default is not _DEFAULT_MARKER_:
            return str(default) if default is not None else None
        else:
            raise KeyError(f"Environment variable '{key}' not found")


def decode(expr: Optional[str], _parent_: Container, _node_: Node) -> Any:
    """
    Parse and evaluate `expr` according to the `singleElement` rule of the grammar.

    If `expr` is `None`, then return `None`.
    """
    if expr is None:
        return None

    if not isinstance(expr, str):
        raise TypeError(
            f"`oc.decode` can only take strings or None as input, "
            f"but `{expr}` is of type {type(expr).__name__}"
        )

    parse_tree = parse(expr, parser_rule="singleElement", lexer_mode="VALUE_MODE")
    val = _parent_.resolve_parse_tree(parse_tree, node=_node_)
    return _get_value(val)


def deprecated(
    key: str,
    message: str = "'$OLD_KEY' is deprecated. Change your code and config to use '$NEW_KEY'",
    *,
    _parent_: Container,
    _node_: Node,
) -> Any:
    from omegaconf._impl import select_node

    if not isinstance(key, str):
        raise TypeError(
            f"oc.deprecated: interpolation key type is not a string ({type(key).__name__})"
        )

    if not isinstance(message, str):
        raise TypeError(
            f"oc.deprecated: interpolation message type is not a string ({type(message).__name__})"
        )

    full_key = _node_._get_full_key(key=None)
    target_node = select_node(_parent_, key, absolute_key=True)
    if target_node is None:
        raise ConfigKeyError(
            f"In oc.deprecated resolver at '{full_key}': Key not found: '{key}'"
        )
    new_key = target_node._get_full_key(key=None)
    msg = string.Template(message).safe_substitute(
        OLD_KEY=full_key,
        NEW_KEY=new_key,
    )
    warnings.warn(category=UserWarning, message=msg)
    return target_node


def select(
    key: str,
    default: Any = _DEFAULT_MARKER_,
    *,
    _parent_: Container,
) -> Any:
    from omegaconf._impl import select_value

    return select_value(cfg=_parent_, key=key, absolute_key=True, default=default)


__all__ = [
    "create",
    "decode",
    "deprecated",
    "dict",
    "env",
    "select",
]
