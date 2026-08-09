"""OmegaConf module"""
import copy
import inspect
import io
import os
import pathlib
import sys
import warnings
from collections import defaultdict
from contextlib import contextmanager
from enum import Enum
from textwrap import dedent
from typing import (
    IO,
    Any,
    Callable,
    Dict,
    Generator,
    Iterable,
    List,
    Optional,
    Set,
    Tuple,
    Type,
    Union,
    overload,
)

import yaml

from . import DictConfig, DictKeyType, ListConfig
from ._utils import (
    _DEFAULT_MARKER_,
    _ensure_container,
    _get_value,
    format_and_raise,
    get_dict_key_value_types,
    get_list_element_type,
    get_omega_conf_dumper,
    get_type_of,
    is_attr_class,
    is_dataclass,
    is_dict_annotation,
    is_int,
    is_list_annotation,
    is_primitive_container,
    is_primitive_dict,
    is_primitive_list,
    is_structured_config,
    is_tuple_annotation,
    is_union_annotation,
    nullcontext,
    split_key,
    type_str,
)
from .base import Box, Container, Node, SCMode, UnionNode
from .basecontainer import BaseContainer
from .errors import (
    MissingMandatoryValue,
    OmegaConfBaseException,
    UnsupportedInterpolationType,
    ValidationError,
)
from .nodes import (
    AnyNode,
    BooleanNode,
    BytesNode,
    EnumNode,
    FloatNode,
    IntegerNode,
    PathNode,
    StringNode,
    ValueNode,
)

MISSING: Any = "???"

Resolver = Callable[..., Any]


def II(interpolation: str) -> Any:
    """
    Equivalent to ``${interpolation}``

    :param interpolation:
    :return: input ``${node}`` with type Any
    """
    return "${" + interpolation + "}"


def SI(interpolation: str) -> Any:
    """
    Use this for String interpolation, for example ``"http://${host}:${port}"``

    :param interpolation: interpolation string
    :return: input interpolation with type ``Any``
    """
    return interpolation


def register_default_resolvers() -> None:
    from omegaconf.resolvers import oc

    OmegaConf.register_new_resolver("oc.create", oc.create)
    OmegaConf.register_new_resolver("oc.decode", oc.decode)
    OmegaConf.register_new_resolver("oc.deprecated", oc.deprecated)
    OmegaConf.register_new_resolver("oc.env", oc.env)
    OmegaConf.register_new_resolver("oc.select", oc.select)
    OmegaConf.register_new_resolver("oc.dict.keys", oc.dict.keys)
    OmegaConf.register_new_resolver("oc.dict.values", oc.dict.values)


class OmegaConf:
    """OmegaConf primary class"""

    def __init__(self) -> None:
        raise NotImplementedError("Use one of the static construction functions")

    @staticmethod
    def structured(
        obj: Any,
        parent: Optional[BaseContainer] = None,
        flags: Optional[Dict[str, bool]] = None,
    ) -> Any:
        return OmegaConf.create(obj, parent, flags)

    @staticmethod
    @overload
    def create(
        obj: str,
        parent: Optional[BaseContainer] = None,
        flags: Optional[Dict[str, bool]] = None,
    ) -> Union[DictConfig, ListConfig]:
        ...

    @staticmethod
    @overload
    def create(
        obj: Union[List[Any], Tuple[Any, ...]],
        parent: Optional[BaseContainer] = None,
        flags: Optional[Dict[str, bool]] = None,
    ) -> ListConfig:
        ...

    @staticmethod
    @overload
    def create(
        obj: DictConfig,
        parent: Optional[BaseContainer] = None,
        flags: Optional[Dict[str, bool]] = None,
    ) -> DictConfig:
        ...

    @staticmethod
    @overload
    def create(
        obj: ListConfig,
        parent: Optional[BaseContainer] = None,
        flags: Optional[Dict[str, bool]] = None,
    ) -> ListConfig:
        ...

    @staticmethod
    @overload
    def create(
        obj: Optional[Dict[Any, Any]] = None,
        parent: Optional[BaseContainer] = None,
        flags: Optional[Dict[str, bool]] = None,
    ) -> DictConfig:
        ...

    @staticmethod
    def create(  # noqa F811
        obj: Any = _DEFAULT_MARKER_,
        parent: Optional[BaseContainer] = None,
        flags: Optional[Dict[str, bool]] = None,
    ) -> Union[DictConfig, ListConfig]:
        return OmegaConf._create_impl(
            obj=obj,
            parent=parent,
            flags=flags,
        )

    @staticmethod
    def load(file_: Union[str, pathlib.Path, IO[Any]]) -> Union[DictConfig, ListConfig]:
        from ._utils import get_yaml_loader

        if isinstance(file_, (str, pathlib.Path)):
            with io.open(os.path.abspath(file_), "r", encoding="utf-8") as f:
                obj = yaml.load(f, Loader=get_yaml_loader())
        elif getattr(file_, "read", None):
            obj = yaml.load(file_, Loader=get_yaml_loader())
        else:
            raise TypeError("Unexpected file type")

        if obj is not None and not isinstance(obj, (list, dict, str)):
            raise IOError(  # pragma: no cover
                f"Invalid loaded object type: {type(obj).__name__}"
            )

        ret: Union[DictConfig, ListConfig]
        if obj is None:
            ret = OmegaConf.create()
        else:
            ret = OmegaConf.create(obj)
        return ret

    @staticmethod
    def save(
        config: Any, f: Union[str, pathlib.Path, IO[Any]], resolve: bool = False
    ) -> None:
        """
        Save as configuration object to a file

        :param config: omegaconf.Config object (DictConfig or ListConfig).
        :param f: filename or file object
        :param resolve: True to save a resolved config (defaults to False)
        """
        if is_dataclass(config) or is_attr_class(config):
            config = OmegaConf.create(config)
        data = OmegaConf.to_yaml(config, resolve=resolve)
        if isinstance(f, (str, pathlib.Path)):
            with io.open(os.path.abspath(f), "w", encoding="utf-8") as file:
                file.write(data)
        elif hasattr(f, "write"):
            f.write(data)
            f.flush()
        else:
            raise TypeError("Unexpected file type")

    @staticmethod
    def from_cli(args_list: Optional[List[str]] = None) -> DictConfig:
        if args_list is None:
            # Skip program name
            args_list = sys.argv[1:]
        return OmegaConf.from_dotlist(args_list)

    @staticmethod
    def from_dotlist(dotlist: List[str]) -> DictConfig:
        """
        Creates config from the content sys.argv or from the specified args list of not None

        :param dotlist: A list of dotlist-style strings, e.g. ``["foo.bar=1", "baz=qux"]``.
        :return: A ``DictConfig`` object created from the dotlist.
        """
        conf = OmegaConf.create()
        conf.merge_with_dotlist(dotlist)
        return conf

    @staticmethod
    def merge(
        *configs: Union[
            DictConfig,
            ListConfig,
            Dict[DictKeyType, Any],
            List[Any],
            Tuple[Any, ...],
            Any,
        ],
    ) -> Union[ListConfig, DictConfig]:
        """
        Merge a list of previously created configs into a single one

        :param configs: Input configs
        :return: the merged config object.
        """
        assert len(configs) > 0
        target = copy.deepcopy(configs[0])
        target = _ensure_container(target)
        assert isinstance(target, (DictConfig, ListConfig))

        with flag_override(target, "readonly", False):
            target.merge_with(*configs[1:])
            turned_readonly = target._get_flag("readonly") is True

        if turned_readonly:
            OmegaConf.set_readonly(target, True)

        return target

    @staticmethod
    def unsafe_merge(
        *configs: Union[
            DictConfig,
            ListConfig,
            Dict[DictKeyType, Any],
            List[Any],
            Tuple[Any, ...],
            Any,
        ],
    ) -> Union[ListConfig, DictConfig]:
        """
        Merge a list of previously created configs into a single one
        This is much faster than OmegaConf.merge() as the input configs are not copied.
        However, the input configs must not be used after this operation as will become inconsistent.

        :param configs: Input configs
        :return: the merged config object.
        """
        assert len(configs) > 0
        target = configs[0]
        target = _ensure_container(target)
        assert isinstance(target, (DictConfig, ListConfig))

        with flag_override(
            target, ["readonly", "no_deepcopy_set_nodes"], [False, True]
        ):
            target.merge_with(*configs[1:])
            turned_readonly = target._get_flag("readonly") is True

        if turned_readonly:
            OmegaConf.set_readonly(target, True)

        return target

    @staticmethod
    def register_resolver(name: str, resolver: Resolver) -> None:
        warnings.warn(
            dedent(
                """\
            register_resolver() is deprecated.
            See https://github.com/omry/omegaconf/issues/426 for migration instructions.
            """
            ),
            stacklevel=2,
        )
        return OmegaConf.legacy_register_resolver(name, resolver)

    # This function will eventually be deprecated and removed.
    @staticmethod
    def legacy_register_resolver(name: str, resolver: Resolver) -> None:
        assert callable(resolver), "resolver must be callable"
        # noinspection PyProtectedMember
        assert (
            name not in BaseContainer._resolvers
        ), f"resolver '{name}' is already registered"

        def resolver_wrapper(
            config: BaseContainer,
            parent: BaseContainer,
            node: Node,
            args: Tuple[Any, ...],
            args_str: Tuple[str, ...],
        ) -> Any:
            cache = OmegaConf.get_cache(config)[name]
            # "Un-escape " spaces and commas.
            args_unesc = [x.replace(r"\ ", " ").replace(r"\,", ",") for x in args_str]

            # Nested interpolations behave in a potentially surprising way with
            # legacy resolvers (they remain as strings, e.g., "${foo}"). If any
            # input looks like an interpolation we thus raise an exception.
            try:
                bad_arg = next(i for i in args_unesc if "${" in i)
            except StopIteration:
                pass
            else:
                raise ValueError(
                    f"Resolver '{name}' was called with argument '{bad_arg}' that appears "
                    f"to be an interpolation. Nested interpolations are not supported for "
                    f"resolvers registered with `[legacy_]register_resolver()`, please use "
                    f"`register_new_resolver()` instead (see "
                    f"https://github.com/omry/omegaconf/issues/426 for migration instructions)."
                )
            key = args_str
            val = cache[key] if key in cache else resolver(*args_unesc)
            cache[key] = val
            return val

        # noinspection PyProtectedMember
        BaseContainer._resolvers[name] = resolver_wrapper

    @staticmethod
    def register_new_resolver(
        name: str,
        resolver: Resolver,
        *,
        replace: bool = False,
        use_cache: bool = False,
    ) -> None:
        """
        Register a resolver.

        :param name: Name of the resolver.
        :param resolver: Callable whose arguments are provided in the interpolation,
            e.g., with ${foo:x,0,${y.z}} these arguments are respectively "x" (str),
            0 (int) and the value of ``y.z``.
        :param replace: If set to ``False`` (default), then a ``ValueError`` is raised if
            an existing resolver has already been registered with the same name.
            If set to ``True``, then the new resolver replaces the previous one.
            NOTE: The cache on existing config objects is not affected, use
            ``OmegaConf.clear_cache(cfg)`` to clear it.
        :param use_cache: Whether the resolver's outputs should be cached. The cache is
            based only on the string literals representing the resolver arguments, e.g.,
            ${foo:${bar}} will always return the same value regardless of the value of
            ``bar`` if the cache is enabled for ``foo``.
        """
        if not callable(resolver):
            raise TypeError("resolver must be callable")
        if not name:
            raise ValueError("cannot use an empty resolver name")

        if not replace and OmegaConf.has_resolver(name):
            raise ValueError(f"resolver '{name}' is already registered")

        try:
            sig: Optional[inspect.Signature] = inspect.signature(resolver)
        except ValueError:
            sig = None

        def _should_pass(special: str) -> bool:
            ret = sig is not None and special in sig.parameters
            if ret and use_cache:
                raise ValueError(
                    f"use_cache=True is incompatible with functions that receive the {special}"
                )
            return ret

        pass_parent = _should_pass("_parent_")
        pass_node = _should_pass("_node_")
        pass_root = _should_pass("_root_")

        def resolver_wrapper(
            config: BaseContainer,
            parent: Container,
            node: Node,
            args: Tuple[Any, ...],
            args_str: Tuple[str, ...],
        ) -> Any:
            if use_cache:
                cache = OmegaConf.get_cache(config)[name]
                try:
                    return cache[args_str]
                except KeyError:
                    pass

            # Call resolver.
            kwargs: Dict[str, Node] = {}
            if pass_parent:
                kwargs["_parent_"] = parent
            if pass_node:
                kwargs["_node_"] = node
            if pass_root:
                kwargs["_root_"] = config

            ret = resolver(*args, **kwargs)

            if use_cache:
                cache[args_str] = ret
            return ret

        # noinspection PyProtectedMember
        BaseContainer._resolvers[name] = resolver_wrapper

    @classmethod
    def has_resolver(cls, name: str) -> bool:
        return cls._get_resolver(name) is not None

    # noinspection PyProtectedMember
    @staticmethod
    def clear_resolvers() -> None:
        """
        Clear(remove) all OmegaConf resolvers, then re-register OmegaConf's default resolvers.
        """
        BaseContainer._resolvers = {}
        register_default_resolvers()

    @classmethod
    def clear_resolver(cls, name: str) -> bool:
        """
        Clear(remove) any resolver only if it exists.

        Returns a bool: True if resolver is removed and False if not removed.

        .. warning:
            This method can remove deafult resolvers as well.

        :param name: Name of the resolver.
        :return: A bool (``True`` if resolver is removed, ``False`` if not found before removing).
        """
        if cls.has_resolver(name):
            BaseContainer._resolvers.pop(name)
            return True
        else:
            # return False if resolver does not exist
            return False

    @staticmethod
    def get_cache(conf: BaseContainer) -> Dict[str, Any]:
        return conf._metadata.resolver_cache

    @staticmethod
    def set_cache(conf: BaseContainer, cache: Dict[str, Any]) -> None:
        conf._metadata.resolver_cache = copy.deepcopy(cache)

    @staticmethod
    def clear_cache(conf: BaseContainer) -> None:
        OmegaConf.set_cache(conf, defaultdict(dict, {}))

    @staticmethod
    def copy_cache(from_config: BaseContainer, to_config: BaseContainer) -> None:
        OmegaConf.set_cache(to_config, OmegaConf.get_cache(from_config))

    @staticmethod
    def set_readonly(conf: Node, value: Optional[bool]) -> None:
        # noinspection PyProtectedMember
        conf._set_flag("readonly", value)

    @staticmethod
    def is_readonly(conf: Node) -> Optional[bool]:
        # noinspection PyProtectedMember
        return conf._get_flag("readonly")

    @staticmethod
    def set_struct(conf: Container, value: Optional[bool]) -> None:
        # noinspection PyProtectedMember
        conf._set_flag("struct", value)

    @staticmethod
    def is_struct(conf: Container) -> Optional[bool]:
        # noinspection PyProtectedMember
        return conf._get_flag("struct")

    @staticmethod
    def masked_copy(conf: DictConfig, keys: Union[str, List[str]]) -> DictConfig:
        """
        Create a masked copy of of this config that contains a subset of the keys

        :param conf: DictConfig object
        :param keys: keys to preserve in the copy
        :return: The masked ``DictConfig`` object.
        """
        from .dictconfig import DictConfig

        if not isinstance(conf, DictConfig):
            raise ValueError("masked_copy is only supported for DictConfig")

        if isinstance(keys, str):
            keys = [keys]
        content = {key: value for key, value in conf.items_ex(resolve=False, keys=keys)}
        return DictConfig(content=content)

    @staticmethod
    def to_container(
        cfg: Any,
        *,
        resolve: bool = False,
        throw_on_missing: bool = False,
        enum_to_str: bool = False,
        structured_config_mode: SCMode = SCMode.DICT,
    ) -> Union[Dict[DictKeyType, Any], List[Any], None, str, Any]:
        """
        Resursively converts an OmegaConf config to a primitive container (dict or list).

        :param cfg: the config to convert
        :param resolve: True to resolve all values
        :param throw_on_missing: When True, raise MissingMandatoryValue if any missing values are present.
            When False (the default), replace missing values with the string "???" in the output container.
        :param enum_to_str: True to convert Enum keys and values to strings
        :param structured_config_mode: Specify how Structured Configs (DictConfigs backed by a dataclass) are handled.
            - By default (``structured_config_mode=SCMode.DICT``) structured configs are converted to plain dicts.
            - If ``structured_config_mode=SCMode.DICT_CONFIG``, structured config nodes will remain as DictConfig.
            - If ``structured_config_mode=SCMode.INSTANTIATE``, this function will instantiate structured configs
              (DictConfigs backed by a dataclass), by creating an instance of the underlying dataclass.

          See also OmegaConf.to_object.
        :return: A dict or a list representing this config as a primitive container.
        """
        if not OmegaConf.is_config(cfg):
            raise ValueError(
                f"Input cfg is not an OmegaConf config object ({type_str(type(cfg))})"
            )

        return BaseContainer._to_content(
            cfg,
            resolve=resolve,
            throw_on_missing=throw_on_missing,
            enum_to_str=enum_to_str,
            structured_config_mode=structured_config_mode,
        )

    @staticmethod
    def to_object(cfg: Any) -> Union[Dict[DictKeyType, Any], List[Any], None, str, Any]:
        """
        Resursively converts an OmegaConf config to a primitive container (dict or list).
        Any DictConfig objects backed by dataclasses or attrs classes are instantiated
        as instances of those backing classes.

        This is an alias for OmegaConf.to_container(..., resolve=True, throw_on_missing=True,
                                                    structured_config_mode=SCMode.INSTANTIATE)

        :param cfg: the config to convert
        :return: A dict or a list or dataclass representing this config.
        """
        return OmegaConf.to_container(
            cfg=cfg,
            resolve=True,
            throw_on_missing=True,
            enum_to_str=False,
            structured_config_mode=SCMode.INSTANTIATE,
        )

    @staticmethod
    def is_missing(cfg: Any, key: DictKeyType) -> bool:
        assert isinstance(cfg, Container)
        try:
            node = cfg._get_child(key)
            if node is None:
                return False
            assert isinstance(node, Node)
            return node._is_missing()
        except (UnsupportedInterpolationType, KeyError, AttributeError):
            return False

    @staticmethod
    def is_interpolation(node: Any, key: Optional[Union[int, str]] = None) -> bool:
        if key is not None:
            assert isinstance(node, Container)
            target = node._get_child(key)
        else:
            target = node
        if target is not None:
            assert isinstance(target, Node)
            return target._is_interpolation()
        return False

    @staticmethod
    def is_list(obj: Any) -> bool:
        from . import ListConfig

        return isinstance(obj, ListConfig)

    @staticmethod
    def is_dict(obj: Any) -> bool:
        from . import DictConfig

        return isinstance(obj, DictConfig)

    @staticmethod
    def is_config(obj: Any) -> bool:
        from . import Container

        return isinstance(obj, Container)

    @staticmethod
    def get_type(obj: Any, key: Optional[str] = None) -> Optional[Type[Any]]:
        if key is not None:
            c = obj._get_child(key)
        else:
            c = obj
        return OmegaConf._get_obj_type(c)

    @staticmethod
    def select(
        cfg: Container,
        key: str,
        *,
        default: Any = _DEFAULT_MARKER_,
        throw_on_resolution_failure: bool = True,
        throw_on_missing: bool = False,
    ) -> Any:
        """
        :param cfg: Config node to select from
        :param key: Key to select
        :param default: Default value to return if key is not found
        :param throw_on_resolution_failure: Raise an exception if an interpolation
               resolution error occurs, otherwise return None
        :param throw_on_missing: Raise an exception if an attempt to select a missing key (with the value '???')
               is made, otherwise return None
        :return: selected value or None if not found.
        """
        from ._impl import select_value

        try:
            return select_value(
                cfg=cfg,
                key=key,
                default=default,
                throw_on_resolution_failure=throw_on_resolution_failure,
                throw_on_missing=throw_on_missing,
            )
        except Exception as e:
            format_and_raise(node=cfg, key=key, value=None, cause=e, msg=str(e))

    @staticmethod
    def update(
        cfg: Container,
        key: str,
        value: Any = None,
        *,
        merge: bool = True,
        force_add: bool = False,
    ) -> None:
        """
        Updates a dot separated key sequence to a value

        :param cfg: input config to update
        :param key: key to update (can be a dot separated path)
        :param value: value to set, if value if a list or a dict it will be merged or set
            depending on merge_config_values
        :param merge: If value is a dict or a list, True (default) to merge
                      into the destination, False to replace the destination.
        :param force_add: insert the entire path regardless of Struct flag or Structured Config nodes.
        """

        split = split_key(key)
        root = cfg
        for i in range(len(split) - 1):
            k = split[i]
            # if next_root is a primitive (string, int etc) replace it with an empty map
            next_root, key_ = _select_one(root, k, throw_on_missing=False)
            if not isinstance(next_root, Container):
                if force_add:
                    with flag_override(root, "struct", False):
                        root[key_] = {}
                else:
                    root[key_] = {}
            root = root[key_]

        last = split[-1]

        assert isinstance(
            root, Container
        ), f"Unexpected type for root: {type(root).__name__}"

        last_key: Union[str, int] = last
        if isinstance(root, ListConfig):
            last_key = int(last)

        ctx = flag_override(root, "struct", False) if force_add else nullcontext()
        with ctx:
            if merge and (OmegaConf.is_config(value) or is_primitive_container(value)):
                assert isinstance(root, BaseContainer)
                node = root._get_child(last_key)
                if OmegaConf.is_config(node):
                    assert isinstance(node, BaseContainer)
                    node.merge_with(value)
                    return

            if OmegaConf.is_dict(root):
                assert isinstance(last_key, str)
                root.__setattr__(last_key, value)
            elif OmegaConf.is_list(root):
                assert isinstance(last_key, int)
                root.__setitem__(last_key, value)
            else:
                assert False

    @staticmethod
    def to_yaml(cfg: Any, *, resolve: bool = False, sort_keys: bool = False) -> str:
        """
        returns a yaml dump of this config object.

        :param cfg: Config object, Structured Config type or instance
        :param resolve: if True, will return a string with the interpolations resolved, otherwise
            interpolations are preserved
        :param sort_keys: If True, will print dict keys in sorted order. default False.
        :return: A string containing the yaml representation.
        """
        cfg = _ensure_container(cfg)
        container = OmegaConf.to_container(cfg, resolve=resolve, enum_to_str=True)
        return yaml.dump(  # type: ignore
            container,
            default_flow_style=False,
            allow_unicode=True,
            sort_keys=sort_keys,
            Dumper=get_omega_conf_dumper(),
        )

    @staticmethod
    def resolve(cfg: Container) -> None:
        """
        Resolves all interpolations in the given config object in-place.

        :param cfg: An OmegaConf container (DictConfig, ListConfig)
                    Raises a ValueError if the input object is not an OmegaConf container.
        """
        import omegaconf._impl

        if not OmegaConf.is_config(cfg):
            # Since this function is mutating the input object in-place, it doesn't make sense to
            # auto-convert the input object to an OmegaConf container
            raise ValueError(
                f"Invalid config type ({type(cfg).__name__}), expected an OmegaConf Container"
            )
        omegaconf._impl._resolve(cfg)

    @staticmethod
    def missing_keys(cfg: Any) -> Set[str]:
        """
        Returns a set of missing keys in a dotlist style.

        :param cfg: An ``OmegaConf.Container``,
                    or a convertible object via ``OmegaConf.create`` (dict, list, ...).
        :return: set of strings of the missing keys.
        :raises ValueError: On input not representing a config.
        """
        cfg = _ensure_container(cfg)
        missings: Set[str] = set()

        def gather(_cfg: Container) -> None:
            itr: Iterable[Any]
            if isinstance(_cfg, ListConfig):
                itr = range(len(_cfg))
            else:
                itr = _cfg

            for key in itr:
                if OmegaConf.is_missing(_cfg, key):
                    missings.add(_cfg._get_full_key(key))
                elif OmegaConf.is_config(_cfg[key]):
                    gather(_cfg[key])

        gather(cfg)
        return missings

    # === private === #

    @staticmethod
    def _create_impl(  # noqa F811
        obj: Any = _DEFAULT_MARKER_,
        parent: Optional[BaseContainer] = None,
        flags: Optional[Dict[str, bool]] = None,
    ) -> Union[DictConfig, ListConfig]:
        try:
            from ._utils import get_yaml_loader
            from .dictconfig import DictConfig
            from .listconfig import ListConfig

            if obj is _DEFAULT_MARKER_:
                obj = {}
            if isinstance(obj, str):
                obj = yaml.load(obj, Loader=get_yaml_loader())
                if obj is None:
                    return OmegaConf.create({}, parent=parent, flags=flags)
                elif isinstance(obj, str):
                    return OmegaConf.create({obj: None}, parent=parent, flags=flags)
                else:
                    assert isinstance(obj, (list, dict))
                    return OmegaConf.create(obj, parent=parent, flags=flags)

            else:
                if (
                    is_primitive_dict(obj)
                    or OmegaConf.is_dict(obj)
                    or is_structured_config(obj)
                    or obj is None
                ):
                    if isinstance(obj, DictConfig):
                        return DictConfig(
                            content=obj,
                            parent=parent,
                            ref_type=obj._metadata.ref_type,
                            is_optional=obj._metadata.optional,
                            key_type=obj._metadata.key_type,
                            element_type=obj._metadata.element_type,
                            flags=flags,
                        )
                    else:
                        obj_type = OmegaConf.get_type(obj)
                        key_type, element_type = get_dict_key_value_types(obj_type)
                        return DictConfig(
                            content=obj,
                            parent=parent,
                            key_type=key_type,
                            element_type=element_type,
                            flags=flags,
                        )
                elif is_primitive_list(obj) or OmegaConf.is_list(obj):
                    if isinstance(obj, ListConfig):
                        return ListConfig(
                            content=obj,
                            parent=parent,
                            element_type=obj._metadata.element_type,
                            ref_type=obj._metadata.ref_type,
                            is_optional=obj._metadata.optional,
                            flags=flags,
                        )
                    else:
                        obj_type = OmegaConf.get_type(obj)
                        element_type = get_list_element_type(obj_type)
                        return ListConfig(
                            content=obj,
                            parent=parent,
                            element_type=element_type,
                            ref_type=Any,
                            is_optional=True,
                            flags=flags,
                        )
                else:
                    if isinstance(obj, type):
                        raise ValidationError(
                            f"Input class '{obj.__name__}' is not a structured config. "
                            "did you forget to decorate it as a dataclass?"
                        )
                    else:
                        raise ValidationError(
                            f"Object of unsupported type: '{type(obj).__name__}'"
                        )
        except OmegaConfBaseException as e:
            format_and_raise(node=None, key=None, value=None, msg=str(e), cause=e)
            assert False

    @staticmethod
    def _get_obj_type(c: Any) -> Optional[Type[Any]]:
        if is_structured_config(c):
            return get_type_of(c)
        elif c is None:
            return None
        elif isinstance(c, DictConfig):
            if c._is_none():
                return None
            elif c._is_missing():
                return None
            else:
                if is_structured_config(c._metadata.object_type):
                    return c._metadata.object_type
                else:
                    return dict
        elif isinstance(c, ListConfig):
            return list
        elif isinstance(c, ValueNode):
            return type(c._value())
        elif isinstance(c, UnionNode):
            return type(_get_value(c))
        elif isinstance(c, dict):
            return dict
        elif isinstance(c, (list, tuple)):
            return list
        else:
            return get_type_of(c)

    @staticmethod
    def _get_resolver(
        name: str,
    ) -> Optional[
        Callable[
            [Container, Container, Node, Tuple[Any, ...], Tuple[str, ...]],
            Any,
        ]
    ]:
        # noinspection PyProtectedMember
        return (
            BaseContainer._resolvers[name] if name in BaseContainer._resolvers else None
        )


# register all default resolvers
register_default_resolvers()


@contextmanager
def flag_override(
    config: Node,
    names: Union[List[str], str],
    values: Union[List[Optional[bool]], Optional[bool]],
) -> Generator[Node, None, None]:
    if isinstance(names, str):
        names = [names]
    if values is None or isinstance(values, bool):
        values = [values]

    prev_states = [config._get_node_flag(name) for name in names]

    try:
        config._set_flag(names, values)
        yield config
    finally:
        config._set_flag(names, prev_states)


@contextmanager
def read_write(config: Node) -> Generator[Node, None, None]:
    prev_state = config._get_node_flag("readonly")
    try:
        OmegaConf.set_readonly(config, False)
        yield config
    finally:
        OmegaConf.set_readonly(config, prev_state)


@contextmanager
def open_dict(config: Container) -> Generator[Container, None, None]:
    prev_state = config._get_node_flag("struct")
    try:
        OmegaConf.set_struct(config, False)
        yield config
    finally:
        OmegaConf.set_struct(config, prev_state)


# === private === #


def _node_wrap(
    parent: Optional[Box],
    is_optional: bool,
    value: Any,
    key: Any,
    ref_type: Any = Any,
) -> Node:
    node: Node
    if is_dict_annotation(ref_type) or (is_primitive_dict(value) and ref_type is Any):
        key_type, element_type = get_dict_key_value_types(ref_type)
        node = DictConfig(
            content=value,
            key=key,
            parent=parent,
            ref_type=ref_type,
            is_optional=is_optional,
            key_type=key_type,
            element_type=element_type,
        )
    elif (is_list_annotation(ref_type) or is_tuple_annotation(ref_type)) or (
        type(value) in (list, tuple) and ref_type is Any
    ):
        element_type = get_list_element_type(ref_type)
        node = ListConfig(
            content=value,
            key=key,
            parent=parent,
            is_optional=is_optional,
            element_type=element_type,
            ref_type=ref_type,
        )
    elif is_structured_config(ref_type) or is_structured_config(value):
        key_type, element_type = get_dict_key_value_types(value)
        node = DictConfig(
            ref_type=ref_type,
            is_optional=is_optional,
            content=value,
            key=key,
            parent=parent,
            key_type=key_type,
            element_type=element_type,
        )
    elif is_union_annotation(ref_type):
        node = UnionNode(
            content=value,
            ref_type=ref_type,
            is_optional=is_optional,
            key=key,
            parent=parent,
        )
    elif ref_type == Any or ref_type is None:
        node = AnyNode(value=value, key=key, parent=parent)
    elif isinstance(ref_type, type) and issubclass(ref_type, Enum):
        node = EnumNode(
            enum_type=ref_type,
            value=value,
            key=key,
            parent=parent,
            is_optional=is_optional,
        )
    elif ref_type == int:
        node = IntegerNode(value=value, key=key, parent=parent, is_optional=is_optional)
    elif ref_type == float:
        node = FloatNode(value=value, key=key, parent=parent, is_optional=is_optional)
    elif ref_type == bool:
        node = BooleanNode(value=value, key=key, parent=parent, is_optional=is_optional)
    elif ref_type == str:
        node = StringNode(value=value, key=key, parent=parent, is_optional=is_optional)
    elif ref_type == bytes:
        node = BytesNode(value=value, key=key, parent=parent, is_optional=is_optional)
    elif ref_type == pathlib.Path:
        node = PathNode(value=value, key=key, parent=parent, is_optional=is_optional)
    else:
        if parent is not None and parent._get_flag("allow_objects") is True:
            if type(value) in (list, tuple):
                node = ListConfig(
                    content=value,
                    key=key,
                    parent=parent,
                    ref_type=ref_type,
                    is_optional=is_optional,
                )
            elif is_primitive_dict(value):
                node = DictConfig(
                    content=value,
                    key=key,
                    parent=parent,
                    ref_type=ref_type,
                    is_optional=is_optional,
                )
            else:
                node = AnyNode(value=value, key=key, parent=parent)
        else:
            raise ValidationError(f"Unexpected type annotation: {type_str(ref_type)}")
    return node


def _maybe_wrap(
    ref_type: Any,
    key: Any,
    value: Any,
    is_optional: bool,
    parent: Optional[BaseContainer],
) -> Node:
    # if already a node, update key and parent and return as is.
    # NOTE: that this mutate the input node!
    if isinstance(value, Node):
        value._set_key(key)
        value._set_parent(parent)
        return value
    else:
        return _node_wrap(
            ref_type=ref_type,
            parent=parent,
            is_optional=is_optional,
            value=value,
            key=key,
        )


def _select_one(
    c: Container, key: str, throw_on_missing: bool, throw_on_type_error: bool = True
) -> Tuple[Optional[Node], Union[str, int]]:
    from .dictconfig import DictConfig
    from .listconfig import ListConfig

    ret_key: Union[str, int] = key
    assert isinstance(c, Container), f"Unexpected type: {c}"
    if c._is_none():
        return None, ret_key

    if isinstance(c, DictConfig):
        assert isinstance(ret_key, str)
        val = c._get_child(ret_key, validate_access=False)
    elif isinstance(c, ListConfig):
        assert isinstance(ret_key, str)
        if not is_int(ret_key):
            if throw_on_type_error:
                raise TypeError(
                    f"Index '{ret_key}' ({type(ret_key).__name__}) is not an int"
                )
            else:
                val = None
        else:
            ret_key = int(ret_key)
            if ret_key < 0 or ret_key + 1 > len(c):
                val = None
            else:
                val = c._get_child(ret_key)
    else:
        assert False

    if val is not None:
        assert isinstance(val, Node)
        if val._is_missing():
            if throw_on_missing:
                raise MissingMandatoryValue(
                    f"Missing mandatory value: {c._get_full_key(ret_key)}"
                )
            else:
                return val, ret_key

    assert val is None or isinstance(val, Node)
    return val, ret_key
