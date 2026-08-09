from typing import Any, Optional, Type


class OmegaConfBaseException(Exception):
    # would ideally be typed Optional[Node]
    parent_node: Any
    child_node: Any
    key: Any
    full_key: Optional[str]
    value: Any
    msg: Optional[str]
    cause: Optional[Exception]
    object_type: Optional[Type[Any]]
    object_type_str: Optional[str]
    ref_type: Optional[Type[Any]]
    ref_type_str: Optional[str]

    _initialized: bool = False

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        self.parent_node = None
        self.child_node = None
        self.key = None
        self.full_key = None
        self.value = None
        self.msg = None
        self.object_type = None
        self.ref_type = None


class MissingMandatoryValue(OmegaConfBaseException):
    """Thrown when a variable flagged with '???' value is accessed to
    indicate that the value was not set"""


class KeyValidationError(OmegaConfBaseException, ValueError):
    """
    Thrown when an a key of invalid type is used
    """


class ValidationError(OmegaConfBaseException, ValueError):
    """
    Thrown when a value fails validation
    """


class UnsupportedValueType(ValidationError, ValueError):
    """
    Thrown when an input value is not of supported type
    """


class ReadonlyConfigError(OmegaConfBaseException):
    """
    Thrown when someone tries to modify a frozen config
    """


class InterpolationResolutionError(OmegaConfBaseException, ValueError):
    """
    Base class for exceptions raised when resolving an interpolation.
    """


class UnsupportedInterpolationType(InterpolationResolutionError):
    """
    Thrown when an attempt to use an unregistered interpolation is made
    """


class InterpolationKeyError(InterpolationResolutionError):
    """
    Thrown when a node does not exist when resolving an interpolation.
    """


class InterpolationToMissingValueError(InterpolationResolutionError):
    """
    Thrown when a node interpolation points to a node that is set to ???.
    """


class InterpolationValidationError(InterpolationResolutionError, ValidationError):
    """
    Thrown when the result of an interpolation fails the validation step.
    """


class ConfigKeyError(OmegaConfBaseException, KeyError):
    """
    Thrown from DictConfig when a regular dict access would have caused a KeyError.
    """

    msg: str

    def __init__(self, msg: str) -> None:
        super().__init__(msg)
        self.msg = msg

    def __str__(self) -> str:
        """
        Workaround to nasty KeyError quirk: https://bugs.python.org/issue2651
        """
        return self.msg


class ConfigAttributeError(OmegaConfBaseException, AttributeError):
    """
    Thrown from a config object when a regular access would have caused an AttributeError.
    """


class ConfigTypeError(OmegaConfBaseException, TypeError):
    """
    Thrown from a config object when a regular access would have caused a TypeError.
    """


class ConfigIndexError(OmegaConfBaseException, IndexError):
    """
    Thrown from a config object when a regular access would have caused an IndexError.
    """


class ConfigValueError(OmegaConfBaseException, ValueError):
    """
    Thrown from a config object when a regular access would have caused a ValueError.
    """


class ConfigCycleDetectedException(OmegaConfBaseException):
    """
    Thrown when a cycle is detected in the graph made by config nodes.
    """


class GrammarParseError(OmegaConfBaseException):
    """
    Thrown when failing to parse an expression according to the ANTLR grammar.
    """
