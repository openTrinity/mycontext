import sys
import warnings
from itertools import zip_longest
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Dict,
    Generator,
    List,
    Optional,
    Set,
    Tuple,
    Union,
)

from antlr4 import TerminalNode

from .errors import InterpolationResolutionError

if TYPE_CHECKING:
    from .base import Node  # noqa F401

try:
    from omegaconf.grammar.gen.OmegaConfGrammarLexer import OmegaConfGrammarLexer
    from omegaconf.grammar.gen.OmegaConfGrammarParser import OmegaConfGrammarParser
    from omegaconf.grammar.gen.OmegaConfGrammarParserVisitor import (
        OmegaConfGrammarParserVisitor,
    )

except ModuleNotFoundError:  # pragma: no cover
    print(
        "Error importing OmegaConf's generated parsers, run `python setup.py antlr` to regenerate.",
        file=sys.stderr,
    )
    sys.exit(1)


class GrammarVisitor(OmegaConfGrammarParserVisitor):
    def __init__(
        self,
        node_interpolation_callback: Callable[
            [str, Optional[Set[int]]],
            Optional["Node"],
        ],
        resolver_interpolation_callback: Callable[..., Any],
        memo: Optional[Set[int]],
        **kw: Dict[Any, Any],
    ):
        """
        Constructor.

        :param node_interpolation_callback: Callback function that is called when
            needing to resolve a node interpolation. This function should take a single
            string input which is the key's dot path (ex: `"foo.bar"`).

        :param resolver_interpolation_callback: Callback function that is called when
            needing to resolve a resolver interpolation. This function should accept
            three keyword arguments: `name` (str, the name of the resolver),
            `args` (tuple, the inputs to the resolver), and `args_str` (tuple,
            the string representation of the inputs to the resolver).

        :param kw: Additional keyword arguments to be forwarded to parent class.
        """
        super().__init__(**kw)
        self.node_interpolation_callback = node_interpolation_callback
        self.resolver_interpolation_callback = resolver_interpolation_callback
        self.memo = memo

    def aggregateResult(self, aggregate: List[Any], nextResult: Any) -> List[Any]:
        raise NotImplementedError

    def defaultResult(self) -> List[Any]:
        # Raising an exception because not currently used (like `aggregateResult()`).
        raise NotImplementedError

    def visitConfigKey(self, ctx: OmegaConfGrammarParser.ConfigKeyContext) -> str:
        from ._utils import _get_value

        # interpolation | ID | INTER_KEY
        assert ctx.getChildCount() == 1
        child = ctx.getChild(0)
        if isinstance(child, OmegaConfGrammarParser.InterpolationContext):
            res = _get_value(self.visitInterpolation(child))
            if not isinstance(res, str):
                raise InterpolationResolutionError(
                    f"The following interpolation is used to denote a config key and "
                    f"thus should return a string, but instead returned `{res}` of "
                    f"type `{type(res)}`: {ctx.getChild(0).getText()}"
                )
            return res
        else:
            assert isinstance(child, TerminalNode) and isinstance(
                child.symbol.text, str
            )
            return child.symbol.text

    def visitConfigValue(self, ctx: OmegaConfGrammarParser.ConfigValueContext) -> Any:
        # text EOF
        assert ctx.getChildCount() == 2
        return self.visit(ctx.getChild(0))

    def visitDictKey(self, ctx: OmegaConfGrammarParser.DictKeyContext) -> Any:
        return self._createPrimitive(ctx)

    def visitDictContainer(
        self, ctx: OmegaConfGrammarParser.DictContainerContext
    ) -> Dict[Any, Any]:
        # BRACE_OPEN (dictKeyValuePair (COMMA dictKeyValuePair)*)? BRACE_CLOSE
        assert ctx.getChildCount() >= 2
        return dict(
            self.visitDictKeyValuePair(ctx.getChild(i))
            for i in range(1, ctx.getChildCount() - 1, 2)
        )

    def visitElement(self, ctx: OmegaConfGrammarParser.ElementContext) -> Any:
        # primitive | quotedValue | listContainer | dictContainer
        assert ctx.getChildCount() == 1
        return self.visit(ctx.getChild(0))

    def visitInterpolation(
        self, ctx: OmegaConfGrammarParser.InterpolationContext
    ) -> Any:
        assert ctx.getChildCount() == 1  # interpolationNode | interpolationResolver
        return self.visit(ctx.getChild(0))

    def visitInterpolationNode(
        self, ctx: OmegaConfGrammarParser.InterpolationNodeContext
    ) -> Optional["Node"]:
        # INTER_OPEN
        # DOT*                                                     // relative interpolation?
        # (configKey | BRACKET_OPEN configKey BRACKET_CLOSE)       // foo, [foo]
        # (DOT configKey | BRACKET_OPEN configKey BRACKET_CLOSE)*  // .foo, [foo], .foo[bar], [foo].bar[baz]
        # INTER_CLOSE;

        assert ctx.getChildCount() >= 3

        inter_key_tokens = []  # parsed elements of the dot path
        for child in ctx.getChildren():
            if isinstance(child, TerminalNode):
                s = child.symbol
                if s.type in [
                    OmegaConfGrammarLexer.DOT,
                    OmegaConfGrammarLexer.BRACKET_OPEN,
                    OmegaConfGrammarLexer.BRACKET_CLOSE,
                ]:
                    inter_key_tokens.append(s.text)
                else:
                    assert s.type in (
                        OmegaConfGrammarLexer.INTER_OPEN,
                        OmegaConfGrammarLexer.INTER_CLOSE,
                    )
            else:
                assert isinstance(child, OmegaConfGrammarParser.ConfigKeyContext)
                inter_key_tokens.append(self.visitConfigKey(child))

        inter_key = "".join(inter_key_tokens)
        return self.node_interpolation_callback(inter_key, self.memo)

    def visitInterpolationResolver(
        self, ctx: OmegaConfGrammarParser.InterpolationResolverContext
    ) -> Any:

        # INTER_OPEN resolverName COLON sequence? BRACE_CLOSE
        assert 4 <= ctx.getChildCount() <= 5

        resolver_name = self.visit(ctx.getChild(1))
        maybe_seq = ctx.getChild(3)
        args = []
        args_str = []
        if isinstance(maybe_seq, TerminalNode):  # means there are no args
            assert maybe_seq.symbol.type == OmegaConfGrammarLexer.BRACE_CLOSE
        else:
            assert isinstance(maybe_seq, OmegaConfGrammarParser.SequenceContext)
            for val, txt in self.visitSequence(maybe_seq):
                args.append(val)
                args_str.append(txt)

        return self.resolver_interpolation_callback(
            name=resolver_name,
            args=tuple(args),
            args_str=tuple(args_str),
        )

    def visitDictKeyValuePair(
        self, ctx: OmegaConfGrammarParser.DictKeyValuePairContext
    ) -> Tuple[Any, Any]:
        from ._utils import _get_value

        assert ctx.getChildCount() == 3  # dictKey COLON element
        key = self.visit(ctx.getChild(0))
        colon = ctx.getChild(1)
        assert (
            isinstance(colon, TerminalNode)
            and colon.symbol.type == OmegaConfGrammarLexer.COLON
        )
        value = _get_value(self.visitElement(ctx.getChild(2)))
        return key, value

    def visitListContainer(
        self, ctx: OmegaConfGrammarParser.ListContainerContext
    ) -> List[Any]:
        # BRACKET_OPEN sequence? BRACKET_CLOSE;
        assert ctx.getChildCount() in (2, 3)
        if ctx.getChildCount() == 2:
            return []
        sequence = ctx.getChild(1)
        assert isinstance(sequence, OmegaConfGrammarParser.SequenceContext)
        return list(val for val, _ in self.visitSequence(sequence))  # ignore raw text

    def visitPrimitive(self, ctx: OmegaConfGrammarParser.PrimitiveContext) -> Any:
        return self._createPrimitive(ctx)

    def visitQuotedValue(self, ctx: OmegaConfGrammarParser.QuotedValueContext) -> str:
        # (QUOTE_OPEN_SINGLE | QUOTE_OPEN_DOUBLE) text? MATCHING_QUOTE_CLOSE
        n = ctx.getChildCount()
        assert n in [2, 3]
        return str(self.visit(ctx.getChild(1))) if n == 3 else ""

    def visitResolverName(self, ctx: OmegaConfGrammarParser.ResolverNameContext) -> str:
        from ._utils import _get_value

        # (interpolation | ID) (DOT (interpolation | ID))*
        assert ctx.getChildCount() >= 1
        items = []
        for child in list(ctx.getChildren())[::2]:
            if isinstance(child, TerminalNode):
                assert child.symbol.type == OmegaConfGrammarLexer.ID
                items.append(child.symbol.text)
            else:
                assert isinstance(child, OmegaConfGrammarParser.InterpolationContext)
                item = _get_value(self.visitInterpolation(child))
                if not isinstance(item, str):
                    raise InterpolationResolutionError(
                        f"The name of a resolver must be a string, but the interpolation "
                        f"{child.getText()} resolved to `{item}` which is of type "
                        f"{type(item)}"
                    )
                items.append(item)
        return ".".join(items)

    def visitSequence(
        self, ctx: OmegaConfGrammarParser.SequenceContext
    ) -> Generator[Any, None, None]:
        from ._utils import _get_value

        # (element (COMMA element?)*) | (COMMA element?)+
        assert ctx.getChildCount() >= 1

        # DEPRECATED: remove in 2.2 (revert #571)
        def empty_str_warning() -> None:
            txt = ctx.getText()
            warnings.warn(
                f"In the sequence `{txt}` some elements are missing: please replace "
                f"them with empty quoted strings. "
                f"See https://github.com/omry/omegaconf/issues/572 for details.",
                category=UserWarning,
            )

        is_previous_comma = True  # whether previous child was a comma (init to True)
        for child in ctx.getChildren():
            if isinstance(child, OmegaConfGrammarParser.ElementContext):
                # Also preserve the original text representation of `child` so
                # as to allow backward compatibility with old resolvers (registered
                # with `legacy_register_resolver()`). Note that we cannot just cast
                # the value to string later as for instance `null` would become "None".
                yield _get_value(self.visitElement(child)), child.getText()
                is_previous_comma = False
            else:
                assert (
                    isinstance(child, TerminalNode)
                    and child.symbol.type == OmegaConfGrammarLexer.COMMA
                )
                if is_previous_comma:
                    empty_str_warning()
                    yield "", ""
                else:
                    is_previous_comma = True
        if is_previous_comma:
            # Trailing comma.
            empty_str_warning()
            yield "", ""

    def visitSingleElement(
        self, ctx: OmegaConfGrammarParser.SingleElementContext
    ) -> Any:
        # element EOF
        assert ctx.getChildCount() == 2
        return self.visit(ctx.getChild(0))

    def visitText(self, ctx: OmegaConfGrammarParser.TextContext) -> Any:
        # (interpolation | ANY_STR | ESC | ESC_INTER | TOP_ESC | QUOTED_ESC)+

        # Single interpolation? If yes, return its resolved value "as is".
        if ctx.getChildCount() == 1:
            c = ctx.getChild(0)
            if isinstance(c, OmegaConfGrammarParser.InterpolationContext):
                return self.visitInterpolation(c)

        # Otherwise, concatenate string representations together.
        return self._unescape(list(ctx.getChildren()))

    def _createPrimitive(
        self,
        ctx: Union[
            OmegaConfGrammarParser.PrimitiveContext,
            OmegaConfGrammarParser.DictKeyContext,
        ],
    ) -> Any:
        # (ID | NULL | INT | FLOAT | BOOL | UNQUOTED_CHAR | COLON | ESC | WS | interpolation)+
        if ctx.getChildCount() == 1:
            child = ctx.getChild(0)
            if isinstance(child, OmegaConfGrammarParser.InterpolationContext):
                return self.visitInterpolation(child)
            assert isinstance(child, TerminalNode)
            symbol = child.symbol
            # Parse primitive types.
            if symbol.type in (
                OmegaConfGrammarLexer.ID,
                OmegaConfGrammarLexer.UNQUOTED_CHAR,
                OmegaConfGrammarLexer.COLON,
            ):
                return symbol.text
            elif symbol.type == OmegaConfGrammarLexer.NULL:
                return None
            elif symbol.type == OmegaConfGrammarLexer.INT:
                return int(symbol.text)
            elif symbol.type == OmegaConfGrammarLexer.FLOAT:
                return float(symbol.text)
            elif symbol.type == OmegaConfGrammarLexer.BOOL:
                return symbol.text.lower() == "true"
            elif symbol.type == OmegaConfGrammarLexer.ESC:
                return self._unescape([child])
            elif symbol.type == OmegaConfGrammarLexer.WS:  # pragma: no cover
                # A single WS should have been "consumed" by another token.
                raise AssertionError("WS should never be reached")
            assert False, symbol.type
        # Concatenation of multiple items ==> un-escape the concatenation.
        return self._unescape(list(ctx.getChildren()))

    def _unescape(
        self,
        seq: List[Union[TerminalNode, OmegaConfGrammarParser.InterpolationContext]],
    ) -> str:
        """
        Concatenate all symbols / interpolations in `seq`, unescaping symbols as needed.

        Interpolations are resolved and cast to string *WITHOUT* escaping their result
        (it is assumed that whatever escaping is required was already handled during the
        resolving of the interpolation).
        """
        chrs = []
        for node, next_node in zip_longest(seq, seq[1:]):
            if isinstance(node, TerminalNode):
                s = node.symbol
                if s.type == OmegaConfGrammarLexer.ESC_INTER:
                    # `ESC_INTER` is of the form `\\...\${`: the formula below computes
                    # the number of characters to keep at the end of the string to remove
                    # the correct number of backslashes.
                    text = s.text[-(len(s.text) // 2 + 1) :]
                elif (
                    # Character sequence identified as requiring un-escaping.
                    s.type == OmegaConfGrammarLexer.ESC
                    or (
                        # At top level, we need to un-escape backslashes that precede
                        # an interpolation.
                        s.type == OmegaConfGrammarLexer.TOP_ESC
                        and isinstance(
                            next_node, OmegaConfGrammarParser.InterpolationContext
                        )
                    )
                    or (
                        # In a quoted sring, we need to un-escape backslashes that
                        # either end the string, or are followed by an interpolation.
                        s.type == OmegaConfGrammarLexer.QUOTED_ESC
                        and (
                            next_node is None
                            or isinstance(
                                next_node, OmegaConfGrammarParser.InterpolationContext
                            )
                        )
                    )
                ):
                    text = s.text[1::2]  # un-escape the sequence
                else:
                    text = s.text  # keep the original text
            else:
                assert isinstance(node, OmegaConfGrammarParser.InterpolationContext)
                text = str(self.visitInterpolation(node))
            chrs.append(text)

        return "".join(chrs)
