import sys
import igraph as _ig
from . import _c_leiden
from ._c_leiden import ALL_COMMS
from ._c_leiden import ALL_NEIGH_COMMS
from ._c_leiden import RAND_COMM
from ._c_leiden import RAND_NEIGH_COMM

from ._c_leiden import MOVE_NODES
from ._c_leiden import MERGE_NODES

from collections import Counter


def _get_py_capsule(graph):
  return graph.__graph_as_capsule()

from .VertexPartition import *
from .Optimiser import *

def find_partition(graph, partition_type, initial_membership=None, weights=None, n_iterations=2, max_comm_size=0, seed=None, **kwargs):
  """ Detect communities using the default settings.

  This function detects communities given the specified method in the
  ``partition_type``. This should be type derived from
  :class:`VertexPartition.MutableVertexPartition`, e.g.
  :class:`ModularityVertexPartition` or :class:`CPMVertexPartition`. Optionally
  an initial membership and edge weights can be provided. Remaining
  ``**kwargs`` are passed on to the constructor of the ``partition_type``,
  including for example a ``resolution_parameter``.

  Parameters
  ----------
  graph : :class:`ig.Graph`
    The graph for which to detect communities.

  partition_type : type of :class:`
    The type of partition to use for optimisation.

  initial_membership : list of int
    Initial membership for the partition. If :obj:`None` then defaults to a
    singleton partition.

  weights : list of double, or edge attribute
    Weights of edges. Can be either an iterable or an edge attribute.

  n_iterations : int
    Number of iterations to run the Leiden algorithm. By default, 2 iterations
    are run. If the number of iterations is negative, the Leiden algorithm is
    run until an iteration in which there was no improvement.

  max_comm_size : non-negative int
    Maximal total size of nodes in a community. If zero (the default), then
    communities can be of any size.

  seed : int
    Seed for the random number generator. By default uses a random seed
    if nothing is specified.

  **kwargs
    Remaining keyword arguments, passed on to constructor of
    ``partition_type``.

  Returns
  -------
  partition
    The optimised partition.

  See Also
  --------
  :func:`Optimiser.optimise_partition`

  Examples
  --------
  >>> G = ig.Graph.Famous('Zachary')
  >>> partition = la.find_partition(G, la.ModularityVertexPartition)

  """
  if not weights is None:
    kwargs['weights'] = weights
  partition = partition_type(graph,
                             initial_membership=initial_membership,
                             **kwargs)
  optimiser = Optimiser()

  optimiser.max_comm_size = max_comm_size

  if (not seed is None):
    optimiser.set_rng_seed(seed)

  optimiser.optimise_partition(partition, n_iterations)

  return partition

def find_partition_multiplex(graphs, partition_type, layer_weights=None, n_iterations=2, max_comm_size=0, seed=None, **kwargs):
  """ Detect communities for multiplex graphs.

  Each graph should be defined on the same set of vertices, only the edges may
  differ for different graphs. See
  :func:`Optimiser.optimise_partition_multiplex` for a more detailed
  explanation.

  Parameters
  ----------
  graphs : list of :class:`ig.Graph`
    List of :class:`ig.Graph` graphs to optimise.

  partition_type : type of :class:`MutableVertexPartition`
    The type of partition to use for optimisation (identical for all graphs).

  layer_weights : list of double
    List containing weights of each layer. If None (the default), then all 
    layers are weighted with 1.

  n_iterations : int
    Number of iterations to run the Leiden algorithm. By default, 2 iterations
    are run. If the number of iterations is negative, the Leiden algorithm is
    run until an iteration in which there was no improvement.

  max_comm_size : non-negative int
    Maximal total size of nodes in a community. If zero (the default), then
    communities can be of any size.

  seed : int
    Seed for the random number generator. By default uses a random seed
    if nothing is specified.

  **kwargs
    Remaining keyword arguments, passed on to constructor of ``partition_type``.

  Returns
  -------
  list of int
    membership of nodes.

  float
    Improvement in quality of combined partitions, see
    :func:`Optimiser.optimise_partition_multiplex`.

  Notes
  -----
  We don't return a partition in this case because a partition is always
  defined on a single graph. We therefore simply return the membership (which
  is the same for all layers).

  See Also
  --------
  :func:`Optimiser.optimise_partition_multiplex`

  :func:`slices_to_layers`

  Examples
  --------
  >>> n = 100
  >>> G_1 = ig.Graph.Lattice([n], 1)
  >>> G_2 = ig.Graph.Lattice([n], 1)
  >>> membership, improvement = la.find_partition_multiplex([G_1, G_2],
  ...                                                       la.ModularityVertexPartition)
  """
  if layer_weights is None:
    n_layers = len(graphs)
    layer_weights = [1]*n_layers

  partitions = []  
  for graph in graphs:
    partitions.append(partition_type(graph, **kwargs))
  optimiser = Optimiser()

  optimiser.max_comm_size = max_comm_size;

  if (not seed is None):
    optimiser.set_rng_seed(seed)

  improvement = optimiser.optimise_partition_multiplex(partitions, layer_weights, n_iterations)

  return partitions[0].membership, improvement

def find_partition_temporal(graphs, partition_type,
                            interslice_weight=1,
                            slice_attr='slice', vertex_id_attr='id',
                            edge_type_attr='type', weight_attr='weight',
                            n_iterations=2, max_comm_size=0, seed=None,
                            **kwargs):
  """ Detect communities for temporal graphs.

  Each graph is considered to represent a time slice and does not necessarily
  need to be defined on the same set of vertices. Nodes in two consecutive
  slices are identified on the basis of the ``vertex_id_attr``, i.e. if two
  nodes in two consecutive slices have an identical value of the
  ``vertex_id_attr`` they are coupled.  The ``vertex_id_attr`` should hence be
  unique in each slice. The nodes are then coupled with a weight of
  ``interslice_weight`` which is set in the edge attribute ``weight_attr``. No
  weight is set if the ``interslice_weight`` is None (i.e.  corresponding in
  practice with a weight of 1). See :func:`time_slices_to_layers` for
  a more detailed explanation.

  Parameters
  ----------
  graphs : list of :class:`ig.Graph`
    List of :class:`leidenalg.VertexPartition` layers to optimise.

  partition_type : type of :class:`VertexPartition.MutableVertexPartition`
    The type of partition to use for optimisation (identical for all graphs).

  interslice_weight : float
    The weight of the coupling between two consecutive time slices.

  slice_attr : string
    The vertex attribute to use for indicating the slice of a node.

  vertex_id_attr : string
    The vertex to use to identify nodes.

  edge_type_attr : string
    The edge attribute to use for indicating the type of link (`interslice` or
    `intraslice`).

  weight_attr : string
    The edge attribute used to indicate the weight.

  n_iterations : int
    Number of iterations to run the Leiden algorithm. By default, 2 iterations
    are run. If the number of iterations is negative, the Leiden algorithm is
    run until an iteration in which there was no improvement.

  max_comm_size : non-negative int
    Maximal total size of nodes in a community. If zero (the default), then
    communities can be of any size.

  seed : int
    Seed for the random number generator. By default uses a random seed
    if nothing is specified.

  **kwargs
    Remaining keyword arguments, passed on to constructor of
    ``partition_type``.

  Returns
  -------
  list of membership
    list containing for each slice the membership vector.

  float
    Improvement in quality of combined partitions, see
    :func:`Optimiser.optimise_partition_multiplex`.

  See Also
  --------
  :func:`time_slices_to_layers`

  :func:`slices_to_layers`

  Examples
  --------
  >>> n = 100
  >>> G_1 = ig.Graph.Lattice([n], 1)
  >>> G_1.vs['id'] = range(n)
  >>> G_2 = ig.Graph.Lattice([n], 1)
  >>> G_2.vs['id'] = range(n)
  >>> membership, improvement = la.find_partition_temporal([G_1, G_2],
  ...                                                      la.ModularityVertexPartition,
  ...                                                      interslice_weight=1)
  """
  # Create layers
  G_layers, G_interslice, G = time_slices_to_layers(graphs,
                                                    interslice_weight,
                                                    slice_attr=slice_attr,
                                                    vertex_id_attr=vertex_id_attr,
                                                    edge_type_attr=edge_type_attr,
                                                    weight_attr=weight_attr)
  # Optimise partitions
  arg_dict = {}
  if 'node_sizes' in partition_type.__init__.__code__.co_varnames:
    arg_dict['node_sizes'] = 'node_size'

  if 'weights' in partition_type.__init__.__code__.co_varnames:
    arg_dict['weights'] = 'weight'

  arg_dict.update(kwargs)

  partitions = []
  for H in G_layers:
    arg_dict['graph'] = H
    partitions.append(partition_type(**arg_dict))

  # We can always take the same interslice partition, as this should have no
  # cost in the optimisation.
  partition_interslice = CPMVertexPartition(G_interslice, resolution_parameter=0,
                                            node_sizes='node_size', weights=weight_attr)
  optimiser = Optimiser()

  optimiser.max_comm_size = max_comm_size

  if (not seed is None):
    optimiser.set_rng_seed(seed)

  improvement = optimiser.optimise_partition_multiplex(partitions + [partition_interslice], n_iterations=n_iterations)

  # Transform results back into original form.
  membership = {(v[slice_attr], v[vertex_id_attr]): m for v, m in zip(G.vs, partitions[0].membership)}

  membership_time_slices = []
  for slice_idx, H in enumerate(graphs):
    membership_slice = [membership[(slice_idx, v[vertex_id_attr])] for v in H.vs]
    membership_time_slices.append(list(membership_slice))
  return membership_time_slices, improvement

#%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
# These are helper functions to create a proper
# disjoint union in python. The igraph implementation
# currently does not keep the attributes when creating
# a disjoint_union.
def get_attrs_or_nones(seq, attr_name):
  try:
    return seq[attr_name]
  except KeyError:
    return [None] * len(seq)

def disjoint_union_attrs(graphs):
  G = _ig.Graph.disjoint_union(graphs[0], graphs[1:])

  vertex_attributes = set(sum([H.vertex_attributes() for H in graphs], []))
  edge_attributes = set(sum([H.edge_attributes() for H in graphs], []))

  for attr in vertex_attributes:
    attr_value = sum([get_attrs_or_nones(H.vs, attr) for H in graphs], [])
    G.vs[attr] = attr_value
  for attr in edge_attributes:
    attr_value = sum([get_attrs_or_nones(H.es, attr) for H in graphs], [])
    G.es[attr] = attr_value

  return G

#%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
# Conversion to layer graphs

def time_slices_to_layers(graphs,
                          interslice_weight=1,
                          slice_attr='slice',
                          vertex_id_attr='id',
                          edge_type_attr='type',
                          weight_attr='weight'):
  """ Convert time slices to layer graphs.

  Each graph is considered to represent a time slice. This function simply
  connects all the consecutive slices (i.e. the slice graph) with an
  ``interslice_weight``.  The further conversion is then delegated to
  :func:`slices_to_layers`, which also provides further details.

  See Also
  --------
  :func:`find_partition_temporal`

  :func:`slices_to_layers`

  """
  G_slices = _ig.Graph.Tree(len(graphs), 1, mode=_ig.TREE_UNDIRECTED)
  G_slices.es[weight_attr] = interslice_weight
  G_slices.vs[slice_attr] = graphs
  return slices_to_layers(G_slices,
                          slice_attr,
                          vertex_id_attr,
                          edge_type_attr,
                          weight_attr)

def slices_to_layers(G_coupling,
                     slice_attr='slice',
                     vertex_id_attr='id',
                     edge_type_attr='type',
                     weight_attr='weight'):
  """ Convert a coupling graph of slices to layers of graphs.

  This function converts a graph of slices to layers so that they can be used
  with this package. 
  
  This function assumes that the slices are represented by
  nodes in ``G_coupling``, and stored in the attribute ``slice_attr``. In other
  words, ``G_coupling.vs[slice_attr]`` should contain :class:`ig.Graph` s . The
  slices will be converted to layers, and nodes in different slices will be
  coupled if the two slices are connected in ``G_coupling``. Nodes in two
  connected slices are identified on the basis of the ``vertex_id_attr``, i.e.
  if two nodes in two connected slices have an identical value of the
  ``vertex_id_attr`` they will be coupled. The ``vertex_id_attr`` should hence
  be unique in each slice.  Each node in the resulting layer graphs will contain
  two vertex attributes with the name of ``slice_attr`` and ``vertex_id_attr``
  that refer respectively to the slice and id of the node.
  
  The weight of the coupling is determined by the
  weight of this link in ``G_coupling``, as determined by the ``weight_attr``.

  Parameters
  ----------
  G_coupling : :class:`ig.Graph`
    The graph connecting the different slices.

  slice_attr : string
    The vertex attribute which contains the slices.

  vertex_id_attr : string
    The vertex attribute which is used to identify whether two nodes in two
    slices represent the same node, and hence, should be coupled.

  edge_type_attr : string
    The edge attribute to use for indicating the type of link (``interslice``
    or ``intraslice``).

  weight_attr : string
    The edge attribute used to indicate the (coupling) weight.

  Returns
  -------
  G_layers : list of :class:`ig.Graph`
    A list of slices converted to layers.

  G_interslice : :class:`ig.Graph`
    The interslice coupling layer.

  G : :class:`ig.Graph`
    The complete graph containing all layers and interslice couplings.

  Notes
  -----
  The distinction between slices and layers is not easy to grasp. Slices in
  this context refer to graphs that somehow represents different aspects of a
  network. The simplest example is probably slices that represents time: there
  are different snapshots network across time, and each snapshot is considered
  a slice. Some nodes may drop out of the network over time, while others enter
  the network. Edges may change over time, or the weight of the links may
  change over time. This is just the simplest example of a slice, and there may
  be different, more complex possibilities. Below an example with three time
  slices:

  .. image:: figures/slices.png

  Now in order to optimise partitions across these different slices, we
  represent them slightly differently, namely as layers. The idea of layers is
  that all graphs always are defined on the same set of nodes, and that only the
  links differ for different layers. We thus create new nodes as combinations of
  original nodes and slices. For example, if node 1 existed in both slice 1 and
  in slice 2, we will thus create two nodes to build the layers: a node 1-1 and
  a node 1-2. Additionally, if the slices are connected in the slice graph, the
  two nodes would also be connected, so there would be a linke between node 1-1
  and 1-2. Different slices will then correspond to different layers: each layer
  only contains the link for that particular slice. In addition, for methods
  such as :class:`CPMVertexPartition`, so-called ``node_sizes`` are required,
  and for them to properly function, they should be set to 1 only for nodes of a
  layer that represent nodes of the corresponding slice and 0 for the other
  nodes (which is handled appropriately in this function, and stored in the
  vertex attribute ``node_size``). Additionally, ``node_sizes`` should be set to
  0 for the interslice coupling layer. We thus obtain equally many layers as we
  have slices, and we need one more layer for representing the interslice
  couplings.  For the example provided above, we thus obtain the following:

  .. image:: figures/layers_separate.png

  The idea of doing community detection with slices is further detailed in [1].

  References
  ----------
  .. [1] Mucha, P. J., Richardson, T., Macon, K., Porter, M. A., & Onnela,
         J.-P. (2010).  Community structure in time-dependent, multiscale, and
         multiplex networks. Science, 328(5980), 876-8.
         `10.1126/science.1184819 <http://doi.org/10.1126/science.1184819>`_
  See Also
  --------
  :func:`find_partition_temporal`

  :func:`time_slices_to_layers`

  """
  if not slice_attr in G_coupling.vertex_attributes():
    raise ValueError("Could not find the vertex attribute {0} in the coupling graph.".format(slice_attr))

  if not weight_attr in G_coupling.edge_attributes():
    raise ValueError("Could not find the edge attribute {0} in the coupling graph.".format(weight_attr))

  # Create disjoint union of the time graphs
  for v_slice in G_coupling.vs:
    H = v_slice[slice_attr]
    H.vs[slice_attr] = v_slice.index
    if not vertex_id_attr in H.vertex_attributes():
      raise ValueError("Could not find the vertex attribute {0} to identify nodes in different slices.".format(vertex_id_attr ))
    if not weight_attr in H.edge_attributes():
      H.es[weight_attr] = 1

  G = disjoint_union_attrs(G_coupling.vs[slice_attr])
  G.es[edge_type_attr] = 'intraslice'

  for v_slice in G_coupling.vs:
    for u_slice in v_slice.neighbors(mode=_ig.OUT):
      if v_slice.index < u_slice.index or G_coupling.is_directed():
        nodes_v = G.vs.select(lambda v: v[slice_attr]==v_slice.index)[vertex_id_attr]
        if len(set(nodes_v)) != len(nodes_v):
          err = '\n'.join(
            ['\t{0} {1} times'.format(item, count) for item, count in Counter(nodes_v).items() if count > 1]
            )
          raise ValueError('No unique IDs for slice {0}, require unique IDs:\n{1}'.format(v_slice.index, err))
        nodes_u = G.vs.select(lambda v: v[slice_attr]==u_slice.index)[vertex_id_attr]
        if len(set(nodes_u)) != len(nodes_u):
          err = '\n'.join(
            ['\t{0} {1} times'.format(item, count) for item, count in Counter(nodes_u).items() if count > 1]
            )
          raise ValueError('No unique IDs for slice {0}, require unique IDs:\n{1}'.format(u_slice.index, err))
        common_nodes = set(nodes_v).intersection(set(nodes_u))
        nodes_v = sorted([v for v in G.vs if v[slice_attr] == v_slice.index and v[vertex_id_attr] in common_nodes], key=lambda v: v[vertex_id_attr])
        nodes_u = sorted([v for v in G.vs if v[slice_attr] == u_slice.index and v[vertex_id_attr] in common_nodes], key=lambda v: v[vertex_id_attr])
        edges = zip(nodes_v, nodes_u)
        e_start = G.ecount()
        G.add_edges(edges)
        e_end = G.ecount()
        e_idx = range(e_start, e_end)
        interslice_weight = G_coupling.es[G_coupling.get_eid(v_slice, u_slice)][weight_attr]
        if not interslice_weight is None:
          G.es[e_idx][weight_attr] = interslice_weight
        G.es[e_idx][edge_type_attr] = 'interslice'

  # Convert aggregate graph to individual layers for each time slice.
  G_layers = [None]*G_coupling.vcount()
  for v_slice in G_coupling.vs:
    H = G.subgraph_edges(G.es.select(_within=[v.index for v in G.vs if v[slice_attr] == v_slice.index]), delete_vertices=False)
    H.vs['node_size'] = [1 if v[slice_attr] == v_slice.index else 0 for v in H.vs]
    G_layers[v_slice.index] = H

  # Create one graph for the interslice links.
  G_interslice = G.subgraph_edges(G.es.select(type_eq='interslice'), delete_vertices=False)
  G_interslice.vs['node_size'] = 0

  return G_layers, G_interslice, G
