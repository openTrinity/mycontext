import copy
import math
import sys
from abc import abstractmethod
from enum import Enum
from pathlib import Path
from typing import Any, Dict, Optional, Type, Union

from omegaconf._utils import (
    ValueKind,
    _is_interpolation,
    get_type_of,
    get_value_kind,
    is_primitive_container,
    type_str,
)
from omegaconf.base import Box, DictKeyType, Metadata, Node
from omegaconf.errors import ReadonlyConfigError, UnsupportedValueType, ValidationError


class ValueNode(Node):
    _val: Any

    def __init__(self, parent: Optional[Box], value: Any, metadata: Metadata):
        from omegaconf import read_write

        super().__init__(parent=parent, metadata=metadata)
        with read_write(self):
            self._set_value(value)  # lgtm [py/init-calls-subclass]

    def _value(self) -> Any:
        return self._val

    def _set_value(self, value: Any, flags: Optional[Dict[str, bool]] = None) -> None:
        if self._get_flag("readonly"):
            raise ReadonlyConfigError("Cannot set value of read-only config node")

        if isinstance(value, str) and get_value_kind(
            value, strict_interpolation_validation=True
        ) in (
            ValueKind.INTERPOLATION,
            ValueKind.MANDATORY_MISSING,
        ):
            self._val = value
        else:
            self._val = self.validate_and_convert(value)

    def _strict_validate_type(self, value: Any) -> None:
        ref_type = self._metadata.ref_type
        if isinstance(ref_type, type) and type(value) is not ref_type:
            type_hint = type_str(self._metadata.type_hint)
            raise ValidationError(
                f"Value '$VALUE' of type '$VALUE_TYPE' is incompatible with type hint '{type_hint}'"
            )

    def validate_and_convert(self, value: Any) -> Any:
        """
        Validates input and converts to canonical form
        :param value: input value
        :return: converted value ("100" may be converted to 100 for example)
        """
        if value is None:
            if self._is_optional():
                return None
            ref_type_str = type_str(self._metadata.ref_type)
            raise ValidationError(
                f"Incompatible value '{value}' for field of type '{ref_type_str}'"
            )

        # Subclasses can assume that `value` is not None in
        # `_validate_and_convert_impl()` and in `_strict_validate_type()`.
        if self._get_flag("convert") is False:
            self._strict_validate_type(value)
            return value
        else:
            return self._validate_and_convert_impl(value)

    @abstractmethod
    def _validate_and_convert_impl(self, value: Any) -> Any:
        ...

    def __str__(self) -> str:
        return str(self._val)

    def __repr__(self) -> str:
        return repr(self._val) if hasattr(self, "_val") else "__INVALID__"

    def __eq__(self, other: Any) -> bool:
        if isinstance(other, AnyNode):
            return self._val == other._val  # type: ignore
        else:
            return self._val == other  # type: ignore

    def __ne__(self, other: Any) -> bool:
        x = self.__eq__(other)
        assert x is not NotImplemented
        return not x

    def __hash__(self) -> int:
        return hash(self._val)

    def _deepcopy_impl(self, res: Any, memo: Dict[int, Any]) -> None:
        res.__dict__["_metadata"] = copy.deepcopy(self._metadata, memo=memo)
        # shallow copy for value to support non-copyable value
        res.__dict__["_val"] = self._val

        # parent is retained, but not copied
        res.__dict__["_parent"] = self._parent

    def _is_optional(self) -> bool:
        return self._metadata.optional

    def _is_interpolation(self) -> bool:
        return _is_interpolation(self._value())

    def _get_full_key(self, key: Optional[Union[DictKeyType, int]]) -> str:
        parent = self._get_parent()
        if parent is None:
            if self._metadata.key is None:
                return ""
            else:
                return str(self._metadata.key)
        else:
            return parent._get_full_key(self._metadata.key)


class AnyNode(ValueNode):
    def __init__(
        self,
        value: Any = None,
        key: Any = None,
        parent: Optional[Box] = None,
        flags: Optional[Dict[str, bool]] = None,
    ):
        super().__init__(
            parent=parent,
            value=value,
            metadata=Metadata(
                ref_type=Any, object_type=None, key=key, optional=True, flags=flags
            ),
        )

    def _validate_and_convert_impl(self, value: Any) -> Any:
        from ._utils import is_primitive_type_annotation

        # allow_objects is internal and not an official API. use at your own risk.
        # Please be aware that this support is subject to change without notice.
        # If this is deemed useful and supportable it may become an official API.

        if self._get_flag(
            "allow_objects"
        ) is not True and not is_primitive_type_annotation(value):
            t = get_type_of(value)
            raise UnsupportedValueType(
                f"Value '{t.__name__}' is not a supported primitive type"
            )
        return value

    def __deepcopy__(self, memo: Dict[int, Any]) -> "AnyNode":
        res = AnyNode()
        self._deepcopy_impl(res, memo)
        return res


class StringNode(ValueNode):
    def __init__(
        self,
        value: Any = None,
        key: Any = None,
        parent: Optional[Box] = None,
        is_optional: bool = True,
        flags: Optional[Dict[str, bool]] = None,
    ):
        super().__init__(
            parent=parent,
            value=value,
            metadata=Metadata(
                key=key,
                optional=is_optional,
                ref_type=str,
                object_type=str,
                flags=flags,
            ),
        )

    def _validate_and_convert_impl(self, value: Any) -> str:
        from omegaconf import OmegaConf

        if (
            OmegaConf.is_config(value)
            or is_primitive_container(value)
            or isinstance(value, bytes)
        ):
            raise ValidationError("Cannot convert '$VALUE_TYPE' to string: '$VALUE'")
        return str(value)

    def __deepcopy__(self, memo: Dict[int, Any]) -> "StringNode":
        res = StringNode()
        self._deepcopy_impl(res, memo)
        return res


class PathNode(ValueNode):
    def __init__(
        self,
        value: Any = None,
        key: Any = None,
        parent: Optional[Box] = None,
        is_optional: bool = True,
        flags: Optional[Dict[str, bool]] = None,
    ):
        super().__init__(
            parent=parent,
            value=value,
            metadata=Metadata(
                key=key,
                optional=is_optional,
                ref_type=Path,
                object_type=Path,
                flags=flags,
            ),
        )

    def _strict_validate_type(self, value: Any) -> None:
        if not isinstance(value, Path):
            raise ValidationError(
                "Value '$VALUE' of type '$VALUE_TYPE' is not an instance of 'pathlib.Path'"
            )

    def _validate_and_convert_impl(self, value: Any) -> Path:
        if not isinstance(value, (str, Path)):
            raise ValidationError(
                "Value '$VALUE' of type '$VALUE_TYPE' could not be converted to Path"
            )

        return Path(value)

    def __deepcopy__(self, memo: Dict[int, Any]) -> "PathNode":
        res = PathNode()
        self._deepcopy_impl(res, memo)
        return res


class IntegerNode(ValueNode):
    def __init__(
        self,
        value: Any = None,
        key: Any = None,
        parent: Optional[Box] = None,
        is_optional: bool = True,
        flags: Optional[Dict[str, bool]] = None,
    ):
        super().__init__(
            parent=parent,
            value=value,
            metadata=Metadata(
                key=key,
                optional=is_optional,
                ref_type=int,
                object_type=int,
                flags=flags,
            ),
        )

    def _validate_and_convert_impl(self, value: Any) -> int:
        try:
            if type(value) in (str, int):
                val = int(value)
            else:
                raise ValueError()
        except ValueError:
            raise ValidationError(
                "Value '$VALUE' of type '$VALUE_TYPE' could not be converted to Integer"
            )
        return val

    def __deepcopy__(self, memo: Dict[int, Any]) -> "IntegerNode":
        res = IntegerNode()
        self._deepcopy_impl(res, memo)
        return res


class BytesNode(ValueNode):
    def __init__(
        self,
        value: Any = None,
        key: Any = None,
        parent: Optional[Box] = None,
        is_optional: bool = True,
        flags: Optional[Dict[str, bool]] = None,
    ):
        super().__init__(
            parent=parent,
            value=value,
            metadata=Metadata(
                key=key,
                optional=is_optional,
                ref_type=bytes,
                object_type=bytes,
                flags=flags,
            ),
        )

    def _validate_and_convert_impl(self, value: Any) -> bytes:
        if not isinstance(value, bytes):
            raise ValidationError(
                "Value '$VALUE' of type '$VALUE_TYPE' is not of type 'bytes'"
            )
        return value

    def __deepcopy__(self, memo: Dict[int, Any]) -> "BytesNode":
        res = BytesNode()
        self._deepcopy_impl(res, memo)
        return res


class FloatNode(ValueNode):
    def __init__(
        self,
        value: Any = None,
        key: Any = None,
        parent: Optional[Box] = None,
        is_optional: bool = True,
        flags: Optional[Dict[str, bool]] = None,
    ):
        super().__init__(
            parent=parent,
            value=value,
            metadata=Metadata(
                key=key,
                optional=is_optional,
                ref_type=float,
                object_type=float,
                flags=flags,
            ),
        )

    def _validate_and_convert_impl(self, value: Any) -> float:
        try:
            if type(value) in (float, str, int):
                return float(value)
            else:
                raise ValueError()
        except ValueError:
            raise ValidationError(
                "Value '$VALUE' of type '$VALUE_TYPE' could not be converted to Float"
            )

    def __eq__(self, other: Any) -> bool:
        if isinstance(other, ValueNode):
            other_val = other._val
        else:
            other_val = other
        if self._val is None and other is None:
            return True
        if self._val is None and other is not None:
            return False
        if self._val is not None and other is None:
            return False
        nan1 = math.isnan(self._val) if isinstance(self._val, float) else False
        nan2 = math.isnan(other_val) if isinstance(other_val, float) else False
        return self._val == other_val or (nan1 and nan2)

    def __hash__(self) -> int:
        return hash(self._val)

    def __deepcopy__(self, memo: Dict[int, Any]) -> "FloatNode":
        res = FloatNode()
        self._deepcopy_impl(res, memo)
        return res


class BooleanNode(ValueNode):
    def __init__(
        self,
        value: Any = None,
        key: Any = None,
        parent: Optional[Box] = None,
        is_optional: bool = True,
        flags: Optional[Dict[str, bool]] = None,
    ):
        super().__init__(
            parent=parent,
            value=value,
            metadata=Metadata(
                key=key,
                optional=is_optional,
                ref_type=bool,
                object_type=bool,
                flags=flags,
            ),
        )

    def _validate_and_convert_impl(self, value: Any) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, int):
            return value != 0
        elif isinstance(value, str):
            try:
                return self._validate_and_convert_impl(int(value))
            except ValueError as e:
                if value.lower() in ("yes", "y", "on", "true"):
                    return True
                elif value.lower() in ("no", "n", "off", "false"):
                    return False
                else:
                    raise ValidationError(
                        "Value '$VALUE' is not a valid bool (type $VALUE_TYPE)"
                    ).with_traceback(sys.exc_info()[2]) from e
        else:
            raise ValidationError(
                "Value '$VALUE' is not a valid bool (type $VALUE_TYPE)"
            )

    def __deepcopy__(self, memo: Dict[int, Any]) -> "BooleanNode":
        res = BooleanNode()
        self._deepcopy_impl(res, memo)
        return res


class EnumNode(ValueNode):  # lgtm [py/missing-equals] : Intentional.
    """
    NOTE: EnumNode is serialized to yaml as a string ("Color.BLUE"), not as a fully qualified yaml type.
    this means serialization to YAML of a typed config (with EnumNode) will not retain the type of the Enum
    when loaded.
    This is intentional, Please open an issue against OmegaConf if you wish to discuss this decision.
    """

    def __init__(
        self,
        enum_type: Type[Enum],
        value: Optional[Union[Enum, str]] = None,
        key: Any = None,
        parent: Optional[Box] = None,
        is_optional: bool = True,
        flags: Optional[Dict[str, bool]] = None,
    ):
        if not isinstance(enum_type, type) or not issubclass(enum_type, Enum):
            raise ValidationError(
                f"EnumNode can only operate on Enum subclasses ({enum_type})"
            )
        self.fields: Dict[str, str] = {}
        self.enum_type: Type[Enum] = enum_type
        for name, constant in enum_type.__members__.items():
            self.fields[name] = constant.value
        super().__init__(
            parent=parent,
            value=value,
            metadata=Metadata(
                key=key,
                optional=is_optional,
                ref_type=enum_type,
                object_type=enum_type,
                flags=flags,
            ),
        )

    def _strict_validate_type(self, value: Any) -> None:
        ref_type = self._metadata.ref_type
        if not isinstance(value, ref_type):
            type_hint = type_str(self._metadata.type_hint)
            raise ValidationError(
                f"Value '$VALUE' of type '$VALUE_TYPE' is incompatible with type hint '{type_hint}'"
            )

    def _validate_and_convert_impl(self, value: Any) -> Enum:
        return self.validate_and_convert_to_enum(enum_type=self.enum_type, value=value)

    @staticmethod
    def validate_and_convert_to_enum(enum_type: Type[Enum], value: Any) -> Enum:
        if not isinstance(value, (str, int)) and not isinstance(value, enum_type):
            raise ValidationError(
                f"Value $VALUE ($VALUE_TYPE) is not a valid input for {enum_type}"
            )

        if isinstance(value, enum_type):
            return value

        try:
            if isinstance(value, (float, bool)):
                raise ValueError

            if isinstance(value, int):
                return enum_type(value)

            if isinstance(value, str):
                prefix = f"{enum_type.__name__}."
                if value.startswith(prefix):
                    value = value[len(prefix) :]
                return enum_type[value]

            assert False

        except (ValueError, KeyError) as e:
            valid = ", ".join([x for x in enum_type.__members__.keys()])
            raise ValidationError(
                f"Invalid value '$VALUE', expected one of [{valid}]"
            ).with_traceback(sys.exc_info()[2]) from e

    def __deepcopy__(self, memo: Dict[int, Any]) -> "EnumNode":
        res = EnumNode(enum_type=self.enum_type)
        self._deepcopy_impl(res, memo)
        return res


class InterpolationResultNode(ValueNode):
    """
    Special node type, used to wrap interpolation results.
    """

    def __init__(
        self,
        value: Any,
        key: Any = None,
        parent: Optional[Box] = None,
        flags: Optional[Dict[str, bool]] = None,
    ):
        super().__init__(
            parent=parent,
            value=value,
            metadata=Metadata(
                ref_type=Any, object_type=None, key=key, optional=True, flags=flags
            ),
        )
        # In general we should not try to write into interpolation results.
        if flags is None or "readonly" not in flags:
            self._set_flag("readonly", True)

    def _set_value(self, value: Any, flags: Optional[Dict[str, bool]] = None) -> None:
        if self._get_flag("readonly"):
            raise ReadonlyConfigError("Cannot set value of read-only config node")
        self._val = self.validate_and_convert(value)

    def _validate_and_convert_impl(self, value: Any) -> Any:
        # Interpolation results may be anything.
        return value

    def __deepcopy__(self, memo: Dict[int, Any]) -> "InterpolationResultNode":
        # Currently there should be no need to deep-copy such nodes.
        raise NotImplementedError

    def _is_interpolation(self) -> bool:
        # The result of an interpolation cannot be itself an interpolation.
        return False
