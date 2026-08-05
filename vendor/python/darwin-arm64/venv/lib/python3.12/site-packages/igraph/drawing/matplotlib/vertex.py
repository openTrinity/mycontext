"""This module provides implementations of Matplotlib-specific vertex drawers,
i.e. drawers that the Matplotlib graph drawer will use to draw vertices.
"""

from math import pi

from igraph.drawing.baseclasses import AbstractVertexDrawer
from igraph.drawing.metamagic import AttributeCollectorBase
from igraph.drawing.shapes import ShapeDrawerDirectory
from igraph.drawing.matplotlib.utils import find_matplotlib
from igraph.drawing.utils import FakeModule

mpl, _ = find_matplotlib()
try:
    IdentityTransform = mpl.transforms.IdentityTransform
    PatchCollection = mpl.collections.PatchCollection
except AttributeError:
    IdentityTransform = FakeModule
    PatchCollection = FakeModule


__all__ = ("MatplotlibVertexDrawer", "VertexCollection")


class MatplotlibVertexDrawer(AbstractVertexDrawer):
    """Matplotlib backend-specific vertex drawer."""

    def __init__(self, ax, palette, layout):
        self.context = ax
        super().__init__(palette, layout)
        self.VisualVertexBuilder = self._construct_visual_vertex_builder()

    def _construct_visual_vertex_builder(self):
        class VisualVertexBuilder(AttributeCollectorBase):
            """Collects some visual properties of a vertex for drawing"""

            _kwds_prefix = "vertex_"
            color = ("red", self.palette.get)
            frame_color = ("black", self.palette.get)
            frame_width = 1.0
            label = None
            label_angle = -pi / 2
            label_dist = 0.0
            label_color = ("black", self.palette.get)
            font = "sans-serif"
            label_size = 12.0
            # FIXME? mpl.rcParams["font.size"])
            position = {"func": self.layout.__getitem__}
            shape = ("circle", ShapeDrawerDirectory.resolve_default)
            size = 30
            width = None
            height = None
            zorder = 2

        return VisualVertexBuilder

    def draw(self, visual_vertex, vertex, coords):
        """Build the Artist for a vertex and return it."""
        ax = self.context

        width = (
            visual_vertex.width
            if visual_vertex.width is not None
            else visual_vertex.size
        )
        height = (
            visual_vertex.height
            if visual_vertex.height is not None
            else visual_vertex.size
        )

        art = visual_vertex.shape.draw_path(
            ax,
            0,
            0,
            width,
            height,
            facecolor=visual_vertex.color,
            edgecolor=visual_vertex.frame_color,
            linewidth=visual_vertex.frame_width,
            zorder=visual_vertex.zorder,
            transform=IdentityTransform(),
        )
        return art


class VertexCollection(PatchCollection):
    """Collection of vertex patches for plotting.

    This class takes additional keyword arguments compared to PatchCollection:

    @param vertex_builder: A list of vertex builders to construct the visual
        vertices. This is updated if the size of the vertices is changed.
    @param size_callback: A function to be triggered after vertex sizes are
        changed. Typically this redraws the edges.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._stale_size = False

    def get_sizes(self):
        """Same as get_size."""
        return self.get_size()

    def get_size(self):
        """Get vertex sizes.

        If width and height are unequal, get the largest of the two.

        @return: An array of vertex sizes.
        """
        import numpy as np

        sizes = []
        for path in self.get_paths():
            bbox = path.get_extents()
            mins, maxs = bbox.min, bbox.max
            width, height = maxs - mins
            size = max(width, height)
            sizes.append(size)
        return np.array(sizes)

    def set_size(self, sizes):
        """Set vertex sizes.

        This rescales the current vertex symbol/path linearly, using this
        value as the largest of width and height.

        @param sizes: A sequence of vertex sizes or a single size.
        """
        paths = self._paths
        try:
            iter(sizes)
        except TypeError:
            sizes = [sizes] * len(paths)

        sizes = list(sizes)
        current_sizes = self.get_sizes()
        for path, cursize in zip(paths, current_sizes):
            # Circular use of sizes
            size = sizes.pop(0)
            sizes.append(size)
            # Rescale the path for this vertex
            path.vertices *= size / cursize

        self._stale_size = True
        self.stale = True

    def set_sizes(self, sizes):
        """Same as set_size."""
        self.set_size(sizes)

    @property
    def stale(self):
        return super().stale

    @stale.setter
    def stale(self, val):
        PatchCollection.stale.fset(self, val)
        if val and hasattr(self, "stale_callback_post"):
            self.stale_callback_post(self)
