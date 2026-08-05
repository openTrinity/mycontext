from copy import deepcopy

from igraph.drawing.utils import calculate_corner_radii
from igraph.utils import consecutive_pairs
from igraph.drawing.utils import Point, FakeModule

from .utils import find_matplotlib

__all__ = ("HullCollection",)

mpl, plt = find_matplotlib()
try:
    PathCollection = mpl.collections.PathCollection
except AttributeError:
    PathCollection = FakeModule


class HullCollection(PathCollection):
    """Collection for hulls connecting vertex covers/clusters.

    The class takes the normal arguments of a PathCollection, plus one argument
    called "corner_radius" that specifies how much to smoothen the polygon
    vertices into round corners. This argument can be a float or a sequence
    of floats, one for each hull to be drawn.
    """

    def __init__(self, *args, **kwargs):
        self._corner_radii = kwargs.pop("corner_radius", None)
        super().__init__(*args, **kwargs)
        self._paths_original = deepcopy(self._paths)
        try:
            self._corner_radii = list(iter(self._corner_radii))
        except TypeError:
            self._corner_radii = [self._corner_radii for x in self._paths]

    def _update_paths(self):
        paths_original = self._paths_original
        corner_radii = self._corner_radii
        trans = self.axes.transData.transform
        trans_inv = self.axes.transData.inverted().transform

        for i, (path_orig, radius) in enumerate(zip(paths_original, corner_radii)):
            self._paths[i] = self._compute_path_with_corner_radius(
                path_orig,
                radius,
                trans,
                trans_inv,
            )

    @staticmethod
    def _round_corners(points, corner_radius):
        if corner_radius <= 0:
            return (points, None)

        # Rounded corners. First, we will take each side of the
        # polygon and find what the corner radius should be on
        # each corner. If the side is longer than 2r (where r is
        # equal to corner_radius), the radius allowed by that side
        # is r; if the side is shorter, the radius is the length
        # of the side / 2. For each corner, the final corner radius
        # is the smaller of the radii on the two sides adjacent to
        # the corner.
        corner_radii = calculate_corner_radii(points, corner_radius)

        # Okay, move to the last corner, adjusted by corner_radii[-1]
        # towards the first corner
        path = []
        codes = []
        path.append((points[-1].towards(points[0], corner_radii[-1])))
        codes.append(mpl.path.Path.MOVETO)

        # Now, for each point in points, draw a line towards the
        # corner, stopping before it in a distance of corner_radii[idx],
        # then draw the corner
        u = points[-1]
        for idx, (v, w) in enumerate(consecutive_pairs(points, True)):
            radius = corner_radii[idx]
            path.append(v.towards(u, radius))
            codes.append(mpl.path.Path.LINETO)

            aux1 = v.towards(u, radius / 2)
            aux2 = v.towards(w, radius / 2)

            path.append(aux1)
            path.append(aux2)
            path.append(v.towards(w, corner_radii[idx]))
            codes.extend([mpl.path.Path.CURVE4] * 3)
            u = v

        return (path, codes)

    @staticmethod
    def _expand_path(coordst, radius):
        if len(coordst) == 1:
            # Expand a rectangle around a single vertex
            a = Point(*coordst[0])
            c = Point(radius, 0)
            n = Point(-c[1], c[0])
            polygon = [a + n, a - c, a - n, a + c]
        elif len(coordst) == 2:
            # Flat line, make it an actual shape
            a, b = Point(*coordst[0]), Point(*coordst[1])
            c = radius * (a - b).normalized()
            n = Point(-c[1], c[0])
            polygon = [a + n, b + n, b - c, b - n, a - n, a + c]
        else:
            # Expand the polygon around its center of mass
            center = Point(
                *[sum(coords) / float(len(coords)) for coords in zip(*coordst)]
            )
            polygon = [Point(*point).towards(center, -radius) for point in coordst]
        return polygon

    def _compute_path_with_corner_radius(
        self,
        path_orig,
        radius,
        trans,
        trans_inv,
    ):
        # Move to point/canvas coordinates
        coordst = trans(path_orig.vertices)
        # Expand around vertices
        polygon = self._expand_path(coordst, radius)
        # Compute round corners
        (polygon, codes) = self._round_corners(polygon, radius)
        # Return to data coordinates
        polygon = [trans_inv(x) for x in polygon]
        return mpl.path.Path(polygon, codes)

    def draw(self, renderer):
        if self._corner_radii is not None:
            self._update_paths()
        return super().draw(renderer)
