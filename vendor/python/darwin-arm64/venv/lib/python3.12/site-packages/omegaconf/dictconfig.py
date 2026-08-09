import copy
from enum import Enum
from typing import (
    Any,
    Dict,
    ItemsView,
    Iterable,
    Iterator,
    KeysView,
    List,
    MutableMapping,
    Optional,
    Sequence,
    Tuple,
    Type,
    Union,
)

from ._utils import (
    _DEFAULT_MARKER_,
    ValueKind,
    _get_value,
    _is_interpolation,
    _is_missing_literal,
    _is_missing_value,
    _is_none,
    _resolve_optional,
    _valid_dict_key_annotation_type,
    format_and_raise,
    get_structured_config_data,
    get_structured_config_init_field_names,
    get_type_of,
    get_value_kind,
    is_container_annotation,
    is_dict,
    is_primitive_dict,
    is_structured_config,
    is_structured_config_frozen,
    type_str,
)
from .base import Box, Container, ContainerMetadata, DictKeyType, Node
from .basecontainer import BaseContainer
from .errors import (
    ConfigAttributeError,
    ConfigKeyError,
    ConfigTypeError,
    InterpolationResolutionError,
    KeyValidationError,
    MissingMandatoryValue,
    OmegaConfBaseException,
    ReadonlyConfigError,
    ValidationError,
)
from .nodes import EnumNode, ValueNode


class DictConfig(BaseContainer, MutableMapping[Any, Any]):

    _metadata: ContainerMetadata
    _content: Union[Dict[DictKeyType, Node], None, str]

    def __init__(
        self,
        content: Union[Dict[DictKeyType, Any], "DictConfig", Any],
        key: Any = None,
        parent: Optional[Box] = None,
        ref_type: Union[Any, Type[Any]] = Any,
        key_type: Union[Any, Type[Any]] = Any,
        element_type: Union[Any, Type[Any]] = Any,
        is_optional: bool = True,
        flags: Optional[Dict[str, bool]] = None,
    ) -> None:
        try:
            if isinstance(content, DictConfig):
                if flags is None:
                    flags = content._metadata.flags
            super().__init__(
                parent=parent,
                metadata=ContainerMetadata(
                    key=key,
                    optional=is_optional,
                    ref_type=ref_type,
                    object_type=dict,
                    key_type=key_type,
                    element_type=element_type,
                    flags=flags,
                ),
            )

            if not _valid_dict_key_annotation_type(key_type):
                raise KeyValidationError(f"Unsupported key type {key_type}")

            if is_structured_config(content) or is_structured_config(ref_type):
                self._set_value(content, flags=flags)
                if is_structured_config_frozen(content) or is_structured_config_frozen(
                    ref_type
                ):
                    self._set_flag("readonly", True)

            else:
                if isinstance(content, DictConfig):
                    metadata = copy.deepcopy(content._metadata)
                    metadata.key = key
                    metadata.ref_type = ref_type
                    metadata.optional = is_optional
                    metadata.element_type = element_type
                    metadata.key_type = key_type
                    self.__dict__["_metadata"] = metadata
                self._set_value(content, flags=flags)
        except Exception as ex:
            format_and_raise(node=None, key=key, value=None, cause=ex, msg=str(ex))

    def __deepcopy__(self, memo: Dict[int, Any]) -> "DictConfig":
        res = DictConfig(None)
        res.__dict__["_metadata"] = copy.deepcopy(self.__dict__["_metadata"], memo=memo)
        res.__dict__["_flags_cache"] = copy.deepcopy(
            self.__dict__["_flags_cache"], memo=memo
        )

        src_content = self.__dict__["_content"]
        if isinstance(src_content, dict):
            content_copy = {}
            for k, v in src_content.items():
                old_parent = v.__dict__["_parent"]
                try:
                    v.__dict__["_parent"] = None
                    vc = copy.deepcopy(v, memo=memo)
                    vc.__dict__["_parent"] = res
                    content_copy[k] = vc
                finally:
                    v.__dict__["_parent"] = old_parent
        else:
            # None and strings can be assigned as is
            content_copy = src_content

        res.__dict__["_content"] = content_copy
        # parent is retained, but not copied
        res.__dict__["_parent"] = self.__dict__["_parent"]
        return res

    def copy(self) -> "DictConfig":
        return copy.copy(self)

    def _is_typed(self) -> bool:
        return self._metadata.object_type not in (Any, None) and not is_dict(
            self._metadata.object_type
        )

    def _validate_get(self, key: Any, value: Any = None) -> None:
        is_typed = self._is_typed()

        is_struct = self._get_flag("struct") is True
        if key not in self.__dict__["_content"]:
            if is_typed:
                # do not raise an exception if struct is explicitly set to False
                if self._get_node_flag("struct") is False:
                    return
            if is_typed or is_struct:
                if is_typed:
                    assert self._metadata.object_type not in (dict, None)
                    msg = f"Key '{key}' not in '{self._metadata.object_type.__name__}'"
                else:
                    msg = f"Key '{key}' is not in struct"
                self._format_and_raise(
                    key=key, value=value, cause=ConfigAttributeError(msg)
                )

    def _validate_set(self, key: Any, value: Any) -> None:
        from omegaconf import OmegaConf

        vk = get_value_kind(value)
        if vk == ValueKind.INTERPOLATION:
            return
        if _is_none(value):
            self._validate_non_optional(key, value)
            return
        if vk == ValueKind.MANDATORY_MISSING or value is None:
            return

        target = self._get_node(key) if key is not None else self

        target_has_ref_type = isinstance(
            target, DictConfig
        ) and target._metadata.ref_type not in (Any, dict)
        is_valid_target = target is None or not target_has_ref_type

        if is_valid_target:
            return

        assert isinstance(target, Node)

        target_type = target._metadata.ref_type
        value_type = OmegaConf.get_type(value)

        if is_dict(value_type) and is_dict(target_type):
            return
        if is_container_annotation(target_type) and not is_container_annotation(
            value_type
        ):
            raise ValidationError(
                f"Cannot assign {type_str(value_type)} to {type_str(target_type)}"
            )

        if target_type is not None and value_type is not None:
            origin = getattr(target_type, "__origin__", target_type)
            if not issubclass(value_type, origin):
                self._raise_invalid_value(value, value_type, target_type)

    def _validate_merge(self, value: Any) -> None:
        from omegaconf import OmegaConf

        dest = self
        src = value

        self._validate_non_optional(None, src)

        dest_obj_type = OmegaConf.get_type(dest)
        src_obj_type = OmegaConf.get_type(src)

        if dest._is_missing() and src._metadata.object_type not in (dict, None):
            self._validate_set(key=None, value=_get_value(src))

        if src._is_missing():
            return

        validation_error = (
            dest_obj_type is not None
            and src_obj_type is not None
            and is_structured_config(dest_obj_type)
            and not src._is_none()
            and not is_dict(src_obj_type)
            and not issubclass(src_obj_type, dest_obj_type)
        )
        if validation_error:
            msg = (
                f"Merge error: {type_str(src_obj_type)} is not a "
                f"subclass of {type_str(dest_obj_type)}. value: {src}"
            )
            raise ValidationError(msg)

    def _validate_non_optional(self, key: Optional[DictKeyType], value: Any) -> None:
        if _is_none(value, resolve=True, throw_on_resolution_failure=False):

            if key is not None:
                child = self._get_node(key)
                if child is not None:
                    assert isinstance(child, Node)
                    field_is_optional = child._is_optional()
                else:
                    field_is_optional, _ = _resolve_optional(
                        self._metadata.element_type
                    )
            else:
                field_is_optional = self._is_optional()

            if not field_is_optional:
                self._format_and_raise(
                    key=key,
                    value=value,
                    cause=ValidationError("field '$FULL_KEY' is not Optional"),
                )

    def _raise_invalid_value(
        self, value: Any, value_type: Any, target_type: Any
    ) -> None:
        assert value_type is not None
        assert target_type is not None
        msg = (
            f"Invalid type assigned: {type_str(value_type)} is not a "
            f"subclass of {type_str(target_type)}. value: {value}"
        )
        raise ValidationError(msg)

    def _validate_and_normalize_key(self, key: Any) -> DictKeyType:
        return self._s_validate_and_normalize_key(self._metadata.key_type, key)

    def _s_validate_and_normalize_key(self, key_type: Any, key: Any) -> DictKeyType:
        if key_type is Any:
            for t in DictKeyType.__args__:  # type: ignore
                if isinstance(key, t):
                    return key  # type: ignore
            raise KeyValidationError("Incompatible key type '$KEY_TYPE'")
        elif key_type is bool and key in [0, 1]:
            # Python treats True as 1 and False as 0 when used as dict keys
            #   assert hash(0) == hash(False)
            #   assert hash(1) == hash(True)
            return bool(key)
        elif key_type in (str, bytes, int, float, bool):  # primitive type
            if not isinstance(key, key_type):
                raise KeyValidationError(
                    f"Key $KEY ($KEY_TYPE) is incompatible with ({key_type.__name__})"
                )

            return key  # type: ignore
        elif issubclass(key_type, Enum):
            try:
                return EnumNode.validate_and_convert_to_enum(key_type, key)
            except ValidationError:
                valid = ", ".join([x for x in key_type.__members__.keys()])
                raise KeyValidationError(
                    f"Key '$KEY' is incompatible with the enum type '{key_type.__name__}', valid: [{valid}]"
                )
        else:
            assert False, f"Unsupported key type {key_type}"

    def __setitem__(self, key: DictKeyType, value: Any) -> None:
        try:
            self.__set_impl(key=key, value=value)
        except AttributeError as e:
            self._format_and_raise(
                key=key, value=value, type_override=ConfigKeyError, cause=e
            )
        except Exception as e:
            self._format_and_raise(key=key, value=value, cause=e)

    def __set_impl(self, key: DictKeyType, value: Any) -> None:
        key = self._validate_and_normalize_key(key)
        self._set_item_impl(key, value)

    # hide content while inspecting in debugger
    def __dir__(self) -> Iterable[str]:
        if self._is_missing() or self._is_none():
            return []
        return self.__dict__["_content"].keys()  # type: ignore

    def __setattr__(self, key: str, value: Any) -> None:
        """
        Allow assigning attributes to DictConfig
        :param key:
        :param value:
        :return:
        """
        try:
            self.__set_impl(key, value)
        except Exception as e:
            if isinstance(e, OmegaConfBaseException) and e._initialized:
                raise e
            self._format_and_raise(key=key, value=value, cause=e)
            assert False

    def __getattr__(self, key: str) -> Any:
        """
        Allow accessing dictionary values as attributes
        :param key:
        :return:
        """
        if key == "__name__":
            raise AttributeError()

        try:
            return self._get_impl(
                key=key, default_value=_DEFAULT_MARKER_, validate_key=False
            )
        except ConfigKeyError as e:
            self._format_and_raise(
                key=key, value=None, cause=e, type_override=ConfigAttributeError
            )
        except Exception as e:
            self._format_and_raise(key=key, value=None, cause=e)

    def __getitem__(self, key: DictKeyType) -> Any:
        """
        Allow map style access
        :param key:
        :return:
        """

        try:
            return self._get_impl(key=key, default_value=_DEFAULT_MARKER_)
        except AttributeError as e:
            self._format_and_raise(
                key=key, value=None, cause=e, type_override=ConfigKeyError
            )
        except Exception as e:
            self._format_and_raise(key=key, value=None, cause=e)

    def __delattr__(self, key: str) -> None:
        """
        Allow deleting dictionary values as attributes
        :param key:
        :return:
        """
        if self._get_flag("readonly"):
            self._format_and_raise(
                key=key,
                value=None,
                cause=ReadonlyConfigError(
                    "DictConfig in read-only mode does not support deletion"
                ),
            )
        try:
            del self.__dict__["_content"][key]
        except KeyError:
            msg = "Attribute not found: '$KEY'"
            self._format_and_raise(key=key, value=None, cause=ConfigAttributeError(msg))

    def __delitem__(self, key: DictKeyType) -> None:
        key = self._validate_and_normalize_key(key)
        if self._get_flag("readonly"):
            self._format_and_raise(
                key=key,
                value=None,
                cause=ReadonlyConfigError(
                    "DictConfig in read-only mode does not support deletion"
                ),
            )
        if self._get_flag("struct"):
            self._format_and_raise(
                key=key,
                value=None,
                cause=ConfigTypeError(
                    "DictConfig in struct mode does not support deletion"
                ),
            )
        if self._is_typed() and self._get_node_flag("struct") is not False:
            self._format_and_raise(
                key=key,
                value=None,
                cause=ConfigTypeError(
                    f"{type_str(self._metadata.object_type)} (DictConfig) does not support deletion"
                ),
            )

        try:
            del self.__dict__["_content"][key]
        except KeyError:
            msg = "Key not found: '$KEY'"
            self._format_and_raise(key=key, value=None, cause=ConfigKeyError(msg))

    def get(self, key: DictKeyType, default_value: Any = None) -> Any:
        """Return the value for `key` if `key` is in the dictionary, else
        `default_value` (defaulting to `None`)."""
        try:
            return self._get_impl(key=key, default_value=default_value)
        except KeyValidationError as e:
            self._format_and_raise(key=key, value=None, cause=e)

    def _get_impl(
        self, key: DictKeyType, default_value: Any, validate_key: bool = True
    ) -> Any:
        try:
            node = self._get_child(
                key=key, throw_on_missing_key=True, validate_key=validate_key
            )
        except (ConfigAttributeError, ConfigKeyError):
            if default_value is not _DEFAULT_MARKER_:
                return default_value
            else:
                raise
        assert isinstance(node, Node)
        return self._resolve_with_default(
            key=key, value=node, default_value=default_value
        )

    def _get_node(
        self,
        key: DictKeyType,
        validate_access: bool = True,
        validate_key: bool = True,
        throw_on_missing_value: bool = False,
        throw_on_missing_key: bool = False,
    ) -> Optional[Node]:
        try:
            key = self._validate_and_normalize_key(key)
        except KeyValidationError:
            if validate_access and validate_key:
                raise
            else:
                if throw_on_missing_key:
                    raise ConfigAttributeError
                else:
                    return None

        if validate_access:
            self._validate_get(key)

        value: Optional[Node] = self.__dict__["_content"].get(key)
        if value is None:
            if throw_on_missing_key:
                raise ConfigKeyError(f"Missing key {key!s}")
        elif throw_on_missing_value and value._is_missing():
            raise MissingMandatoryValue("Missing mandatory value: $KEY")
        return value

    def pop(self, key: DictKeyType, default: Any = _DEFAULT_MARKER_) -> Any:
        try:
            if self._get_flag("readonly"):
                raise ReadonlyConfigError("Cannot pop from read-only node")
            if self._get_flag("struct"):
                raise ConfigTypeError("DictConfig in struct mode does not support pop")
            if self._is_typed() and self._get_node_flag("struct") is not False:
                raise ConfigTypeError(
                    f"{type_str(self._metadata.object_type)} (DictConfig) does not support pop"
                )
            key = self._validate_and_normalize_key(key)
            node = self._get_child(key=key, validate_access=False)
            if node is not None:
                assert isinstance(node, Node)
                value = self._resolve_with_default(
                    key=key, value=node, default_value=default
                )

                del self[key]
                return value
            else:
                if default is not _DEFAULT_MARKER_:
                    return default
                else:
                    full = self._get_full_key(key=key)
                    if full != key:
                        raise ConfigKeyError(
                            f"Key not found: '{key!s}' (path: '{full}')"
                        )
                    else:
                        raise ConfigKeyError(f"Key not found: '{key!s}'")
        except Exception as e:
            self._format_and_raise(key=key, value=None, cause=e)

    def keys(self) -> KeysView[DictKeyType]:
        if self._is_missing() or self._is_interpolation() or self._is_none():
            return {}.keys()
        ret = self.__dict__["_content"].keys()
        assert isinstance(ret, KeysView)
        return ret

    def __contains__(self, key: object) -> bool:
        """
        A key is contained in a DictConfig if there is an associated value and
        it is not a mandatory missing value ('???').
        :param key:
        :return:
        """

        try:
            key = self._validate_and_normalize_key(key)
        except KeyValidationError:
            return False

        try:
            node = self._get_child(key)
            assert node is None or isinstance(node, Node)
        except (KeyError, AttributeError):
            node = None

        if node is None:
            return False
        else:
            try:
                self._resolve_with_default(key=key, value=node)
                return True
            except InterpolationResolutionError:
                # Interpolations that fail count as existing.
                return True
            except MissingMandatoryValue:
                # Missing values count as *not* existing.
                return False

    def __iter__(self) -> Iterator[DictKeyType]:
        return iter(self.keys())

    def items(self) -> ItemsView[DictKeyType, Any]:
        return dict(self.items_ex(resolve=True, keys=None)).items()

    def setdefault(self, key: DictKeyType, default: Any = None) -> Any:
        if key in self:
            ret = self.__getitem__(key)
        else:
            ret = default
            self.__setitem__(key, default)
        return ret

    def items_ex(
        self, resolve: bool = True, keys: Optional[Sequence[DictKeyType]] = None
    ) -> List[Tuple[DictKeyType, Any]]:
        items: List[Tuple[DictKeyType, Any]] = []

        if self._is_none():
            self._format_and_raise(
                key=None,
                value=None,
                cause=TypeError("Cannot iterate a DictConfig object representing None"),
            )
        if self._is_missing():
            raise MissingMandatoryValue("Cannot iterate a missing DictConfig")

        for key in self.keys():
            if resolve:
                value = self[key]
            else:
                value = self.__dict__["_content"][key]
                if isinstance(value, ValueNode):
                    value = value._value()
            if keys is None or key in keys:
                items.append((key, value))

        return items

    def __eq__(self, other: Any) -> bool:
        if other is None:
            return self.__dict__["_content"] is None
        if is_primitive_dict(other) or is_structured_config(other):
            other = DictConfig(other, flags={"allow_objects": True})
            return DictConfig._dict_conf_eq(self, other)
        if isinstance(other, DictConfig):
            return DictConfig._dict_conf_eq(self, other)
        if self._is_missing():
            return _is_missing_literal(other)
        return NotImplemented

    def __ne__(self, other: Any) -> bool:
        x = self.__eq__(other)
        if x is not NotImplemented:
            return not x
        return NotImplemented

    def __hash__(self) -> int:
        return hash(str(self))

    def _promote(self, type_or_prototype: Optional[Type[Any]]) -> None:
        """
        Retypes a node.
        This should only be used in rare circumstances, where you want to dynamically change
        the runtime structured-type of a DictConfig.
        It will change the type and add the additional fields based on the input class or object
        """
        if type_or_prototype is None:
            return
        if not is_structured_config(type_or_prototype):
            raise ValueError(f"Expected structured config class: {type_or_prototype}")

        from omegaconf import OmegaConf

        proto: DictConfig = OmegaConf.structured(type_or_prototype)
        object_type = proto._metadata.object_type
        # remove the type to prevent assignment validation from rejecting the promotion.
        proto._metadata.object_type = None
        self.merge_with(proto)
        # restore the type.
        self._metadata.object_type = object_type

    def _set_value(self, value: Any, flags: Optional[Dict[str, bool]] = None) -> None:
        try:
            previous_content = self.__dict__["_content"]
            self._set_value_impl(value, flags)
        except Exception as e:
            self.__dict__["_content"] = previous_content
            raise e

    def _set_value_impl(
        self, value: Any, flags: Optional[Dict[str, bool]] = None
    ) -> None:
        from omegaconf import MISSING, flag_override

        if flags is None:
            flags = {}

        assert not isinstance(value, ValueNode)
        self._validate_set(key=None, value=value)

        if _is_none(value, resolve=True):
            self.__dict__["_content"] = None
            self._metadata.object_type = None
        elif _is_interpolation(value, strict_interpolation_validation=True):
            self.__dict__["_content"] = value
            self._metadata.object_type = None
        elif _is_missing_value(value):
            self.__dict__["_content"] = MISSING
            self._metadata.object_type = None
        else:
            self.__dict__["_content"] = {}
            if is_structured_config(value):
                self._metadata.object_type = None
                ao = self._get_flag("allow_objects")
                data = get_structured_config_data(value, allow_objects=ao)
                with flag_override(self, ["struct", "readonly"], False):
                    for k, v in data.items():
                        self.__setitem__(k, v)
                self._metadata.object_type = get_type_of(value)

            elif isinstance(value, DictConfig):
                self._metadata.flags = copy.deepcopy(flags)
                with flag_override(self, ["struct", "readonly"], False):
                    for k, v in value.__dict__["_content"].items():
                        self.__setitem__(k, v)
                self._metadata.object_type = value._metadata.object_type

            elif isinstance(value, dict):
                with flag_override(self, ["struct", "readonly"], False):
                    for k, v in value.items():
                        self.__setitem__(k, v)
                self._metadata.object_type = dict

            else:  # pragma: no cover
                msg = f"Unsupported value type: {value}"
                raise ValidationError(msg)

    @staticmethod
    def _dict_conf_eq(d1: "DictConfig", d2: "DictConfig") -> bool:

        d1_none = d1.__dict__["_content"] is None
        d2_none = d2.__dict__["_content"] is None
        if d1_none and d2_none:
            return True
        if d1_none != d2_none:
            return False

        assert isinstance(d1, DictConfig)
        assert isinstance(d2, DictConfig)
        if len(d1) != len(d2):
            return False
        if d1._is_missing() or d2._is_missing():
            return d1._is_missing() is d2._is_missing()

        for k, v in d1.items_ex(resolve=False):
            if k not in d2.__dict__["_content"]:
                return False
            if not BaseContainer._item_eq(d1, k, d2, k):
                return False

        return True

    def _to_object(self) -> Any:
        """
        Instantiate an instance of `self._metadata.object_type`.
        This requires `self` to be a structured config.
        Nested subconfigs are converted by calling `OmegaConf.to_object`.
        """
        from omegaconf import OmegaConf

        object_type = self._metadata.object_type
        assert is_structured_config(object_type)
        init_field_names = set(get_structured_config_init_field_names(object_type))

        init_field_items: Dict[str, Any] = {}
        non_init_field_items: Dict[str, Any] = {}
        for k in self.keys():
            assert isinstance(k, str)
            node = self._get_child(k)
            assert isinstance(node, Node)
            try:
                node = node._dereference_node()
            except InterpolationResolutionError as e:
                self._format_and_raise(key=k, value=None, cause=e)
            if node._is_missing():
                if k not in init_field_names:
                    continue  # MISSING is ignored for init=False fields
                self._format_and_raise(
                    key=k,
                    value=None,
                    cause=MissingMandatoryValue(
                        "Structured config of type `$OBJECT_TYPE` has missing mandatory value: $KEY"
                    ),
                )
            if isinstance(node, Container):
                v = OmegaConf.to_object(node)
            else:
                v = node._value()

            if k in init_field_names:
                init_field_items[k] = v
            else:
                non_init_field_items[k] = v

        try:
            result = object_type(**init_field_items)
        except TypeError as exc:
            self._format_and_raise(
                key=None,
                value=None,
                cause=exc,
                msg="Could not create instance of `$OBJECT_TYPE`: " + str(exc),
            )

        for k, v in non_init_field_items.items():
            setattr(result, k, v)
        return result
