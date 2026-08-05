#include "python_partition_interface.h"

Graph* create_graph_from_py(PyObject* py_obj_graph, PyObject* py_node_sizes)
{
  return create_graph_from_py(py_obj_graph, py_node_sizes, NULL, true, false);
}

Graph* create_graph_from_py(PyObject* py_obj_graph, PyObject* py_node_sizes, PyObject* py_weights)
{
  return create_graph_from_py(py_obj_graph, py_node_sizes, py_weights, true, false);
}

Graph* create_graph_from_py(PyObject* py_obj_graph, PyObject* py_node_sizes, PyObject* py_weights, bool check_positive_weight, bool correct_self_loops)
{
  #ifdef DEBUG
    cerr << "create_graph_from_py" << endl;
  #endif

  igraph_t* py_graph = (igraph_t*) PyCapsule_GetPointer(py_obj_graph, NULL);
  #ifdef DEBUG
    cerr << "Got igraph_t " << py_graph << endl;
  #endif

  // If necessary create a weighted graph
  Graph* graph = NULL;
  #ifdef DEBUG
    cerr << "Creating graph."<< endl;
  #endif

  size_t n = igraph_vcount(py_graph);
  size_t m = igraph_ecount(py_graph);

  vector<double> node_sizes;
  vector<double> weights;
  if (py_node_sizes != NULL && py_node_sizes != Py_None)
  {
    #ifdef DEBUG
      cerr << "Reading node_sizes." << endl;
    #endif

    size_t nb_node_size = PyList_Size(py_node_sizes);
    if (nb_node_size != n)
    {
      throw Exception("Node size vector not the same size as the number of nodes.");
    }
    node_sizes.resize(n);
    for (size_t v = 0; v < n; v++)
    {
      PyObject* py_item = PyList_GetItem(py_node_sizes, v);
      if (PyNumber_Check(py_item))
      {
        double e = PyFloat_AsDouble(py_item);
        node_sizes[v] = e;
      }
      else
      {
        throw Exception("Expected numerical values for node sizes vector.");
      }
    }
  }

  if (py_weights != NULL && py_weights != Py_None)
  {
    #ifdef DEBUG
      cerr << "Reading weights." << endl;
    #endif
    size_t nb_weights = PyList_Size(py_weights);
    if (nb_weights != m)
      throw Exception("Weight vector not the same size as the number of edges.");
    weights.resize(m);
    for (size_t e = 0; e < m; e++)
    {
      PyObject* py_item = PyList_GetItem(py_weights, e);
      if (PyNumber_Check(py_item))
      {
        weights[e] = PyFloat_AsDouble(py_item);
      }
      else
      {
        throw Exception("Expected floating point value for weight vector.");
      }

      if (check_positive_weight)
        if (weights[e] < 0 )
          throw Exception("Cannot accept negative weights.");

      if (isnan(weights[e]))
        throw Exception("Cannot accept NaN weights.");

      if (!isfinite(weights[e]))
        throw Exception("Cannot accept infinite weights.");
    }
  }

  if (node_sizes.size() == n)
  {
    if (weights.size() == m)
      graph = new Graph(py_graph, weights, node_sizes, correct_self_loops);
    else
      graph = Graph::GraphFromNodeSizes(py_graph, node_sizes, correct_self_loops);
  }
  else
  {
    if (weights.size() == m)
      graph = Graph::GraphFromEdgeWeights(py_graph, weights, correct_self_loops);
    else
      graph = new Graph(py_graph, correct_self_loops);
  }

  #ifdef DEBUG
    cerr << "Created graph " << graph << endl;
    cerr << "Number of nodes " << graph->vcount() << endl;
    cerr << "Number of edges " << graph->ecount() << endl;
    cerr << "Total weight " << graph->total_weight() << endl;
  #endif

  return graph;
}

vector<size_t> create_size_t_vector(PyObject* py_list)
{
    size_t n = PyList_Size(py_list);
    vector<size_t> result(n);
    for (size_t i = 0; i < n; i++)
    {
      PyObject* py_item = PyList_GetItem(py_list, i);
      if (PyNumber_Check(py_item) && PyIndex_Check(py_item))
      {
        size_t e = PyLong_AsSize_t(PyNumber_Long(py_item));
        if (e >= n)
          throw Exception("Value cannot exceed length of list.");
        else
          result[i] = e;
      }
      else
        throw Exception("Value cannot exceed length of list.");
    }
    return result;
}

PyObject* capsule_MutableVertexPartition(MutableVertexPartition* partition)
{
  PyObject* py_partition = PyCapsule_New(partition, "leidenalg.VertexPartition.MutableVertexPartition", del_MutableVertexPartition);
  return py_partition;
}

MutableVertexPartition* decapsule_MutableVertexPartition(PyObject* py_partition)
{
  MutableVertexPartition* partition = (MutableVertexPartition*) PyCapsule_GetPointer(py_partition, "leidenalg.VertexPartition.MutableVertexPartition");
  return partition;
}

void del_MutableVertexPartition(PyObject* py_partition)
{
  MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);
  delete partition;
}

#ifdef __cplusplus
extern "C"
{
#endif
  PyObject* _new_ModularityVertexPartition(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_obj_graph = NULL;
    PyObject* py_initial_membership = NULL;
    PyObject* py_weights = NULL;

    static const char* kwlist[] = {"graph", "initial_membership", "weights", NULL};

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O|OO", (char**) kwlist,
                                     &py_obj_graph, &py_initial_membership, &py_weights))
        return NULL;

    try
    {

      Graph* graph = create_graph_from_py(py_obj_graph, NULL, py_weights);

      ModularityVertexPartition* partition = NULL;

      // If necessary create an initial partition
      if (py_initial_membership != NULL && py_initial_membership != Py_None)
      {
        vector<size_t> initial_membership = create_size_t_vector(py_initial_membership);

        partition = new ModularityVertexPartition(graph, initial_membership);
      }
      else
        partition = new ModularityVertexPartition(graph);

      // Do *NOT* forget to remove the graph upon deletion
      partition->destructor_delete_graph = true;

      PyObject* py_partition = capsule_MutableVertexPartition(partition);
      #ifdef DEBUG
        cerr << "Created capsule partition at address " << py_partition << endl;
      #endif

      return py_partition;
    }
    catch (std::exception& e )
    {
      string s = "Could not construct partition: " + string(e.what());
      PyErr_SetString(PyExc_BaseException, s.c_str());
      return NULL;
    }
  }


  PyObject* _new_SignificanceVertexPartition(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_obj_graph = NULL;
    PyObject* py_initial_membership = NULL;
    PyObject* py_node_sizes = NULL;

    static const char* kwlist[] = {"graph", "initial_membership", "node_sizes", NULL};

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O|OO", (char**) kwlist,
                                     &py_obj_graph, &py_initial_membership, &py_node_sizes))
        return NULL;

    try
    {

      Graph* graph = create_graph_from_py(py_obj_graph, py_node_sizes);

      SignificanceVertexPartition* partition = NULL;

      // If necessary create an initial partition
      if (py_initial_membership != NULL && py_initial_membership != Py_None)
      {
        vector<size_t> initial_membership = create_size_t_vector(py_initial_membership);

        partition = new SignificanceVertexPartition(graph, initial_membership);
      }
      else
        partition = new SignificanceVertexPartition(graph);

      // Do *NOT* forget to remove the graph upon deletion
      partition->destructor_delete_graph = true;

      PyObject* py_partition = capsule_MutableVertexPartition(partition);
      #ifdef DEBUG
        cerr << "Created capsule partition at address " << py_partition << endl;
      #endif

      return py_partition;
    }
    catch (std::exception const & e )
    {
      string s = "Could not construct partition: " + string(e.what());
      PyErr_SetString(PyExc_BaseException, s.c_str());
      return NULL;
    }
  }

  PyObject* _new_SurpriseVertexPartition(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_obj_graph = NULL;
    PyObject* py_initial_membership = NULL;
    PyObject* py_weights = NULL;
    PyObject* py_node_sizes = NULL;

    static const char* kwlist[] = {"graph", "initial_membership", "weights", "node_sizes", NULL};

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O|OOO", (char**) kwlist,
                                     &py_obj_graph, &py_initial_membership, &py_weights, &py_node_sizes))
        return NULL;

    try
    {

      Graph* graph = create_graph_from_py(py_obj_graph, py_node_sizes, py_weights);

      SurpriseVertexPartition* partition = NULL;

      // If necessary create an initial partition
      if (py_initial_membership != NULL && py_initial_membership != Py_None)
      {
        vector<size_t> initial_membership = create_size_t_vector(py_initial_membership);

        partition = new SurpriseVertexPartition(graph, initial_membership);
      }
      else
        partition = new SurpriseVertexPartition(graph);

      // Do *NOT* forget to remove the graph upon deletion
      partition->destructor_delete_graph = true;

      PyObject* py_partition = capsule_MutableVertexPartition(partition);
      #ifdef DEBUG
        cerr << "Created capsule partition at address " << py_partition << endl;
      #endif

      return py_partition;
    }
    catch (std::exception const & e )
    {
      string s = "Could not construct partition: " + string(e.what());
      PyErr_SetString(PyExc_BaseException, s.c_str());
      return NULL;
    }
  }

  PyObject* _new_CPMVertexPartition(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_obj_graph = NULL;
    PyObject* py_initial_membership = NULL;
    PyObject* py_weights = NULL;
    PyObject* py_node_sizes = NULL;
    double resolution_parameter = 1.0;
    int correct_self_loops = false;

    static const char* kwlist[] = {"graph", "initial_membership", "weights", "node_sizes", "resolution_parameter", "correct_self_loops", NULL};

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O|OOOdp", (char**) kwlist,
                                     &py_obj_graph, &py_initial_membership, &py_weights, &py_node_sizes, &resolution_parameter, &correct_self_loops))
        return NULL;

    try
    {

      Graph* graph = create_graph_from_py(py_obj_graph, py_node_sizes, py_weights, false, correct_self_loops);

      CPMVertexPartition* partition = NULL;

      // If necessary create an initial partition
      if (py_initial_membership != NULL && py_initial_membership != Py_None)
      {
        vector<size_t> initial_membership = create_size_t_vector(py_initial_membership);

        partition = new CPMVertexPartition(graph, initial_membership, resolution_parameter);
      }
      else
        partition = new CPMVertexPartition(graph, resolution_parameter);

      // Do *NOT* forget to remove the graph upon deletion
      partition->destructor_delete_graph = true;

      PyObject* py_partition = capsule_MutableVertexPartition(partition);
      #ifdef DEBUG
        cerr << "Created capsule partition at address " << py_partition << endl;
      #endif

      return py_partition;
    }
    catch (std::exception const & e )
    {
      string s = "Could not construct partition: " + string(e.what());
      PyErr_SetString(PyExc_BaseException, s.c_str());
      return NULL;
    }
  }

  PyObject* _new_RBERVertexPartition(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_obj_graph = NULL;
    PyObject* py_initial_membership = NULL;
    PyObject* py_weights = NULL;
    PyObject* py_node_sizes = NULL;
    double resolution_parameter = 1.0;

    static const char* kwlist[] = {"graph", "initial_membership", "weights", "node_sizes", "resolution_parameter", NULL};

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O|OOOd", (char**) kwlist,
                                     &py_obj_graph, &py_initial_membership, &py_weights, &py_node_sizes, &resolution_parameter))
        return NULL;

    try
    {

      Graph* graph = create_graph_from_py(py_obj_graph, py_node_sizes, py_weights);

      RBERVertexPartition* partition = NULL;

      // If necessary create an initial partition
      if (py_initial_membership != NULL && py_initial_membership != Py_None)
      {
        vector<size_t> initial_membership = create_size_t_vector(py_initial_membership);

        partition = new RBERVertexPartition(graph, initial_membership, resolution_parameter);
      }
      else
        partition = new RBERVertexPartition(graph, resolution_parameter);

      // Do *NOT* forget to remove the graph upon deletion
      partition->destructor_delete_graph = true;

      PyObject* py_partition = capsule_MutableVertexPartition(partition);
      #ifdef DEBUG
        cerr << "Created capsule partition at address " << py_partition << endl;
      #endif

      return py_partition;
    }
    catch (std::exception const & e )
    {
      string s = "Could not construct partition: " + string(e.what());
      PyErr_SetString(PyExc_BaseException, s.c_str());
      return NULL;
    }
  }

  PyObject* _new_RBConfigurationVertexPartition(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_obj_graph = NULL;
    PyObject* py_initial_membership = NULL;
    PyObject* py_weights = NULL;
    double resolution_parameter = 1.0;

    static const char* kwlist[] = {"graph", "initial_membership", "weights", "resolution_parameter", NULL};

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O|OOd", (char**) kwlist,
                                     &py_obj_graph, &py_initial_membership, &py_weights, &resolution_parameter))
        return NULL;

    try
    {

      Graph* graph = create_graph_from_py(py_obj_graph, NULL, py_weights);

      RBConfigurationVertexPartition* partition = NULL;

      // If necessary create an initial partition
      if (py_initial_membership != NULL && py_initial_membership != Py_None)
      {
        vector<size_t> initial_membership = create_size_t_vector(py_initial_membership);

        partition = new RBConfigurationVertexPartition(graph, initial_membership, resolution_parameter);
      }
      else
        partition = new RBConfigurationVertexPartition(graph, resolution_parameter);

      // Do *NOT* forget to remove the graph upon deletion
      partition->destructor_delete_graph = true;

      PyObject* py_partition = capsule_MutableVertexPartition(partition);
      #ifdef DEBUG
        cerr << "Created capsule partition at address " << py_partition << endl;
      #endif

      return py_partition;
    }
    catch (std::exception const & e )
    {
      string s = "Could not construct partition: " + string(e.what());
      PyErr_SetString(PyExc_BaseException, s.c_str());
      return NULL;
    }
  }

  PyObject* _MutableVertexPartition_get_py_igraph(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;

    static const char* kwlist[] = {"partition", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O", (char**) kwlist,
                                     &py_partition))
        return NULL;

    #ifdef DEBUG
      cerr << "get_py_igraph();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    Graph* graph = partition->get_graph();

    size_t n = graph->vcount();
    size_t m = graph->ecount();

    PyObject* edges = PyList_New(m);
    for (size_t e = 0; e < m; e++)
    {
      vector<size_t> edge = graph->edge(e);
      PyList_SetItem(edges, e, Py_BuildValue("(nn)", edge[0], edge[1]));
    }

    PyObject* weights = PyList_New(m);
    for (size_t e = 0; e < m; e++)
    {
      PyObject* item = PyFloat_FromDouble(graph->edge_weight(e));
      PyList_SetItem(weights, e, item);
    }

    PyObject* node_sizes = PyList_New(n);
    for (size_t v = 0; v < n; v++)
    {
      PyObject* item = PyLong_FromSize_t(graph->node_size(v));
      PyList_SetItem(node_sizes, v, item);
    }

    return Py_BuildValue("lOOOO", n, graph->is_directed() ? Py_True : Py_False, edges, weights, node_sizes);
  }

  PyObject* _MutableVertexPartition_from_coarse_partition(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    PyObject* py_membership = NULL;
    PyObject* py_coarse_node = NULL;

    static const char* kwlist[] = {"partition", "membership", "coarse_node", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    // TODO : Instead of simply returning NULL, we should also set an error.
    if (!PyArg_ParseTupleAndKeywords(args, keywds, "OO|O", (char**) kwlist,
                                     &py_partition, &py_membership, &py_coarse_node))
        return NULL;

    #ifdef DEBUG
      cerr << "from_coarse_partition();" << endl;
    #endif

    vector<size_t> membership;
    try
    {
      membership = create_size_t_vector(py_membership);
    }
    catch (std::exception& e )
    {
      string s = "Could not create membership vector: " + string(e.what());
      PyErr_SetString(PyExc_BaseException, s.c_str());
      return NULL;
    }


    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    if (py_coarse_node != NULL && py_coarse_node != Py_None)
    {
      vector<size_t> coarse_node;
      try
      {
        coarse_node = create_size_t_vector(py_coarse_node);
      }
      catch (std::exception& e )
      {
        string s = "Could not create coarse node vector: " + string(e.what());
        PyErr_SetString(PyExc_BaseException, s.c_str());
        return NULL;
      }

      partition->from_coarse_partition(membership, coarse_node);
    }
    else
      partition->from_coarse_partition(membership);

    Py_INCREF(Py_None);
    return Py_None;
  }

  PyObject* _MutableVertexPartition_renumber_communities(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;

    static const char* kwlist[] = {"partition", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O", (char**) kwlist,
                                     &py_partition))
        return NULL;

    #ifdef DEBUG
      cerr << "renumber_communities();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    partition->renumber_communities();

    Py_INCREF(Py_None);
    return Py_None;
  }

  PyObject* _MutableVertexPartition_diff_move(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    size_t v;
    size_t new_comm;

    static const char* kwlist[] = {"partition", "v", "new_comm", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "Onn", (char**) kwlist,
                                     &py_partition, &v, &new_comm))
        return NULL;

    #ifdef DEBUG
      cerr << "diff_move(" << v << ", " << new_comm << ");" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    double diff = partition->diff_move(v, new_comm);
    return PyFloat_FromDouble(diff);
  }

  PyObject* _MutableVertexPartition_move_node(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    size_t v;
    size_t new_comm;

    static const char* kwlist[] = {"partition", "v", "new_comm", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "Onn", (char**) kwlist,
                                     &py_partition, &v, &new_comm))
        return NULL;

    #ifdef DEBUG
      cerr << "move_node(" << v << ", " << new_comm << ");" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    if (new_comm >= partition->get_graph()->vcount())
    {
      PyErr_SetString(PyExc_TypeError, "Community membership cannot exceed number of nodes.");
      return NULL;
    }
    else if (new_comm < 0)
    {
      PyErr_SetString(PyExc_TypeError, "Community membership cannot be negative");
      return NULL;
    }

    partition->move_node(v, new_comm);

    Py_INCREF(Py_None);
    return Py_None;
  }

  PyObject* _MutableVertexPartition_quality(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;

    static const char* kwlist[] = {"partition", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O", (char**) kwlist,
                                     &py_partition))
        return NULL;

    #ifdef DEBUG
      cerr << "quality();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    double q = partition->quality();
    return PyFloat_FromDouble(q);
  }

  PyObject* _MutableVertexPartition_aggregate_partition(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;

    static const char* kwlist[] = {"partition", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O", (char**) kwlist,
                                     &py_partition))
        return NULL;

    #ifdef DEBUG
      cerr << "aggregate_partition();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    // First collapse graph (i.e. community graph)
    Graph* collapsed_graph = partition->get_graph()->collapse_graph(partition);

    // Create collapsed partition (i.e. default partition of each node in its own community).
    MutableVertexPartition* collapsed_partition = partition->create(collapsed_graph);
    collapsed_partition->destructor_delete_graph = true;

    PyObject* py_collapsed_partition = capsule_MutableVertexPartition(collapsed_partition);
    return py_collapsed_partition;
  }

  PyObject* _MutableVertexPartition_total_weight_in_comm(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    size_t comm;

    static const char* kwlist[] = {"partition", "comm", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "On", (char**) kwlist,
                                     &py_partition, &comm))
        return NULL;

    #ifdef DEBUG
      cerr << "total_weight_in_comm(" << comm << ");" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    if (comm >= partition->n_communities())
    {
      PyErr_SetString(PyExc_IndexError, "Try to index beyond the number of communities.");
      return NULL;
    }

    double w = partition->total_weight_in_comm(comm);
    return PyFloat_FromDouble(w);
  }

  PyObject* _MutableVertexPartition_total_weight_from_comm(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    size_t comm;

    static const char* kwlist[] = {"partition", "comm", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "On", (char**) kwlist,
                                     &py_partition, &comm))
        return NULL;

    #ifdef DEBUG
      cerr << "total_weight_from_comm(" << comm << ");" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    if (comm >= partition->n_communities())
    {
      PyErr_SetString(PyExc_IndexError, "Try to index beyond the number of communities.");
      return NULL;
    }

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    double w = partition->total_weight_from_comm(comm);
    return PyFloat_FromDouble(w);
  }

  PyObject* _MutableVertexPartition_total_weight_to_comm(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    size_t comm;

    static const char* kwlist[] = {"partition", "comm", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "On", (char**) kwlist,
                                     &py_partition, &comm))
        return NULL;

    #ifdef DEBUG
      cerr << "total_weight_to_comm(" << comm << ");" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    if (comm >= partition->n_communities())
    {
      PyErr_SetString(PyExc_IndexError, "Try to index beyond the number of communities.");
      return NULL;
    }

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    double w = partition->total_weight_to_comm(comm);
    return PyFloat_FromDouble(w);
  }

  PyObject* _MutableVertexPartition_total_weight_in_all_comms(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;

    static const char* kwlist[] = {"partition", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O", (char**) kwlist,
                                     &py_partition))
        return NULL;

    #ifdef DEBUG
      cerr << "total_weight_in_all_comms();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    double w = partition->total_weight_in_all_comms();
    return PyFloat_FromDouble(w);
  }

  PyObject* _MutableVertexPartition_total_possible_edges_in_all_comms(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;

    static const char* kwlist[] = {"partition", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O", (char**) kwlist,
                                     &py_partition))
        return NULL;

    #ifdef DEBUG
      cerr << "total_possible_edges_in_all_comms();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    size_t e = partition->total_possible_edges_in_all_comms();
    return PyLong_FromSize_t(e);
  }

  PyObject* _MutableVertexPartition_weight_to_comm(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    size_t v;
    size_t comm;

    static const char* kwlist[] = {"partition", "v", "comm", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "Onn", (char**) kwlist,
                                     &py_partition, &v, &comm))
        return NULL;

    #ifdef DEBUG
      cerr << "weight_to_comm(" << v << ", " << comm << ");" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    if (comm >= partition->n_communities())
    {
      PyErr_SetString(PyExc_IndexError, "Try to index beyond the number of communities.");
      return NULL;
    }

    if (v >= partition->get_graph()->vcount())
    {
      PyErr_SetString(PyExc_IndexError, "Try to index beyond the number of nodes.");
      return NULL;
    }

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    double diff = partition->weight_to_comm(v, comm);
    return PyFloat_FromDouble(diff);
  }

  PyObject* _MutableVertexPartition_weight_from_comm(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    size_t v;
    size_t comm;

    static const char* kwlist[] = {"partition", "v", "comm", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "Onn", (char**) kwlist,
                                     &py_partition, &v, &comm))
        return NULL;

    #ifdef DEBUG
      cerr << "weight_to_comm(" << v << ", " << comm << ");" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    if (comm >= partition->n_communities())
    {
      PyErr_SetString(PyExc_IndexError, "Try to index beyond the number of communities.");
      return NULL;
    }

    if (v >= partition->get_graph()->vcount())
    {
      PyErr_SetString(PyExc_IndexError, "Try to index beyond the number of nodes.");
      return NULL;
    }

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    double diff = partition->weight_to_comm(v, comm);
    return PyFloat_FromDouble(diff);
  }

  PyObject* _MutableVertexPartition_get_membership(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    static const char* kwlist[] = {"partition", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O", (char**) kwlist,
                                     &py_partition))
        return NULL;

    #ifdef DEBUG
      cerr << "get_membership();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    size_t n = partition->get_graph()->vcount();
    PyObject* py_membership = PyList_New(n);
    for (size_t v = 0; v < n; v++)
    {
      PyObject* item = PyLong_FromSize_t(partition->membership(v));
      PyList_SetItem(py_membership, v, item);
    }
    return py_membership;
  }

  PyObject* _MutableVertexPartition_set_membership(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    PyObject* py_membership = NULL;

    static const char* kwlist[] = {"partition", "membership", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "OO", (char**) kwlist,
                                     &py_partition, &py_membership))
        return NULL;

    #ifdef DEBUG
      cerr << "set_membership();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    MutableVertexPartition* partition = decapsule_MutableVertexPartition(py_partition);

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    try
    {
      partition->set_membership(create_size_t_vector(py_membership));
    }
    catch (std::exception& e )
    {
      string s = "Could not set membership: " + string(e.what());
      PyErr_SetString(PyExc_BaseException, s.c_str());
      return NULL;
    }

    #ifdef DEBUG
      cerr << "Exiting set_membership();" << endl;
    #endif

    Py_INCREF(Py_None);
    return Py_None;
  }

  PyObject* _ResolutionParameterVertexPartition_get_resolution(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    static const char* kwlist[] = {"partition", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O", (char**) kwlist,
                                     &py_partition))
        return NULL;

    #ifdef DEBUG
      cerr << "get_resolution();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule ResolutionParameterVertexPartition at address " << py_partition << endl;
    #endif
    ResolutionParameterVertexPartition* partition = (ResolutionParameterVertexPartition*)decapsule_MutableVertexPartition(py_partition);
    #ifdef DEBUG
      cerr << "Using ResolutionParameterVertexPartition at address " << partition << endl;
    #endif

    return PyFloat_FromDouble(partition->resolution_parameter);
  }

  PyObject* _ResolutionParameterVertexPartition_set_resolution(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    double resolution_parameter = 1.0;
    static const char* kwlist[] = {"partition", "resolution_parameter", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "Od", (char**) kwlist,
                                     &py_partition, &resolution_parameter))
        return NULL;

    #ifdef DEBUG
      cerr << "set_resolution(" << resolution_parameter << ");" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule ResolutionParameterVertexPartition at address " << py_partition << endl;
    #endif
    ResolutionParameterVertexPartition* partition = (ResolutionParameterVertexPartition*)decapsule_MutableVertexPartition(py_partition);
    #ifdef DEBUG
      cerr << "Using ResolutionParameterVertexPartition at address " << partition << endl;
    #endif

    partition->resolution_parameter = resolution_parameter;

    Py_INCREF(Py_None);
    return Py_None;
  }

  PyObject* _ResolutionParameterVertexPartition_quality(PyObject *self, PyObject *args, PyObject *keywds)
  {
    PyObject* py_partition = NULL;
    PyObject* py_res = NULL;
    double resolution_parameter = 0.0;

    static const char* kwlist[] = {"partition", "resolution_parameter", NULL};

    #ifdef DEBUG
      cerr << "Parsing arguments..." << endl;
    #endif

    if (!PyArg_ParseTupleAndKeywords(args, keywds, "O|O", (char**) kwlist,
                                     &py_partition, &py_res))
        return NULL;

    #ifdef DEBUG
      cerr << "quality();" << endl;
    #endif

    #ifdef DEBUG
      cerr << "Capsule partition at address " << py_partition << endl;
    #endif

    ResolutionParameterVertexPartition* partition = (ResolutionParameterVertexPartition*)decapsule_MutableVertexPartition(py_partition);

    if (py_res != NULL && py_res != Py_None)
    {
      if (PyNumber_Check(py_res))
      {
        resolution_parameter = PyFloat_AsDouble(py_res);
      }
      else
      {
        PyErr_SetString(PyExc_TypeError, "Expected floating point value for resolution parameter.");
        return NULL;
      }

      if (isnan(resolution_parameter))
      {
        PyErr_SetString(PyExc_TypeError, "Cannot accept NaN resolution parameter.");
        return NULL;
      }
    }
    else
      resolution_parameter = partition->resolution_parameter;

    #ifdef DEBUG
      cerr << "Using partition at address " << partition << endl;
    #endif

    double q = partition->quality(resolution_parameter);
    return PyFloat_FromDouble(q);
  }

#ifdef __cplusplus
}
#endif
