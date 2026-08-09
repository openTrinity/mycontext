# Generated from /home/omry/dev/omegaconf/omegaconf/grammar/OmegaConfGrammarParser.g4 by ANTLR 4.9.3
from antlr4 import *
if __name__ is not None and "." in __name__:
    from .OmegaConfGrammarParser import OmegaConfGrammarParser
else:
    from OmegaConfGrammarParser import OmegaConfGrammarParser

# This class defines a complete generic visitor for a parse tree produced by OmegaConfGrammarParser.

class OmegaConfGrammarParserVisitor(ParseTreeVisitor):

    # Visit a parse tree produced by OmegaConfGrammarParser#configValue.
    def visitConfigValue(self, ctx:OmegaConfGrammarParser.ConfigValueContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#singleElement.
    def visitSingleElement(self, ctx:OmegaConfGrammarParser.SingleElementContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#text.
    def visitText(self, ctx:OmegaConfGrammarParser.TextContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#element.
    def visitElement(self, ctx:OmegaConfGrammarParser.ElementContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#listContainer.
    def visitListContainer(self, ctx:OmegaConfGrammarParser.ListContainerContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#dictContainer.
    def visitDictContainer(self, ctx:OmegaConfGrammarParser.DictContainerContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#dictKeyValuePair.
    def visitDictKeyValuePair(self, ctx:OmegaConfGrammarParser.DictKeyValuePairContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#sequence.
    def visitSequence(self, ctx:OmegaConfGrammarParser.SequenceContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#interpolation.
    def visitInterpolation(self, ctx:OmegaConfGrammarParser.InterpolationContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#interpolationNode.
    def visitInterpolationNode(self, ctx:OmegaConfGrammarParser.InterpolationNodeContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#interpolationResolver.
    def visitInterpolationResolver(self, ctx:OmegaConfGrammarParser.InterpolationResolverContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#configKey.
    def visitConfigKey(self, ctx:OmegaConfGrammarParser.ConfigKeyContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#resolverName.
    def visitResolverName(self, ctx:OmegaConfGrammarParser.ResolverNameContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#quotedValue.
    def visitQuotedValue(self, ctx:OmegaConfGrammarParser.QuotedValueContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#primitive.
    def visitPrimitive(self, ctx:OmegaConfGrammarParser.PrimitiveContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by OmegaConfGrammarParser#dictKey.
    def visitDictKey(self, ctx:OmegaConfGrammarParser.DictKeyContext):
        return self.visitChildren(ctx)



del OmegaConfGrammarParser