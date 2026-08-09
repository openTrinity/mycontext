from __future__ import annotations

import os
import sys
from importlib import import_module
from typing import Any

_CAPI_MODULE: Any | None = None
_PYBIND_MODULE: Any | None = None
_PYBIND_IMPORT_ATTEMPTED = False


def _import_pybind_module() -> Any:
    if sys.platform != "linux":
        return import_module("._lbug", __package__)

    original_dlopen_flags = sys.getdlopenflags()
    try:
        # Keep pybind's symbols visible to any transitive native extensions
        # without affecting the process-wide import path for the C-API backend.
        sys.setdlopenflags(os.RTLD_GLOBAL | os.RTLD_LAZY)
        return import_module("._lbug", __package__)
    finally:
        sys.setdlopenflags(original_dlopen_flags)


def get_capi_module() -> Any:
    global _CAPI_MODULE
    if _CAPI_MODULE is None:
        _CAPI_MODULE = import_module("._lbug_capi", __package__)
    return _CAPI_MODULE


def get_pybind_module() -> Any | None:
    global _PYBIND_MODULE, _PYBIND_IMPORT_ATTEMPTED
    if _PYBIND_IMPORT_ATTEMPTED:
        return _PYBIND_MODULE
    _PYBIND_IMPORT_ATTEMPTED = True
    try:
        _PYBIND_MODULE = _import_pybind_module()
    except ImportError:
        _PYBIND_MODULE = None
    return _PYBIND_MODULE
