import copy
import sys
from abc import ABC, abstractmethod
from enum import Enum
from typing import TYPE_CHECKING, Any, ClassVar, Dict, List, Optional, Tuple, Union

import yaml

from ._utils import (
    _DEFAULT_MARKER_,
    ValueKind,
    _ensure_container,
    _get_value,
    _is_interpolation,
    _is_missing_value,
    _is_none,
    _is_special,
    _resolve_optional,
    get_structured_config_data,
    get_type_hint,
    get_value_kind,
    get_yaml_loader,
    is_container_annotation,
    is_dict_annotation,
    is_list_annotation,
    is_primitive_dict,
    is_primitive_type_annotation,
    is_structured_config,
    is_tuple_annotation,
    is_union_annotation,
)
from .base import (
    Box,
    Container,
    ContainerMetadata,
    DictKeyType,
    Node,
    SCMode,
    UnionNode,
)
from .errors import (
    ConfigCycleDetectedException,
    ConfigTypeError,
    InterpolationResolutionError,
    KeyValidationError,
    MissingMandatoryValue,
    OmegaConfBaseException,
    ReadonlyConfigError,
    ValidationError,
)

if TYPE_CHECKING:
    from .dictconfig import DictConfig  # pragma: no cover


class BaseContainer(Container, ABC):
    _resolvers: ClassVar[Dict[str, Any]] = {}

    def __init__(self, parent: Optional[Box], metadata: ContainerMetadata):
        if not (parent is None or isinstance(parent, Box)):
            raise ConfigTypeError("Parent type is not omegaconf.Box")
        super().__init__(parent=parent, metadata=metadata)

    def _get_child(
        self,
        key: Any,
        validate_access: bool = True,
        validate_key: bool = True,
        throw_on_missing_value: bool = False,
        throw_on_missing_key: bool = False,
    ) -> Union[Optional[Node], List[Optional[Node]]]:
        """Like _get_node, passing through to the nearest concrete Node."""
        child = self._get_node(
            key=key,
            validate_access=validate_access,
            validate_key=validate_key,
            throw_on_missing_value=throw_on_missing_value,
            throw_on_missing_key=throw_on_missing_key,
        )
        if isinstance(child, UnionNode) and not _is_special(child):
            value = child._value()
            assert isinstance(value, Node) and not isinstance(value, UnionNode)
            child = value
        return child

    def _resolve_with_default(
        self,
        key: Union[DictKeyType, int],
        value: Node,
        default_value: Any = _DEFAULT_MARKER_,
    ) -> Any:
        """returns the value with the specified key, like obj.key and obj['key']"""
        if _is_missing_value(value):
            if default_value is not _DEFAULT_MARKER_:
                return default_value
            raise MissingMandatoryValue("Missing mandatory value: $FULL_KEY")

        resolved_node = self._maybe_resolve_interpolation(
            parent=self,
            key=key,
            value=value,
            throw_on_resolution_failure=True,
        )

        return _get_value(resolved_node)

    def __str__(self) -> str:
        return self.__repr__()

    def __repr__(self) -> str:
        if self.__dict__["_content"] is None:
            return "None"
        elif self._is_interpolation() or self._is_missing():
            v = self.__dict__["_content"]
            return f"'{v}'"
        else:
            return self.__dict__["_content"].__repr__()  # type: ignore

    # Support pickle
    def __getstate__(self) -> Dict[str, Any]:
        dict_copy = copy.copy(self.__dict__)

        # no need to serialize the flags cache, it can be re-constructed later
        dict_copy.pop("_flags_cache", None)

        dict_copy["_metadata"] = copy.copy(dict_copy["_metadata"])
        ref_type = self._metadata.ref_type
        if is_container_annotation(ref_type):
            if is_dict_annotation(ref_type):
                dict_copy["_metadata"].ref_type = Dict
            elif is_list_annotation(ref_type):
                dict_copy["_metadata"].ref_type = List
            else:
                assert False
        if sys.version_info < (3, 7):  # pragma: no cover
            element_type = self._metadata.element_type
            if is_union_annotation(element_type):
                raise OmegaConfBaseException(
                    "Serializing structured configs with `Union` element type requires python >= 3.7"
                )
        return dict_copy

    # Support pickle
    def __setstate__(self, d: Dict[str, Any]) -> None:
        from omegaconf import DictConfig
        from omegaconf._utils import is_generic_dict, is_generic_list

        if isinstance(self, DictConfig):
            key_type = d["_metadata"].key_type

            # backward compatibility to load OmegaConf 2.0 configs
            if key_type is None:
                key_type = Any
                d["_metadata"].key_type = key_type

        element_type = d["_metadata"].element_type

        # backward compatibility to load OmegaConf 2.0 configs
        if element_type is None:
            element_type = Any
            d["_metadata"].element_type = element_type

        ref_type = d["_metadata"].ref_type
        if is_container_annotation(ref_type):
            if is_generic_dict(ref_type):
                d["_metadata"].ref_type = Dict[key_type, element_type]  # type: ignore
            elif is_generic_list(ref_type):
                d["_metadata"].ref_type = List[element_type]  # type: ignore
            else:
                assert False

        d["_flags_cache"] = None
        self.__dict__.update(d)

    @abstractmethod
    def __delitem__(self, key: Any) -> None:
        ...

    def __len__(self) -> int:
        if self._is_none() or self._is_missing() or self._is_interpolation():
            return 0
        content = self.__dict__["_content"]
        return len(content)

    def merge_with_cli(self) -> None:
        args_list = sys.argv[1:]
        self.merge_with_dotlist(args_list)

    def merge_with_dotlist(self, dotlist: List[str]) -> None:
        from omegaconf import OmegaConf

        def fail() -> None:
            raise ValueError("Input list must be a list or a tuple of strings")

        if not isinstance(dotlist, (list, tuple)):
            fail()

        for arg in dotlist:
            if not isinstance(arg, str):
                fail()

            idx = arg.find("=")
            if idx == -1:
                key = arg
                value = None
            else:
                key = arg[0:idx]
                value = arg[idx + 1 :]
                value = yaml.load(value, Loader=get_yaml_loader())

            OmegaConf.update(self, key, value)

    def is_empty(self) -> bool:
        """return true if config is empty"""
        return len(self.__dict__["_content"]) == 0

    @staticmethod
    def _to_content(
        conf: Container,
        resolve: bool,
        throw_on_missing: bool,
        enum_to_str: bool = False,
        structured_config_mode: SCMode = SCMode.DICT,
    ) -> Union[None, Any, str, Dict[DictKeyType, Any], List[Any]]:
        from omegaconf import MISSING, DictConfig, ListConfig

        def convert(val: Node) -> Any:
            value = val._value()
            if enum_to_str and isinstance(value, Enum):
                value = f"{value.name}"

            return value

        def get_node_value(key: Union[DictKeyType, int]) -> Any:
            try:
                node = conf._get_child(key, throw_on_missing_value=throw_on_missing)
            except MissingMandatoryValue as e:
                conf._format_and_raise(key=key, value=None, cause=e)
            assert isinstance(node, Node)
            if resolve:
                try:
                    node = node._dereference_node()
                except InterpolationResolutionError as e:
                    conf._format_and_raise(key=key, value=None, cause=e)

            if isinstance(node, Container):
                value = BaseContainer._to_content(
                    node,
                    resolve=resolve,
                    throw_on_missing=throw_on_missing,
                    enum_to_str=enum_to_str,
                    structured_config_mode=structured_config_mode,
                )
            else:
                value = convert(node)
            return value

        if conf._is_none():
            return None
        elif conf._is_missing():
            if throw_on_missing:
                conf._format_and_raise(
                    key=None,
                    value=None,
                    cause=MissingMandatoryValue("Missing mandatory value"),
                )
            else:
                return MISSING
        elif not resolve and conf._is_interpolation():
            inter = conf._value()
            assert isinstance(inter, str)
            return inter

        if resolve:
            _conf = conf._dereference_node()
            assert isinstance(_conf, Container)
            conf = _conf

        if isinstance(conf, DictConfig):
            if (
                conf._metadata.object_type not in (dict, None)
                and structured_config_mode == SCMode.DICT_CONFIG
            ):
                return conf
            if structured_config_mode == SCMode.INSTANTIATE and is_structured_config(
                conf._metadata.object_type
            ):
                return conf._to_object()

            retdict: Dict[DictKeyType, Any] = {}
            for key in conf.keys():
                value = get_node_value(key)
                if enum_to_str and isinstance(key, Enum):
                    key = f"{key.name}"
                retdict[key] = value
            return retdict
        elif isinstance(conf, ListConfig):
            retlist: List[Any] = []
            for index in range(len(conf)):
                item = get_node_value(index)
                retlist.append(item)

            return retlist
        assert False

    @staticmethod
    def _map_merge(dest: "BaseContainer", src: "BaseContainer") -> None:
        """merge src into dest and return a new copy, does not modified input"""
        from omegaconf import AnyNode, DictConfig, ValueNode

        assert isinstance(dest, DictConfig)
        assert isinstance(src, DictConfig)
        src_type = src._metadata.object_type
        src_ref_type = get_type_hint(src)
        assert src_ref_type is not None

        # If source DictConfig is:
        #  - None => set the destination DictConfig to None
        #  - an interpolation => set the destination DictConfig to be the same interpolation
        if src._is_none() or src._is_interpolation():
            dest._set_value(src._value())
            _update_types(node=dest, ref_type=src_ref_type, object_type=src_type)
            return

        dest._validate_merge(value=src)

        def expand(node: Container) -> None:
            rt = node._metadata.ref_type
            val: Any
            if rt is not Any:
                if is_dict_annotation(rt):
                    val = {}
                elif is_list_annotation(rt) or is_tuple_annotation(rt):
                    val = []
                else:
                    val = rt
            elif isinstance(node, DictConfig):
                val = {}
            else:
                assert False

            node._set_value(val)

        if (
            src._is_missing()
            and not dest._is_missing()
            and is_structured_config(src_ref_type)
        ):
            # Replace `src` with a prototype of its corresponding structured config
            # whose fields are all missing (to avoid overwriting fields in `dest`).
            assert src_type is None  # src missing, so src's object_type should be None
            src_type = src_ref_type
            src = _create_structured_with_missing_fields(
                ref_type=src_ref_type, object_type=src_type
            )

        if (dest._is_interpolation() or dest._is_missing()) and not src._is_missing():
            expand(dest)

        src_items = list(src) if not src._is_missing() else []
        for key in src_items:
            src_node = src._get_node(key, validate_access=False)
            dest_node = dest._get_node(key, validate_access=False)
            assert isinstance(src_node, Node)
            assert dest_node is None or isinstance(dest_node, Node)
            src_value = _get_value(src_node)

            src_vk = get_value_kind(src_node)
            src_node_missing = src_vk is ValueKind.MANDATORY_MISSING

            if isinstance(dest_node, DictConfig):
                dest_node._validate_merge(value=src_node)

            if (
                isinstance(dest_node, Container)
                and dest_node._is_none()
                and not src_node_missing
                and not _is_none(src_node, resolve=True)
            ):
                expand(dest_node)

            if dest_node is not None and dest_node._is_interpolation():
                target_node = dest_node._maybe_dereference_node()
                if isinstance(target_node, Container):
                    dest[key] = target_node
                    dest_node = dest._get_node(key)

            is_optional, et = _resolve_optional(dest._metadata.element_type)
            if dest_node is None and is_structured_config(et) and not src_node_missing:
                # merging into a new node. Use element_type as a base
                dest[key] = DictConfig(
                    et, parent=dest, ref_type=et, is_optional=is_optional
                )
                dest_node = dest._get_node(key)

            if dest_node is not None:
                if isinstance(dest_node, BaseContainer):
                    if isinstance(src_node, BaseContainer):
                        dest_node._merge_with(src_node)
                    elif not src_node_missing:
                        dest.__setitem__(key, src_node)
                else:
                    if isinstance(src_node, BaseContainer):
                        dest.__setitem__(key, src_node)
                    else:
                        assert isinstance(dest_node, (ValueNode, UnionNode))
                        assert isinstance(src_node, (ValueNode, UnionNode))
                        try:
                            if isinstance(dest_node, AnyNode):
                                if src_node_missing:
                                    node = copy.copy(src_node)
                                    # if src node is missing, use the value from the dest_node,
                                    # but validate it against the type of the src node before assigment
                                    node._set_value(dest_node._value())
                                else:
                                    node = src_node
                                dest.__setitem__(key, node)
                            else:
                                if not src_node_missing:
                                    dest_node._set_value(src_value)

                        except (ValidationError, ReadonlyConfigError) as e:
                            dest._format_and_raise(key=key, value=src_value, cause=e)
            else:
                from omegaconf import open_dict

                if is_structured_config(src_type):
                    # verified to be compatible above in _validate_merge
                    with open_dict(dest):
                        dest[key] = src._get_node(key)
                else:
                    dest[key] = src._get_node(key)

        _update_types(node=dest, ref_type=src_ref_type, object_type=src_type)

        # explicit flags on the source config are replacing the flag values in the destination
        flags = src._metadata.flags
        assert flags is not None
        for flag, value in flags.items():
            if value is not None:
                dest._set_flag(flag, value)

    @staticmethod
    def _list_merge(dest: Any, src: Any) -> None:
        from omegaconf import DictConfig, ListConfig, OmegaConf

        assert isinstance(dest, ListConfig)
        assert isinstance(src, ListConfig)

        if src._is_none():
            dest._set_value(None)
        elif src._is_missing():
            # do not change dest if src is MISSING.
            if dest._metadata.element_type is Any:
                dest._metadata.element_type = src._metadata.element_type
        elif src._is_interpolation():
            dest._set_value(src._value())
        else:
            temp_target = ListConfig(content=[], parent=dest._get_parent())
            temp_target.__dict__["_metadata"] = copy.deepcopy(
                dest.__dict__["_metadata"]
            )
            is_optional, et = _resolve_optional(dest._metadata.element_type)
            if is_structured_config(et):
                prototype = DictConfig(et, ref_type=et, is_optional=is_optional)
                for item in src._iter_ex(resolve=False):
                    if isinstance(item, DictConfig):
                        item = OmegaConf.merge(prototype, item)
                    temp_target.append(item)
            else:
                for item in src._iter_ex(resolve=False):
                    temp_target.append(item)

            dest.__dict__["_content"] = temp_target.__dict__["_content"]

        # explicit flags on the source config are replacing the flag values in the destination
        flags = src._metadata.flags
        assert flags is not None
        for flag, value in flags.items():
            if value is not None:
                dest._set_flag(flag, value)

    def merge_with(
        self,
        *others: Union[
            "BaseContainer", Dict[str, Any], List[Any], Tuple[Any, ...], Any
        ],
    ) -> None:
        try:
            self._merge_with(*others)
        except Exception as e:
            self._format_and_raise(key=None, value=None, cause=e)

    def _merge_with(
        self,
        *others: Union[
            "BaseContainer", Dict[str, Any], List[Any], Tuple[Any, ...], Any
        ],
    ) -> None:
        from .dictconfig import DictConfig
        from .listconfig import ListConfig

        """merge a list of other Config objects into this one, overriding as needed"""
        for other in others:
            if other is None:
                raise ValueError("Cannot merge with a None config")

            my_flags = {}
            if self._get_flag("allow_objects") is True:
                my_flags = {"allow_objects": True}
            other = _ensure_container(other, flags=my_flags)

            if isinstance(self, DictConfig) and isinstance(other, DictConfig):
                BaseContainer._map_merge(self, other)
            elif isinstance(self, ListConfig) and isinstance(other, ListConfig):
                BaseContainer._list_merge(self, other)
            else:
                raise TypeError("Cannot merge DictConfig with ListConfig")

        # recursively correct the parent hierarchy after the merge
        self._re_parent()

    # noinspection PyProtectedMember
    def _set_item_impl(self, key: Any, value: Any) -> None:
        """
        Changes the value of the node key with the desired value. If the node key doesn't
        exist it creates a new one.
        """
        from .nodes import AnyNode, ValueNode

        if isinstance(value, Node):
            do_deepcopy = not self._get_flag("no_deepcopy_set_nodes")
            if not do_deepcopy and isinstance(value, Box):
                # if value is from the same config, perform a deepcopy no matter what.
                if self._get_root() is value._get_root():
                    do_deepcopy = True

            if do_deepcopy:
                value = copy.deepcopy(value)
            value._set_parent(None)

            try:
                old = value._key()
                value._set_key(key)
                self._validate_set(key, value)
            finally:
                value._set_key(old)
        else:
            self._validate_set(key, value)

        if self._get_flag("readonly"):
            raise ReadonlyConfigError("Cannot change read-only config container")

        input_is_node = isinstance(value, Node)
        target_node_ref = self._get_node(key)
        assert target_node_ref is None or isinstance(target_node_ref, Node)

        input_is_typed_vnode = isinstance(value, ValueNode) and not isinstance(
            value, AnyNode
        )

        def get_target_type_hint(val: Any) -> Any:
            if not is_structured_config(val):
                type_hint = self._metadata.element_type
            else:
                target = self._get_node(key)
                if target is None:
                    type_hint = self._metadata.element_type
                else:
                    assert isinstance(target, Node)
                    type_hint = target._metadata.type_hint
            return type_hint

        target_type_hint = get_target_type_hint(value)
        _, target_ref_type = _resolve_optional(target_type_hint)

        def assign(value_key: Any, val: Node) -> None:
            assert val._get_parent() is None
            v = val
            v._set_parent(self)
            v._set_key(value_key)
            _deep_update_type_hint(node=v, type_hint=self._metadata.element_type)
            self.__dict__["_content"][value_key] = v

        if input_is_typed_vnode and not is_union_annotation(target_ref_type):
            assign(key, value)
        else:
            # input is not a ValueNode, can be primitive or box

            special_value = _is_special(value)
            # We use the `Node._set_value` method if the target node exists and:
            # 1. the target has an explicit ref_type, or
            # 2. the target is an AnyNode and the input is a primitive type.
            should_set_value = target_node_ref is not None and (
                target_node_ref._has_ref_type()
                or (
                    isinstance(target_node_ref, AnyNode)
                    and is_primitive_type_annotation(value)
                )
            )
            if should_set_value:
                if special_value and isinstance(value, Node):
                    value = value._value()
                self.__dict__["_content"][key]._set_value(value)
            elif input_is_node:
                if (
                    special_value
                    and (
                        is_container_annotation(target_ref_type)
                        or is_structured_config(target_ref_type)
                    )
                    or is_primitive_type_annotation(target_ref_type)
                    or is_union_annotation(target_ref_type)
                ):
                    value = _get_value(value)
                    self._wrap_value_and_set(key, value, target_type_hint)
                else:
                    assign(key, value)
            else:
                self._wrap_value_and_set(key, value, target_type_hint)

    def _wrap_value_and_set(self, key: Any, val: Any, type_hint: Any) -> None:
        from omegaconf.omegaconf import _maybe_wrap

        is_optional, ref_type = _resolve_optional(type_hint)

        try:
            wrapped = _maybe_wrap(
                ref_type=ref_type,
                key=key,
                value=val,
                is_optional=is_optional,
                parent=self,
            )
        except ValidationError as e:
            self._format_and_raise(key=key, value=val, cause=e)
        self.__dict__["_content"][key] = wrapped

    @staticmethod
    def _item_eq(
        c1: Container,
        k1: Union[DictKeyType, int],
        c2: Container,
        k2: Union[DictKeyType, int],
    ) -> bool:
        v1 = c1._get_child(k1)
        v2 = c2._get_child(k2)
        assert v1 is not None and v2 is not None

        assert isinstance(v1, Node)
        assert isinstance(v2, Node)

        if v1._is_none() and v2._is_none():
            return True

        if v1._is_missing() and v2._is_missing():
            return True

        v1_inter = v1._is_interpolation()
        v2_inter = v2._is_interpolation()
        dv1: Optional[Node] = v1
        dv2: Optional[Node] = v2

        if v1_inter:
            dv1 = v1._maybe_dereference_node()
        if v2_inter:
            dv2 = v2._maybe_dereference_node()

        if v1_inter and v2_inter:
            if dv1 is None or dv2 is None:
                return v1 == v2
            else:
                # both are not none, if both are containers compare as container
                if isinstance(dv1, Container) and isinstance(dv2, Container):
                    if dv1 != dv2:
                        return False
                dv1 = _get_value(dv1)
                dv2 = _get_value(dv2)
                return dv1 == dv2
        elif not v1_inter and not v2_inter:
            v1 = _get_value(v1)
            v2 = _get_value(v2)
            ret = v1 == v2
            assert isinstance(ret, bool)
            return ret
        else:
            dv1 = _get_value(dv1)
            dv2 = _get_value(dv2)
            ret = dv1 == dv2
            assert isinstance(ret, bool)
            return ret

    def _is_optional(self) -> bool:
        return self.__dict__["_metadata"].optional is True

    def _is_interpolation(self) -> bool:
        return _is_interpolation(self.__dict__["_content"])

    @abstractmethod
    def _validate_get(self, key: Any, value: Any = None) -> None:
        ...

    @abstractmethod
    def _validate_set(self, key: Any, value: Any) -> None:
        ...

    def _value(self) -> Any:
        return self.__dict__["_content"]

    def _get_full_key(self, key: Union[DictKeyType, int, slice, None]) -> str:
        from .listconfig import ListConfig
        from .omegaconf import _select_one

        if not isinstance(key, (int, str, Enum, float, bool, slice, bytes, type(None))):
            return ""

        def _slice_to_str(x: slice) -> str:
            if x.step is not None:
                return f"{x.start}:{x.stop}:{x.step}"
            else:
                return f"{x.start}:{x.stop}"

        def prepand(
            full_key: str,
            parent_type: Any,
            cur_type: Any,
            key: Optional[Union[DictKeyType, int, slice]],
        ) -> str:
            if key is None:
                return full_key

            if isinstance(key, slice):
                key = _slice_to_str(key)
            elif isinstance(key, Enum):
                key = key.name
            else:
                key = str(key)

            assert isinstance(key, str)

            if issubclass(parent_type, ListConfig):
                if full_key != "":
                    if issubclass(cur_type, ListConfig):
                        full_key = f"[{key}]{full_key}"
                    else:
                        full_key = f"[{key}].{full_key}"
                else:
                    full_key = f"[{key}]"
            else:
                if full_key == "":
                    full_key = key
                else:
                    if issubclass(cur_type, ListConfig):
                        full_key = f"{key}{full_key}"
                    else:
                        full_key = f"{key}.{full_key}"
            return full_key

        if key is not None and key != "":
            assert isinstance(self, Container)
            cur, _ = _select_one(
                c=self, key=str(key), throw_on_missing=False, throw_on_type_error=False
            )
            if cur is None:
                cur = self
                full_key = prepand("", type(cur), None, key)
                if cur._key() is not None:
                    full_key = prepand(
                        full_key, type(cur._get_parent()), type(cur), cur._key()
                    )
            else:
                full_key = prepand("", type(cur._get_parent()), type(cur), cur._key())
        else:
            cur = self
            if cur._key() is None:
                return ""
            full_key = self._key()

        assert cur is not None
        memo = {id(cur)}  # remember already visited nodes so as to detect cycles
        while cur._get_parent() is not None:
            cur = cur._get_parent()
            if id(cur) in memo:
                raise ConfigCycleDetectedException(
                    f"Cycle when iterating over parents of key `{key!s}`"
                )
            memo.add(id(cur))
            assert cur is not None
            if cur._key() is not None:
                full_key = prepand(
                    full_key, type(cur._get_parent()), type(cur), cur._key()
                )

        return full_key


def _create_structured_with_missing_fields(
    ref_type: type, object_type: Optional[type] = None
) -> "DictConfig":
    from . import MISSING, DictConfig

    cfg_data = get_structured_config_data(ref_type)
    for v in cfg_data.values():
        v._set_value(MISSING)

    cfg = DictConfig(cfg_data)
    cfg._metadata.optional, cfg._metadata.ref_type = _resolve_optional(ref_type)
    cfg._metadata.object_type = object_type

    return cfg


def _update_types(node: Node, ref_type: Any, object_type: Optional[type]) -> None:
    if object_type is not None and not is_primitive_dict(object_type):
        node._metadata.object_type = object_type

    if node._metadata.ref_type is Any:
        _deep_update_type_hint(node, ref_type)


def _deep_update_type_hint(node: Node, type_hint: Any) -> None:
    """Ensure node is compatible with type_hint, mutating if necessary."""
    from omegaconf import DictConfig, ListConfig

    from ._utils import get_dict_key_value_types, get_list_element_type

    if type_hint is Any:
        return

    _shallow_validate_type_hint(node, type_hint)

    new_is_optional, new_ref_type = _resolve_optional(type_hint)
    node._metadata.ref_type = new_ref_type
    node._metadata.optional = new_is_optional

    if is_list_annotation(new_ref_type) and isinstance(node, ListConfig):
        new_element_type = get_list_element_type(new_ref_type)
        node._metadata.element_type = new_element_type
        if not _is_special(node):
            for i in range(len(node)):
                _deep_update_subnode(node, i, new_element_type)

    if is_dict_annotation(new_ref_type) and isinstance(node, DictConfig):
        new_key_type, new_element_type = get_dict_key_value_types(new_ref_type)
        node._metadata.key_type = new_key_type
        node._metadata.element_type = new_element_type
        if not _is_special(node):
            for key in node:
                if new_key_type is not Any and not isinstance(key, new_key_type):
                    raise KeyValidationError(
                        f"Key {key!r} ({type(key).__name__}) is incompatible"
                        + f" with key type hint '{new_key_type.__name__}'"
                    )
                _deep_update_subnode(node, key, new_element_type)


def _deep_update_subnode(node: BaseContainer, key: Any, value_type_hint: Any) -> None:
    """Get node[key] and ensure it is compatible with value_type_hint, mutating if necessary."""
    subnode = node._get_node(key)
    assert isinstance(subnode, Node)
    if _is_special(subnode):
        # Ensure special values are wrapped in a Node subclass that
        # is compatible with the type hint.
        node._wrap_value_and_set(key, subnode._value(), value_type_hint)
        subnode = node._get_node(key)
        assert isinstance(subnode, Node)
    _deep_update_type_hint(subnode, value_type_hint)


def _shallow_validate_type_hint(node: Node, type_hint: Any) -> None:
    """Error if node's type, content and metadata are not compatible with type_hint."""
    from omegaconf import DictConfig, ListConfig, ValueNode

    is_optional, ref_type = _resolve_optional(type_hint)

    vk = get_value_kind(node)

    if node._is_none():
        if not is_optional:
            value = _get_value(node)
            raise ValidationError(
                f"Value {value!r} ({type(value).__name__})"
                + f" is incompatible with type hint '{ref_type.__name__}'"
            )
        return
    elif vk in (ValueKind.MANDATORY_MISSING, ValueKind.INTERPOLATION):
        return
    elif vk == ValueKind.VALUE:
        if is_primitive_type_annotation(ref_type) and isinstance(node, ValueNode):
            value = node._value()
            if not isinstance(value, ref_type):
                raise ValidationError(
                    f"Value {value!r} ({type(value).__name__})"
                    + f" is incompatible with type hint '{ref_type.__name__}'"
                )
        elif is_structured_config(ref_type) and isinstance(node, DictConfig):
            return
        elif is_dict_annotation(ref_type) and isinstance(node, DictConfig):
            return
        elif is_list_annotation(ref_type) and isinstance(node, ListConfig):
            return
        else:
            if isinstance(node, ValueNode):
                value = node._value()
                raise ValidationError(
                    f"Value {value!r} ({type(value).__name__})"
                    + f" is incompatible with type hint '{ref_type}'"
                )
            else:
                raise ValidationError(
                    f"'{type(node).__name__}' is incompatible"
                    + f" with type hint '{ref_type}'"
                )

    else:
        assert False
