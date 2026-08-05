import igraph as _ig
from . import _c_leiden
from .functions import _get_py_capsule

class MutableVertexPartition(_ig.VertexClustering):
  """ Contains a partition of a graph, derives from
  :class:`ig.VertexClustering`. Please see the `documentation
  <https://python.igraph.org/en/stable/api/igraph.VertexClustering.html>`_
  of :class:`ig.VertexClustering` for more details about its functionality.

  This class contains the basic implementation for optimising a partition.
  Specifically, it implements all the administration necessary to keep track of
  the partition from various points of view. Internally, it keeps track of the
  number of internal edges (or total weight), the size of the communities, the
  total incoming degree (or weight) for a community, et cetera.

  In order to keep the administration up-to-date, all changes in a partition
  should be done through
  :func:`~VertexPartition.MutableVertexPartition.move_node` or
  :func:`~VertexPartition.MutableVertexPartition.set_membership`.  The first
  moves a node from one community to another, and updates the administration.
  The latter simply updates the membership vector and updates the
  administration.

  The basic idea is that
  :func:`~VertexPartition.MutableVertexPartition.diff_move` computes the
  difference in the quality function if we would call
  :func:`~VertexPartition.MutableVertexPartition.move_node` for the same move.
  These functions are overridden in any derived classes to provide an actual
  implementation. These functions are used by :class:`Optimiser` to optimise
  the partition.

  .. warning:: This base class should never be used in practice, since only
               derived classes provide an actual implementation.

  """

  # Init
  def __init__(self, graph, initial_membership=None):
    """
    Parameters
    ----------
    graph
      The :class:`ig.Graph` on which this partition is defined.

    membership
      The membership vector of this partition. ``Membership[i] = c`` implies that
      node ``i`` is in community ``c``. If ``None``, it is initialised with a singleton
      partition community, i.e. ``membership[i] = i``.
    """
    if initial_membership is not None:
      initial_membership = list(initial_membership)

    super(MutableVertexPartition, self).__init__(graph, initial_membership)

  @classmethod
  def _FromCPartition(cls, partition):
    n, directed, edges, weights, node_sizes = _c_leiden._MutableVertexPartition_get_py_igraph(partition)
    graph = _ig.Graph(n=n,
                      directed=directed,
                      edges=edges,
                      edge_attrs={'weight': weights},
                      vertex_attrs={'node_size': node_sizes})
    new_partition = cls(graph)
    new_partition._partition = partition
    new_partition._update_internal_membership()
    return new_partition

  @classmethod
  def FromPartition(cls, partition, **kwargs):
    """ Create a new partition from an existing partition.

    Parameters
    ----------
    partition
      The :class:`~VertexPartition.MutableVertexPartition` to replicate.

    **kwargs
      Any remaining keyword arguments will be passed on to the constructor of
      the new partition.

    Notes
    -----
    This may for example come in handy when determining the quality of a
    partition using a different method. Suppose that we already have a
    partition ``p`` and that we want to determine the Significance of that
    partition. We can then simply use

    >>> p = la.find_partition(ig.Graph.Famous('Zachary'),
    ...                       la.ModularityVertexPartition)
    >>> sig = la.SignificanceVertexPartition.FromPartition(p).quality()
    """
    new_partition = cls(partition.graph, partition.membership, **kwargs)
    return new_partition

  def _update_internal_membership(self):
    self._membership = _c_leiden._MutableVertexPartition_get_membership(self._partition)
    # Reset the length of the object, i.e. the number of communities
    if len(self._membership)>0:
        self._len = max(m for m in self._membership if m is not None)+1
    else:
        self._len = 0

  def set_membership(self, membership):
    """ Set membership. """
    _c_leiden._MutableVertexPartition_set_membership(self._partition, list(membership))
    self._update_internal_membership()

  # Calculate improvement *if* we move this node
  def diff_move(self,v,new_comm):
    """ Calculate the difference in the quality function if node ``v`` is
    moved to community ``new_comm``.

    Parameters
    ----------
    v
      The node to move.

    new_comm
      The community to move to.

    Returns
    -------
    float
      Difference in quality function.

    Notes
    -----
    The difference returned by diff_move should be equivalent to first
    determining the quality of the partition, then calling move_node, and then
    determining again the quality of the partition and looking at the
    difference. In other words

    >>> partition = la.find_partition(ig.Graph.Famous('Zachary'),
    ...                               la.ModularityVertexPartition)
    >>> diff = partition.diff_move(v=0, new_comm=0)
    >>> q1 = partition.quality()
    >>> partition.move_node(v=0, new_comm=0)
    >>> q2 = partition.quality()
    >>> round(diff, 10) == round(q2 - q1, 10)
    True

    .. warning:: Only derived classes provide actual implementations, the base
                 class provides no implementation for this function.

    """
    return _c_leiden._MutableVertexPartition_diff_move(self._partition, v, new_comm)

  def aggregate_partition(self, membership_partition=None):
    """ Aggregate the graph according to the current partition and provide a
    default partition for it.

    The aggregated graph can then be found as a parameter of the partition
    ``partition.graph``.

    Notes
    -----
    This function contrasts to the function ``cluster_graph`` in igraph itself,
    which also provides the aggregate graph, but we may require setting
    the appropriate ``resolution_parameter``, ``weights`` and ``node_sizes``.
    In particular, this function also ensures that the quality defined on the
    aggregate partition is identical to the quality defined on the original
    partition.

    Examples
    --------
    >>> G = ig.Graph.Famous('Zachary')
    >>> partition = la.find_partition(G, la.ModularityVertexPartition)
    >>> aggregate_partition = partition.aggregate_partition(partition)
    >>> aggregate_graph = aggregate_partition.graph
    >>> aggregate_partition.quality() == partition.quality()
    True
    """
    partition_agg = self._FromCPartition(_c_leiden._MutableVertexPartition_aggregate_partition(self._partition))

    if (not membership_partition is None):
      membership = partition_agg.membership
      for v in self.graph.vs:
        membership[self.membership[v.index]] = membership_partition.membership[v.index]
      partition_agg.set_membership(membership)

    return partition_agg

  def move_node(self,v,new_comm):
    """ Move node ``v`` to community ``new_comm``.

    Parameters
    ----------
    v
      Node to move.

    new_comm
      Community to move to.

    Examples
    --------
    >>> G = ig.Graph.Famous('Zachary')
    >>> partition = la.ModularityVertexPartition(G)
    >>> partition.move_node(0, 1)
    """
    _c_leiden._MutableVertexPartition_move_node(self._partition, v, new_comm)
    # Make sure this move is also reflected in the membership vector of the python object
    self._membership[v] = new_comm
    self._modularity_dirty = True

  def from_coarse_partition(self, partition, coarse_node=None):
    """ Update current partition according to coarser partition.

    Parameters
    ----------
    partition : :class:`~VertexPartition.MutableVertexPartition`
      The coarser partition used to update the current partition.

    coarse_node : list of int
      The coarser node which represent the current node in the partition.

    Notes
    -----
    This function is to be used to determine the correct partition for an
    aggregated graph. In particular, suppose we move nodes and then get an
    aggregate graph.

    >>> diff = optimiser.move_nodes(partition)
    >>> aggregate_partition = partition.aggregate_partition()

    Now we also move nodes in the aggregate partition

    >>> diff = optimiser.move_nodes(aggregate_partition)

    Now we improved the quality function of ``aggregate_partition``, but this
    is not yet reflected in the original ``partition``. We can thus call

    >>> partition.from_coarse_partition(aggregate_partition)

    so that ``partition`` now reflects the changes made to
    ``aggregate_partition``.

    The ``coarse_node`` can be used it the ``aggregate_partition`` is not
    defined based on the membership of this partition. In particular the
    membership of this partition is defined as follows:

    >>> for v in G.vs:
    ...   partition.membership[v] = aggregate_partition.membership[coarse_node[v]] # doctest: +SKIP

    If ``coarse_node`` is :obj:`None` it is assumed the coarse node was defined
    based on the membership of the current partition, so that

    >>> for v in G.vs:
    ...   partition.membership[v] = aggregate_partition.membership[partition.membership[v]] # doctest: +SKIP

    This can be useful when the aggregate partition is defined on a more
    refined partition.
    """
    # Read the coarser partition
    _c_leiden._MutableVertexPartition_from_coarse_partition(self._partition,
                                                             partition.membership, coarse_node)
    self._update_internal_membership()

  def renumber_communities(self):
    """ Renumber the communities so that they are numbered in decreasing size.

    Notes
    -----
    The sort is not necessarily stable.
    """
    _c_leiden._MutableVertexPartition_renumber_communities(self._partition)
    self._update_internal_membership()

  def quality(self):
    """ The current quality of the partition. """
    return _c_leiden._MutableVertexPartition_quality(self._partition)

  def total_weight_in_comm(self, comm):
    """ The total weight (i.e. number of edges) within a community.

    Parameters
    ----------
    comm
      Community

    See Also
    --------
    :func:`~VertexPartition.MutableVertexPartition.total_weight_to_comm`

    :func:`~VertexPartition.MutableVertexPartition.total_weight_from_comm`

    :func:`~VertexPartition.MutableVertexPartition.total_weight_in_all_comms`
    """
    return _c_leiden._MutableVertexPartition_total_weight_in_comm(self._partition, comm)

  def total_weight_from_comm(self, comm):
    """ The total weight (i.e. number of edges) from a community.

    Parameters
    ----------
    comm
      Community

    Notes
    -----
    This includes all edges, also the ones that are internal to a community.
    Sometimes this is also referred to as the community (out)degree.

    See Also
    --------
    :func:`~VertexPartition.MutableVertexPartition.total_weight_to_comm`

    :func:`~VertexPartition.MutableVertexPartition.total_weight_in_comm`

    :func:`~VertexPartition.MutableVertexPartition.total_weight_in_all_comms`
    """
    return _c_leiden._MutableVertexPartition_total_weight_from_comm(self._partition, comm)

  def total_weight_to_comm(self, comm):
    """ The total weight (i.e. number of edges) to a community.

    Parameters
    ----------
    comm
      Community

    Notes
    -----
    This includes all edges, also the ones that are internal to a community.
    Sometimes this is also referred to as the community (in)degree.

    See Also
    --------
    :func:`~VertexPartition.MutableVertexPartition.total_weight_from_comm`

    :func:`~VertexPartition.MutableVertexPartition.total_weight_in_comm`

    :func:`~VertexPartition.MutableVertexPartition.total_weight_in_all_comms`
    """
    return _c_leiden._MutableVertexPartition_total_weight_to_comm(self._partition, comm)

  def total_weight_in_all_comms(self):
    """ The total weight (i.e. number of edges) within all communities.

    Notes
    -----
    This should be equal to simply the sum of ``total_weight_in_comm`` for all communities.

    See Also
    --------
    :func:`~VertexPartition.MutableVertexPartition.total_weight_to_comm`

    :func:`~VertexPartition.MutableVertexPartition.total_weight_from_comm`

    :func:`~VertexPartition.MutableVertexPartition.total_weight_in_comm`
    """
    return _c_leiden._MutableVertexPartition_total_weight_in_all_comms(self._partition)

  def total_possible_edges_in_all_comms(self):
    """ The total possible number of edges in all communities.

    Notes
    -----
    If we denote by :math:`n_c` the number of nodes in community :math:`c`,
    this is simply

    .. math :: \\sum_c \\binom{n_c}{2}

    """
    return _c_leiden._MutableVertexPartition_total_possible_edges_in_all_comms(self._partition)

  def weight_to_comm(self, v, comm):
    """ The total number of edges (or sum of weights) from node ``v`` to
    community ``comm``.

    See Also
    --------
    :func:`~VertexPartition.MutableVertexPartition.weight_from_comm`
    """
    return _c_leiden._MutableVertexPartition_weight_to_comm(self._partition, v, comm)

  def weight_from_comm(self, v, comm):
    """ The total number of edges (or sum of weights) to node ``v`` from
    community ``comm``.

    See Also
    --------
    :func:`~VertexPartition.MutableVertexPartition.weight_to_comm`
    """
    return _c_leiden._MutableVertexPartition_weight_from_comm(self._partition, v, comm)

class ModularityVertexPartition(MutableVertexPartition):
  r""" Implements modularity. This quality function is well-defined only for positive edge weights.

  Notes
  -----
  The quality function is

  .. math:: Q = \\frac{1}{2m} \\sum_{ij} \\left(A_{ij} - \\frac{k_i k_j}{2m} \\right)\\delta(\\sigma_i, \\sigma_j)

  where :math:`A` is the adjacency matrix, :math:`k_i` is the (weighted) degree
  of node :math:`i`, :math:`m` is the total number of edges (or total edge
  weight), :math:`\\sigma_i` denotes the community of node :math:`i` and
  :math:`\\delta(\\sigma_i, \\sigma_j) = 1` if :math:`\\sigma_i = \\sigma_j`
  and `0` otherwise.

  This can alternatively be formulated as a sum over communities:

  .. math:: Q = \\frac{1}{2m} \\sum_{c} \\left(m_c - \\frac{K_c^2}{4m} \\right)

  where :math:`m_c` is the number of internal edges (or total internal edge
  weight) of community :math:`c` and :math:`K_c = \\sum_{i \\mid \\sigma_i = c}
  k_i` is the total (weighted) degree of nodes in community :math:`c`.

  Note that for directed graphs a slightly different formulation is used, as
  proposed by Leicht and Newman [2]:

  .. math:: Q = \\frac{1}{m} \\sum_{ij} \\left(A_{ij} - \\frac{k_i^\\mathrm{out} k_j^\\mathrm{in}}{m} \\right)\\delta(\\sigma_i, \\sigma_j),

  where :math:`k_i^\\mathrm{out}` and :math:`k_i^\\mathrm{in}` refers to
  respectively the outdegree and indegree of node :math:`i`, and :math:`A_{ij}`
  refers to an edge from :math:`i` to :math:`j`.

  References
  ----------
  .. [1] Newman, M. E. J., & Girvan, M. (2004). Finding and evaluating
         community structure in networks.  Physical Review E, 69(2), 026113.
         `10.1103/PhysRevE.69.026113 <http://doi.org/10.1103/PhysRevE.69.026113>`_

  .. [2] Leicht, E. A., & Newman, M. E. J. (2008). Community Structure
         in Directed Networks. Physical Review Letters, 100(11), 118703.
         `10.1103/PhysRevLett.100.118703 <https://doi.org/10.1103/PhysRevLett.100.118703>`_
   """
  def __init__(self, graph, initial_membership=None, weights=None):
    """
    Parameters
    ----------
    graph : :class:`ig.Graph`
      Graph to define the partition on.

    initial_membership : list of int
      Initial membership for the partition. If :obj:`None` then defaults to a
      singleton partition.

    weights : list of double, or edge attribute
      Weights of edges. Can be either an iterable or an edge attribute.
    """
    if initial_membership is not None:
      initial_membership = list(initial_membership)

    super(ModularityVertexPartition, self).__init__(graph, initial_membership)
    pygraph_t = _get_py_capsule(graph)

    if weights is not None:
      if isinstance(weights, str):
        weights = graph.es[weights]
      else:
        # Make sure it is a list
        weights = list(weights)

    self._partition = _c_leiden._new_ModularityVertexPartition(pygraph_t,
        initial_membership, weights)
    self._update_internal_membership()

  def __deepcopy__(self, memo):
    n, directed, edges, weights, node_sizes = _c_leiden._MutableVertexPartition_get_py_igraph(self._partition)
    new_partition = ModularityVertexPartition(self.graph, self.membership, weights)
    return new_partition

class SurpriseVertexPartition(MutableVertexPartition):
  """ Implements (asymptotic) Surprise. This quality function is well-defined only for positive edge weights.

  Notes
  -----
  The quality function is

  .. math:: Q = m D(q \\parallel \\langle q \\rangle)

  where :math:`m` is the number of edges,

  .. math:: q = \\frac{\\sum_c m_c}{m},

  is the fraction of internal edges,

  .. math:: \\langle q \\rangle = \\frac{\\sum_c \\binom{n_c}{2}}{\\binom{n}{2}}

  is the expected fraction of internal edges, and finally

  .. math:: D(x \\parallel y) = x \\ln \\frac{x}{y} + (1 - x) \\ln \\frac{1 - x}{1 - y}

  is the binary Kullback-Leibler divergence.

  For directed graphs we can multiplying the binomials by 2, and this leaves
  :math:`\\langle q \\rangle` unchanged, so that we can simply use the same
  formulation.  For weighted graphs we can simply count the total internal
  weight instead of the total number of edges for :math:`q`, while
  :math:`\\langle q \\rangle` remains unchanged.

  References
  ----------
  .. [1] Traag, V. A., Aldecoa, R., & Delvenne, J.-C. (2015). Detecting
          communities using asymptotical surprise.  Physical Review E, 92(2),
          022816.
          `10.1103/PhysRevE.92.022816 <http://doi.org/10.1103/PhysRevE.92.022816>`_
  """

  def __init__(self, graph, initial_membership=None, weights=None, node_sizes=None):
    """
    Parameters
    ----------
    graph : :class:`ig.Graph`
      Graph to define the partition on.

    initial_membership : list of int
      Initial membership for the partition. If :obj:`None` then defaults to a
      singleton partition.

    weights : list of double, or edge attribute
      Weights of edges. Can be either an iterable or an edge attribute.

    node_sizes : list of int, or vertex attribute
      The quality function takes into account the size of a community, which
      is defined as the sum over the sizes of each individual node. By default, 
      the node sizes are set to 1, meaning that the size of a community equals 
      the number of nodes of a community. If a node already represents an 
      aggregation, this could be reflect in its node size.
    """
    if initial_membership is not None:
      initial_membership = list(initial_membership)

    super(SurpriseVertexPartition, self).__init__(graph, initial_membership)

    pygraph_t = _get_py_capsule(graph)

    if weights is not None:
      if isinstance(weights, str):
        weights = graph.es[weights]
      else:
        # Make sure it is a list
        weights = list(weights)

    if node_sizes is not None:
      if isinstance(node_sizes, str):
        node_sizes = graph.vs[node_sizes]
      else:
        # Make sure it is a list
        node_sizes = list(node_sizes)

    self._partition = _c_leiden._new_SurpriseVertexPartition(pygraph_t,
        initial_membership, weights, node_sizes)
    self._update_internal_membership()

  def __deepcopy__(self, memo):
    n, directed, edges, weights, node_sizes = _c_leiden._MutableVertexPartition_get_py_igraph(self._partition)
    new_partition = SurpriseVertexPartition(self.graph, self.membership, weights, node_sizes)
    return new_partition

class SignificanceVertexPartition(MutableVertexPartition):
  """ Implements Significance. This quality function is well-defined only for unweighted graphs.

  Notes
  -----
  The quality function is

  .. math:: Q = \\sum_c \\binom{n_c}{2} D(p_c \\parallel p)

  where :math:`n_c` is the number of nodes in community :math:`c`,

  .. math:: p_c = \\frac{m_c}{\\binom{n_c}{2}},

  is the density of community :math:`c`,

  .. math:: p = \\frac{m}{\\binom{n}{2}}

  is the overall density of the graph, and finally

  .. math:: D(x \\parallel y) = x \\ln \\frac{x}{y} + (1 - x) \\ln \\frac{1 - x}{1 - y}

  is the binary Kullback-Leibler divergence.

  For directed graphs simply multiply the binomials by 2. The expected
  Significance in Erdos-Renyi graphs behaves roughly as :math:`\\frac{1}{2} n
  \\ln n` for both directed and undirected graphs in this formulation.

  .. warning:: This method is not suitable for weighted graphs.

  References
  ----------
  .. [1] Traag, V. A., Krings, G., & Van Dooren, P. (2013). Significant scales in community structure.
         Scientific Reports, 3, 2930. `10.1038/srep02930 <http://doi.org/10.1038/srep02930>`_
  """
  def __init__(self, graph, initial_membership=None, node_sizes=None):
    """
    Parameters
    ----------
    graph : :class:`ig.Graph`
      Graph to define the partition on.

    initial_membership : list of int
      Initial membership for the partition. If :obj:`None` then defaults to a
      singleton partition.

    node_sizes : list of int, or vertex attribute
      The quality function takes into account the size of a community, which
      is defined as the sum over the sizes of each individual node. By default, 
      the node sizes are set to 1, meaning that the size of a community equals 
      the number of nodes of a community. If a node already represents an 
      aggregation, this could be reflect in its node size.
    """
    if initial_membership is not None:
      initial_membership = list(initial_membership)

    super(SignificanceVertexPartition, self).__init__(graph, initial_membership)

    pygraph_t = _get_py_capsule(graph)

    if node_sizes is not None:
      if isinstance(node_sizes, str):
        node_sizes = graph.vs[node_sizes]
      else:
        # Make sure it is a list
        node_sizes = list(node_sizes)

    self._partition = _c_leiden._new_SignificanceVertexPartition(pygraph_t, initial_membership, node_sizes)
    self._update_internal_membership()

  def __deepcopy__(self, memo):
    n, directed, edges, weights, node_sizes = _c_leiden._MutableVertexPartition_get_py_igraph(self._partition)
    new_partition = SignificanceVertexPartition(self.graph, self.membership, node_sizes)
    return new_partition

class LinearResolutionParameterVertexPartition(MutableVertexPartition):
  """ Some quality functions have a linear resolution parameter, for which the
  basis is implemented here.

  With a linear resolution parameter, we mean that the objective function has
  the form:

  .. math:: Q = E - \\gamma F

  where :math:`\\gamma` is some resolution parameter and :math:`E` and
  :math:`F` arbitrary other functions of the partition.

  One thing that can be easily done on these type of quality functions, is
  bisectioning on the gamma function (also assuming that :math:`E` is a
  stepwise decreasing monotonic function, e.g. as for
  :class:`CPMVertexPartition`).
  """
  def __init__(self, graph, initial_membership=None):
    if initial_membership is not None:
      initial_membership = list(initial_membership)

    super(LinearResolutionParameterVertexPartition, self).__init__(graph, initial_membership)

  #########################################################3
  # resolution parameter
  @property
  def resolution_parameter(self):
    """ Resolution parameter. """
    return _c_leiden._ResolutionParameterVertexPartition_get_resolution(self._partition)

  @resolution_parameter.setter
  def resolution_parameter(self, value):
    return _c_leiden._ResolutionParameterVertexPartition_set_resolution(self._partition, value)

  def bisect_value(self):
    """ Give the value on which we can perform bisectioning.

    If p1 and p2 are two different optimal partitions for two different
    resolution parameters g1 and g2, then if p1.bisect_value() ==
    p2.bisect_value() the two partitions should be optimal for both g1 and g2.
    """
    return self.total_weight_in_all_comms()

  def quality(self, resolution_parameter=None):
    return _c_leiden._ResolutionParameterVertexPartition_quality(self._partition, resolution_parameter)

class RBERVertexPartition(LinearResolutionParameterVertexPartition):
  """ Implements Reichardt and Bornholdt’s Potts model with an Erdős-Rényi null model.
  This quality function is well-defined only for positive edge weights.
  This quality function uses a linear resolution parameter.

  Notes
  -----
  The quality function is

  .. math:: Q = \\sum_{ij} \\left(A_{ij} - \\gamma p \\right)\\delta(\\sigma_i, \\sigma_j)

  where :math:`A` is the adjacency matrix,

  .. math:: p = \\frac{m}{\\binom{n}{2}}

  is the overall density of the graph, :math:`\\sigma_i` denotes the community
  of node :math:`i`, :math:`\\delta(\\sigma_i, \\sigma_j) = 1` if
  :math:`\\sigma_i = \\sigma_j` and `0` otherwise, and, finally :math:`\\gamma`
  is a resolution parameter.

  This can alternatively be formulated as a sum over communities:

  .. math:: Q = \\sum_{c} \\left[m_c - \\gamma p \\binom{n_c}{2} \\right]

  where :math:`m_c` is the number of internal edges of community :math:`c` and
  :math:`n_c` the number of nodes in community :math:`c`.

  References
  ----------
  .. [1] Reichardt, J., & Bornholdt, S. (2006). Statistical mechanics of
         community detection.  Physical Review E, 74(1), 016110.
         `10.1103/PhysRevE.74.016110 <http://doi.org/10.1103/PhysRevE.74.016110>`_
   """
  def __init__(self, graph, initial_membership=None, weights=None, node_sizes=None, resolution_parameter=1.0):
    """
    Parameters
    ----------
    graph : :class:`ig.Graph`
      Graph to define the partition on.

    initial_membership : list of int
      Initial membership for the partition. If :obj:`None` then defaults to a
      singleton partition.

    weights : list of double, or edge attribute
      Weights of edges. Can be either an iterable or an edge attribute.

    node_sizes : list of int, or vertex attribute
      The quality function takes into account the size of a community, which
      is defined as the sum over the sizes of each individual node. By default, 
      the node sizes are set to 1, meaning that the size of a community equals 
      the number of nodes of a community. If a node already represents an 
      aggregation, this could be reflect in its node size.

    resolution_parameter : double
      Resolution parameter.
    """
    if initial_membership is not None:
      initial_membership = list(initial_membership)

    super(RBERVertexPartition, self).__init__(graph, initial_membership)

    pygraph_t = _get_py_capsule(graph)

    if weights is not None:
      if isinstance(weights, str):
        weights = graph.es[weights]
      else:
        # Make sure it is a list
        weights = list(weights)

    if node_sizes is not None:
      if isinstance(node_sizes, str):
        node_sizes = graph.vs[node_sizes]
      else:
        # Make sure it is a list
        node_sizes = list(node_sizes)

    self._partition = _c_leiden._new_RBERVertexPartition(pygraph_t,
        initial_membership, weights, node_sizes, resolution_parameter)
    self._update_internal_membership()

  def __deepcopy__(self, memo):
    n, directed, edges, weights, node_sizes = _c_leiden._MutableVertexPartition_get_py_igraph(self._partition)
    new_partition = RBERVertexPartition(self.graph, self.membership, weights, node_sizes, self.resolution_parameter)
    return new_partition

class RBConfigurationVertexPartition(LinearResolutionParameterVertexPartition):
  r""" Implements Reichardt and Bornholdt's Potts model with a configuration null model.
  This quality function is well-defined only for positive edge weights.
  This quality function uses a linear resolution parameter.

  Notes
  -----
  The quality function is

  .. math:: Q = \\sum_{ij} \\left(A_{ij} - \\gamma \\frac{k_i k_j}{2m} \\right)\\delta(\\sigma_i, \\sigma_j)

  where :math:`A` is the adjacency matrix, :math:`k_i` is the (weighted) degree
  of node :math:`i`, :math:`m` is the total number of edges (or total edge
  weight), :math:`\\sigma_i` denotes the community of node :math:`i` and
  :math:`\\delta(\\sigma_i, \\sigma_j) = 1` if :math:`\\sigma_i = \\sigma_j`
  and `0` otherwise.

  This can alternatively be formulated as a sum over communities:

  .. math:: Q = \\sum_{c} \\left(m_c - \\gamma \\frac{K_c^2}{4m} \\right)

  where :math:`m_c` is the number of internal edges (or total internal edge
  weight) of community :math:`c` and :math:`K_c = \\sum_{i \\mid \\sigma_i = c}
  k_i` is the total (weighted) degree of nodes in community :math:`c`.

  Note that for directed graphs a slightly different formulation is used, as
  proposed by Leicht and Newman [2]:

  .. math:: Q = \\sum_{ij} \\left(A_{ij} - \\gamma \\frac{k_i^\\mathrm{out} k_j^\\mathrm{in}}{m} \\right)\\delta(\\sigma_i, \\sigma_j),

  where :math:`k_i^\\mathrm{out}` and :math:`k_i^\\mathrm{in}` refers to
  respectively the outdegree and indegree of node :math:`i`, and :math:`A_{ij}`
  refers to an edge from :math:`i` to :math:`j`.

  Note that this is the same as :class:`ModularityVertexPartition` when setting
  :math:`\\gamma=1` and normalising by :math:`2m`, or :math:`m` for directed
  graphs.

  References
  ----------
  .. [1] Reichardt, J., & Bornholdt, S. (2006). Statistical mechanics of
         community detection.  Physical Review E, 74(1), 016110.
         `10.1103/PhysRevE.74.016110 <http://doi.org/10.1103/PhysRevE.74.016110>`_

  .. [2] Leicht, E. A., & Newman, M. E. J. (2008). Community Structure
         in Directed Networks. Physical Review Letters, 100(11), 118703.
         `10.1103/PhysRevLett.100.118703 <https://doi.org/10.1103/PhysRevLett.100.118703>`_

   """
  def __init__(self, graph, initial_membership=None, weights=None, resolution_parameter=1.0):
    """
    Parameters
    ----------
    graph : :class:`ig.Graph`
      Graph to define the partition on.

    initial_membership : list of int
      Initial membership for the partition. If :obj:`None` then defaults to a
      singleton partition.

    weights : list of double, or edge attribute
      Weights of edges. Can be either an iterable or an edge attribute.

    resolution_parameter : double
      Resolution parameter.
    """
    if initial_membership is not None:
      initial_membership = list(initial_membership)

    super(RBConfigurationVertexPartition, self).__init__(graph, initial_membership)

    pygraph_t = _get_py_capsule(graph)

    if weights is not None:
      if isinstance(weights, str):
        weights = graph.es[weights]
      else:
        # Make sure it is a list
        weights = list(weights)

    self._partition = _c_leiden._new_RBConfigurationVertexPartition(pygraph_t,
        initial_membership, weights, resolution_parameter)
    self._update_internal_membership()

  def __deepcopy__(self, memo):
    n, directed, edges, weights, node_sizes = _c_leiden._MutableVertexPartition_get_py_igraph(self._partition)
    new_partition = RBConfigurationVertexPartition(self.graph, self.membership, weights, self.resolution_parameter)
    return new_partition

class CPMVertexPartition(LinearResolutionParameterVertexPartition):
  """ Implements the Constant Potts Model (CPM).
  This quality function is well-defined for both positive and negative edge weights.
  This quality function uses a linear resolution parameter.

  Notes
  -----
  The Constant Potts Model (CPM) quality function is

  .. math:: Q = \\sum_{ij} \\left(A_{ij} - \\gamma \\right)\\delta(\\sigma_i, \\sigma_j)

  where :math:`A` is the adjacency matrix, :math:`\\sigma_i` denotes the
  community of node :math:`i`, :math:`\\delta(\\sigma_i, \\sigma_j) = 1` if
  :math:`\\sigma_i = \\sigma_j` and `0` otherwise, and, finally :math:`\\gamma`
  is a resolution parameter.

  This can alternatively be formulated as a sum over communities:

  .. math:: Q = \\sum_{c} \\left[m_c - \\gamma \\binom{n_c}{2} \\right]

  where :math:`m_c` is the number of internal edges of community :math:`c` and
  :math:`n_c` the number of nodes in community :math:`c`.

  The resolution parameter :math:`\\gamma` for this functions has a
  particularly simple interpretation. The internal density of communities

  .. math:: p_c = \\frac{m_c}{\\binom{n_c}{2}} \\geq \\gamma

  is higher than :math:`\\gamma`, while the external density

  .. math:: p_{cd} = \\frac{m_{cd}}{n_c n_d} \\leq \\gamma

  is lower than :math:`\\gamma`. In other words, choosing a particular
  :math:`\\gamma` corresponds to choosing to find communities of a particular
  density, and as such defines communities. Finally, the definition of a
  community is in a sense independent of the actual graph, which is not the
  case for any of the other methods (see the reference for more detail).

  References
  ----------
  .. [1] Traag, V. A., Van Dooren, P., & Nesterov, Y. (2011). Narrow scope for
         resolution-limit-free community detection.  Physical Review E, 84(1),
         016114.  `10.1103/PhysRevE.84.016114 <http://doi.org/10.1103/PhysRevE.84.016114>`_
   """
  def __init__(self, graph, initial_membership=None, weights=None, node_sizes=None, resolution_parameter=1.0, correct_self_loops=None):
    """
    Parameters
    ----------
    graph : :class:`ig.Graph`
      Graph to define the partition on.

    initial_membership : list of int
      Initial membership for the partition. If :obj:`None` then defaults to a
      singleton partition.

    weights : list of double, or edge attribute
      Weights of edges. Can be either an iterable or an edge attribute.

    node_sizes : list of int, or vertex attribute
      The quality function takes into account the size of a community, which
      is defined as the sum over the sizes of each individual node. By default, 
      the node sizes are set to 1, meaning that the size of a community equals 
      the number of nodes of a community. If a node already represents an 
      aggregation, this could be reflect in its node size.

    resolution_parameter : double
      Resolution parameter.
    """
    if initial_membership is not None:
      initial_membership = list(initial_membership)

    super(CPMVertexPartition, self).__init__(graph, initial_membership)

    pygraph_t = _get_py_capsule(graph)

    if weights is not None:
      if isinstance(weights, str):
        weights = graph.es[weights]
      else:
        # Make sure it is a list
        weights = list(weights)

    if node_sizes is not None:
      if isinstance(node_sizes, str):
        node_sizes = graph.vs[node_sizes]
      else:
        # Make sure it is a list
        node_sizes = list(node_sizes)

    if correct_self_loops is None:
      correct_self_loops = any(graph.is_loop())

    self._partition = _c_leiden._new_CPMVertexPartition(pygraph_t,
        initial_membership, weights, node_sizes, resolution_parameter, correct_self_loops)
    self._update_internal_membership()

  def __deepcopy__(self, memo):
    n, directed, edges, weights, node_sizes = _c_leiden._MutableVertexPartition_get_py_igraph(self._partition)
    new_partition = CPMVertexPartition(self.graph, self.membership, weights, node_sizes, self.resolution_parameter)
    return new_partition

  @classmethod
  def Bipartite(cls, graph, resolution_parameter_01,
                resolution_parameter_0 = 0, resolution_parameter_1 = 0,
                degree_as_node_size=False, types='type', **kwargs):
    """ Create three layers for bipartite partitions.

    This creates three layers for bipartite partition necessary for detecting
    communities in bipartite networks. These three layers should be passed to
    :func:`Optimiser.optimise_partition_multiplex` with
    ``layer_weights=[1,-1,-1]``. See `Notes <#notes-bipartite>`_ for more details.

    Parameters
    ----------
    graph : :class:`ig.Graph`
      Graph to define the bipartite partitions on.

    resolution_parameter_01 : double
      Resolution parameter for in between two classes.

    resolution_parameter_0 : double
      Resolution parameter for class 0.

    resolution_parameter_1 : double
      Resolution parameter for class 1.

    degree_as_node_size : boolean
      If ``True`` use degree as node size instead of 1, to mimic modularity,
      see `Notes <#notes-bipartite>`_.

    types : vertex attribute or list
      Indicator of the class for each vertex. If not 0, 1, it is automatically
      converted.

    **kwargs
      Additional arguments passed on to default constructor of
      :class:`CPMVertexPartition`.

    Returns
    -------
    :class:`ig.CPMVertexPartition`
      partition containing the bipartite graph and correct node sizes.

    :class:`ig.CPMVertexPartition`
      partition for type 0, containing the correct node sizes for type 0.

    :class:`ig.CPMVertexPartition`
      partition for type 1, containing the correct node sizes for type 1.


    .. _notes-bipartite:

    Notes
    -----

    For bipartite networks, we would like to be able to set three different
    resolution parameters: one for within each class :math:`\\gamma_0,
    \\gamma_1`, and one for the links between classes, :math:`\\gamma_{01}`.
    Then the formulation would be

    .. math:: Q = \\sum_{ij}
       [A_{ij}
        - (\\gamma_0\\delta(s_i,0) + \\gamma_1\\delta(s_i,1)) \\delta(s_i,s_j)
        - \\gamma_{01}(1 - \\delta(s_i, s_j))
       ]\\delta(\\sigma_i, \\sigma_j)

    In terms of communities this is

    .. math:: Q = \\sum_c (e_c
                          - \\gamma_{01} 2 n_c(0) n_c(1)
                          - \\gamma_0 n^2_c(0)
                          - \\gamma_1 n^2_c(1))

    where :math:`n_c(0)` is the number of nodes in community :math:`c` of class 0
    (and similarly for 1) and :math:`e_c` is the number of edges within community
    :math:`c`. We denote by :math:`n_c = n_c(0) + n_c(1)` the total number of nodes
    in community :math:`c`.

    We achieve this by creating three layers : (1) all nodes have ``node_size =
    1`` and all relevant links; (2) only nodes of class 0 have ``node_size =
    1`` and no links; (3) only nodes of class 1 have ``node_size = 1`` and no
    links. If we add the first with resolution parameter :math:`\\gamma_{01}`,
    and the others with resolution parameters :math:`\\gamma_{01} - \\gamma_0`
    and :math:`\\gamma_{01} - \\gamma_1`, but the latter two with a layer
    weight of -1 while the first layer has layer weight 1, we obtain the
    following:

    .. math:: Q &=  \\sum_c (e_c - \\gamma_{01} n_c^2)
                   -\\sum_c (- (\\gamma_{01} - \\gamma_0) n_c(0)^2)
                   -\\sum_c (- (\\gamma_{01} - \\gamma_1) n_c(1)^2) \\\\
                &=  \\sum_c [e_c - \\gamma_{01} 2 n_c(0) n_c(1)
                                 - \\gamma_{01} n_c(0)^2
                                 - \\gamma_{01} n_c(1)^2)
                                 + ( \\gamma_{01} - \\gamma_0) n_c(0)^2
                                 + ( \\gamma_{01} - \\gamma_1) n_c(1)^2
                           ] \\\\
                &=  \\sum_c [e_c - \\gamma_{01} 2 n_c(0) n_c(1)
                                 - \\gamma_{0} n_c(0)^2
                                 - \\gamma_{1} n_c(1)^2]

    Although the derivation above is using :math:`n_c^2`, implicitly assuming a
    direct graph with self-loops, similar derivations can be made for
    undirected graphs using :math:`\\binom{n_c}{2}`, but the notation is then
    somewhat more convoluted.

    If we set node sizes equal to the degree, we get something similar to
    modularity, except that the resolution parameter should still be divided by
    :math:`2m`. In particular, in general (i.e. not specifically for bipartite
    graph) if ``node_sizes=G.degree()`` we then obtain

    .. math:: Q = \\sum_{ij} A_{ij} - \\gamma k_i k_j

    In the case of bipartite graphs something similar is obtained, but then
    correctly adapted (as long as the resolution parameter is also
    appropriately rescaled).

    .. note:: This function is not suited for directed graphs in the case of
              using the degree as node sizes.
    """

    if types is not None:
      if isinstance(types, str):
        types = graph.vs[types]
      else:
        # Make sure it is a list
        types = list(types)

    if set(types) != set([0, 1]):
      new_type = _ig.UniqueIdGenerator()
      types = [new_type[t] for t in types]

    if set(types) != set([0, 1]):
      raise ValueError("More than one type specified.")

    if degree_as_node_size:
      if (graph.is_directed()):
        raise ValueError("This method is not suitable for directed graphs " +
                         "when using degree as node sizes.")
      node_sizes = graph.degree()
    else:
      node_sizes = [1]*graph.vcount()

    partition_01 = cls(graph,
                     node_sizes=node_sizes,
                     resolution_parameter=resolution_parameter_01,
                     **kwargs)
    H_0 = graph.subgraph_edges([], delete_vertices=False)
    partition_0 = cls(H_0, weights=None,
                     node_sizes=[s if t == 0 else 0
                                 for v, s, t in zip(graph.vs,node_sizes,types)],
                     resolution_parameter=resolution_parameter_01 - resolution_parameter_0)
    H_1 = graph.subgraph_edges([], delete_vertices=False)
    partition_1 = cls(H_1, weights=None,
                     node_sizes=[s if t == 1 else 0
                                 for v, s, t in zip(graph.vs,node_sizes,types)],
                     resolution_parameter=resolution_parameter_01 - resolution_parameter_1)
    return partition_01, partition_0, partition_1
