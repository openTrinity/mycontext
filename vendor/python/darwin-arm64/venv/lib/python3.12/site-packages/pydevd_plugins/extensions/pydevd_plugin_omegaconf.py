# based on https://github.com/fabioz/PyDev.Debugger/tree/main/pydevd_plugins/extensions
import os
import sys
from typing import Any, Dict

from _pydevd_bundle.pydevd_extension_api import (  # type: ignore
    StrPresentationProvider,
    TypeResolveProvider,
)

DEBUG = False


def print_debug(msg: str) -> None:  # pragma: no cover
    if DEBUG:
        print(msg)


def find_mod_attr(mod_name: str, attr: str) -> Any:
    mod = sys.modules.get(mod_name)
    return getattr(mod, attr, None)


class OmegaConfDeveloperResolver(object):
    def can_provide(self, type_object: Any, type_name: str) -> bool:
        Node = find_mod_attr("omegaconf", "Node")
        return Node is not None and issubclass(type_object, Node)

    def resolve(self, obj: Any, attribute: str) -> Any:
        return getattr(obj, attribute)

    def get_dictionary(self, obj: Any) -> Any:
        return obj.__dict__


class OmegaConfUserResolver(StrPresentationProvider):  # type: ignore
    def __init__(self) -> None:
        self.Node = find_mod_attr("omegaconf", "Node")
        self.ValueNode = find_mod_attr("omegaconf", "ValueNode")
        self.ListConfig = find_mod_attr("omegaconf", "ListConfig")
        self.DictConfig = find_mod_attr("omegaconf", "DictConfig")
        self.InterpolationResolutionError = find_mod_attr(
            "omegaconf.errors", "InterpolationResolutionError"
        )

    def can_provide(self, type_object: Any, type_name: str) -> bool:
        return self.Node is not None and issubclass(type_object, self.Node)

    def resolve(self, obj: Any, attribute: Any) -> Any:
        if isinstance(obj, self.ListConfig) and isinstance(attribute, str):
            attribute = int(attribute)

        if isinstance(obj, self.Node):
            obj = obj._dereference_node()

        val = obj.__dict__["_content"][attribute]

        print_debug(
            f"resolving {obj} ({type(obj).__name__}), {attribute} -> {val} ({type(val).__name__})"
        )

        return val

    def _is_simple_value(self, val: Any) -> bool:
        return (
            isinstance(val, self.ValueNode)
            and not val._is_none()
            and not val._is_missing()
            and not val._is_interpolation()
        )

    def get_dictionary(self, obj: Any) -> Dict[str, Any]:
        d = self._get_dictionary(obj)
        print_debug(f"get_dictionary {obj}, ({type(obj).__name__}) -> {d}")
        return d

    def _get_dictionary(self, obj: Any) -> Dict[str, Any]:
        if isinstance(obj, self.Node):
            obj = obj._maybe_dereference_node()
            if obj is None or obj._is_none() or obj._is_missing():
                return {}

        if isinstance(obj, self.DictConfig):
            d = {}
            for k, v in obj.__dict__["_content"].items():
                if self._is_simple_value(v):
                    v = v._value()
                d[k] = v
        elif isinstance(obj, self.ListConfig):
            d = {}
            for idx, v in enumerate(obj.__dict__["_content"]):
                if self._is_simple_value(v):
                    v = v._value()
                d[str(idx)] = v
        else:
            d = {}

        return d

    def get_str(self, val: Any) -> str:
        if val._is_missing():
            return "??? <MISSING>"
        if val._is_interpolation():
            try:
                dr = val._dereference_node()
            except self.InterpolationResolutionError as e:
                dr = f"ERR: {e}"
            return f"{val._value()} -> {dr}"
        else:
            return f"{val}"


# OC_PYDEVD_RESOLVER env can take:
#  DISABLE: Do not install a pydevd resolver
#  USER: Install a resolver for OmegaConf users (default)
#  DEV: Install a resolver for OmegaConf developers. Shows underlying data-model in the debugger.
resolver = os.environ.get("OC_PYDEVD_RESOLVER", "USER").upper()
if resolver != "DISABLE":  # pragma: no cover
    if resolver == "USER":
        TypeResolveProvider.register(OmegaConfUserResolver)
    elif resolver == "DEV":
        TypeResolveProvider.register(OmegaConfDeveloperResolver)
    else:
        sys.stderr.write(
            f"OmegaConf pydev plugin: Not installing. Unknown mode {resolver}. Supported one of [USER, DEV, DISABLE]\n"
        )
