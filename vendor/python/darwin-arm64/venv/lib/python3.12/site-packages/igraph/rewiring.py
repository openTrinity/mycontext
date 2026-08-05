from igraph._igraph import GraphBase

from .utils import deprecated

__all__ = ("_rewire", )


def _rewire(graph, n=None, allowed_edge_types="simple", *, mode=None):
    """Randomly rewires the graph while preserving the degree distribution.

    The rewiring is done \"in-place\", so the original graph will be modified.
    If you want to preserve the original graph, use the L{copy} method before
    rewiring.

    @param n: the number of rewiring trials. The default is 10 times the number
        of edges.
    @param allowed_edge_types: the rewiring algorithm to use. It can either be
        C{"simple"} or C{"loops"}; the former does not create or destroy
        loop edges while the latter does.
    """
    if mode is not None:
        deprecated("The 'mode' keyword argument is deprecated, use 'allowed_edge_types' instead")
        allowed_edge_types = mode

    return GraphBase._rewire(graph, n, allowed_edge_types)
