import re
import threading
from typing import Any

from antlr4 import CommonTokenStream, InputStream, ParserRuleContext
from antlr4.error.ErrorListener import ErrorListener

from .errors import GrammarParseError

# Import from visitor in order to check the presence of generated grammar files
# files in a single place.
from .grammar_visitor import (  # type: ignore
    OmegaConfGrammarLexer,
    OmegaConfGrammarParser,
)

# Used to cache grammar objects to avoid re-creating them on each call to `parse()`.
# We use a per-thread cache to make it thread-safe.
_grammar_cache = threading.local()

# Build regex pattern to efficiently identify typical interpolations.
# See test `test_match_simple_interpolation_pattern` for examples.
_config_key = r"[$\w]+"  # foo, $0, $bar, $foo_$bar123$
_key_maybe_brackets = f"{_config_key}|\\[{_config_key}\\]"  # foo, [foo], [$bar]
_node_access = f"\\.{_key_maybe_brackets}"  # .foo, [foo], [$bar]
_node_path = f"(\\.)*({_key_maybe_brackets})({_node_access})*"  # [foo].bar, .foo[bar]
_node_inter = f"\\${{\\s*{_node_path}\\s*}}"  # node interpolation ${foo.bar}
_id = "[a-zA-Z_][\\w\\-]*"  # foo, foo_bar, foo-bar, abc123
_resolver_name = f"({_id}(\\.{_id})*)?"  # foo, ns.bar3, ns_1.ns_2.b0z
_arg = r"[a-zA-Z_0-9/\-\+.$%*@?|]+"  # string representing a resolver argument
_args = f"{_arg}(\\s*,\\s*{_arg})*"  # list of resolver arguments
_resolver_inter = f"\\${{\\s*{_resolver_name}\\s*:\\s*{_args}?\\s*}}"  # ${foo:bar}
_inter = f"({_node_inter}|{_resolver_inter})"  # any kind of interpolation
_outer = "([^$]|\\$(?!{))+"  # any character except $ (unless not followed by {)
SIMPLE_INTERPOLATION_PATTERN = re.compile(
    f"({_outer})?({_inter}({_outer})?)+$", flags=re.ASCII
)
# NOTE: SIMPLE_INTERPOLATION_PATTERN must not generate false positive matches:
# it must not accept anything that isn't a valid interpolation (per the
# interpolation grammar defined in `omegaconf/grammar/*.g4`).


class OmegaConfErrorListener(ErrorListener):  # type: ignore
    def syntaxError(
        self,
        recognizer: Any,
        offending_symbol: Any,
        line: Any,
        column: Any,
        msg: Any,
        e: Any,
    ) -> None:
        raise GrammarParseError(str(e) if msg is None else msg) from e

    def reportAmbiguity(
        self,
        recognizer: Any,
        dfa: Any,
        startIndex: Any,
        stopIndex: Any,
        exact: Any,
        ambigAlts: Any,
        configs: Any,
    ) -> None:
        raise GrammarParseError("ANTLR error: Ambiguity")  # pragma: no cover

    def reportAttemptingFullContext(
        self,
        recognizer: Any,
        dfa: Any,
        startIndex: Any,
        stopIndex: Any,
        conflictingAlts: Any,
        configs: Any,
    ) -> None:
        # Note: for now we raise an error to be safe. However this is mostly a
        # performance warning, so in the future this may be relaxed if we need
        # to change the grammar in such a way that this warning cannot be
        # avoided (another option would be to switch to SLL parsing mode).
        raise GrammarParseError(
            "ANTLR error: Attempting Full Context"
        )  # pragma: no cover

    def reportContextSensitivity(
        self,
        recognizer: Any,
        dfa: Any,
        startIndex: Any,
        stopIndex: Any,
        prediction: Any,
        configs: Any,
    ) -> None:
        raise GrammarParseError("ANTLR error: ContextSensitivity")  # pragma: no cover


def parse(
    value: str, parser_rule: str = "configValue", lexer_mode: str = "DEFAULT_MODE"
) -> ParserRuleContext:
    """
    Parse interpolated string `value` (and return the parse tree).
    """
    l_mode = getattr(OmegaConfGrammarLexer, lexer_mode)
    istream = InputStream(value)

    cached = getattr(_grammar_cache, "data", None)
    if cached is None:
        error_listener = OmegaConfErrorListener()
        lexer = OmegaConfGrammarLexer(istream)
        lexer.removeErrorListeners()
        lexer.addErrorListener(error_listener)
        lexer.mode(l_mode)
        token_stream = CommonTokenStream(lexer)
        parser = OmegaConfGrammarParser(token_stream)
        parser.removeErrorListeners()
        parser.addErrorListener(error_listener)

        # The two lines below could be enabled in the future if we decide to switch
        # to SLL prediction mode. Warning though, it has not been fully tested yet!
        # from antlr4 import PredictionMode
        # parser._interp.predictionMode = PredictionMode.SLL

        # Note that although the input stream `istream` is implicitly cached within
        # the lexer, it will be replaced by a new input next time the lexer is re-used.
        _grammar_cache.data = lexer, token_stream, parser

    else:
        lexer, token_stream, parser = cached
        # Replace the old input stream with the new one.
        lexer.inputStream = istream
        # Initialize the lexer / token stream / parser to process the new input.
        lexer.mode(l_mode)
        token_stream.setTokenSource(lexer)
        parser.reset()

    try:
        return getattr(parser, parser_rule)()
    except Exception as exc:
        if type(exc) is Exception and str(exc) == "Empty Stack":
            # This exception is raised by antlr when trying to pop a mode while
            # no mode has been pushed. We convert it into an `GrammarParseError`
            # to facilitate exception handling from the caller.
            raise GrammarParseError("Empty Stack")
        else:
            raise
