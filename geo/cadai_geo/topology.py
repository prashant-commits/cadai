"""B-Rep topology extraction and export for build123d shapes (Task 10)."""
from __future__ import annotations

import json
import os
from typing import Any

import build123d as b3d
from build123d import GeomType
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopExp import TopExp_Explorer

from cadai_geo.run import _replace_output


class _HashableEdge:
    __slots__ = ("occ", "edge", "_hash")

    def __init__(self, occ: Any) -> None:
        self.occ = occ
        self.edge = b3d.Edge(occ)
        self._hash = hash(self.edge)

    def __hash__(self) -> int:
        return self._hash

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, _HashableEdge):
            return False
        return bool(self.occ.IsSame(other.occ))


def _round6(val: float) -> float:
    return round(float(val), 6)


def _round4(val: float) -> float:
    return round(float(val), 4)


def export_topology(result: Any, parts: list[tuple[str, Any]] | None = None) -> dict[str, Any]:
    """Extract B-Rep faces, edges, part bounds, and tessellated triangle mesh."""
    if not parts:
        parts = [("", result)]

    mesh_positions: list[float] = []
    mesh_indices: list[int] = []
    mesh_face_ids: list[int] = []

    faces_list: list[dict[str, Any]] = []
    edges_list: list[dict[str, Any]] = []
    parts_list: list[dict[str, Any]] = []

    global_face_id = 0
    global_edge_id = 0

    for label, shape in parts:
        try:
            bb = shape.bounding_box()
            parts_list.append({
                "label": label,
                "min": [_round6(bb.min.X), _round6(bb.min.Y), _round6(bb.min.Z)],
                "max": [_round6(bb.max.X), _round6(bb.max.Y), _round6(bb.max.Z)],
            })
        except Exception:
            parts_list.append({
                "label": label,
                "min": [0.0, 0.0, 0.0],
                "max": [0.0, 0.0, 0.0],
            })

        part_edge_to_faces: dict[_HashableEdge, list[int]] = {}

        shape_faces = list(shape.faces()) if hasattr(shape, "faces") else []
        for face in shape_faces:
            face_id = global_face_id
            global_face_id += 1

            # Tessellation
            try:
                verts, tris = face.tessellate(tolerance=0.05, angular_tolerance=0.2)
            except Exception:
                verts, tris = [], []

            vertex_base = len(mesh_positions) // 3
            for v in verts:
                mesh_positions.extend([_round4(v.X), _round4(v.Y), _round4(v.Z)])
            for tri in tris:
                mesh_indices.extend([
                    tri[0] + vertex_base,
                    tri[1] + vertex_base,
                    tri[2] + vertex_base,
                ])
                mesh_face_ids.append(face_id)

            # Face properties
            kind = "other"
            if hasattr(face, "geom_type"):
                gt = face.geom_type
                if gt == GeomType.PLANE:
                    kind = "plane"
                elif gt == GeomType.CYLINDER:
                    kind = "cylinder"
                elif gt == GeomType.CONE:
                    kind = "cone"
                elif gt == GeomType.SPHERE:
                    kind = "sphere"
                elif gt == GeomType.TORUS:
                    kind = "torus"

            try:
                c = face.center()
                center_coords = [_round6(c.X), _round6(c.Y), _round6(c.Z)]
            except Exception:
                c = None
                center_coords = [0.0, 0.0, 0.0]

            try:
                area_val = _round6(face.area)
            except Exception:
                area_val = 0.0

            face_entry: dict[str, Any] = {
                "id": face_id,
                "part": label,
                "kind": kind,
                "area": area_val,
                "center": center_coords,
            }

            if kind == "plane":
                try:
                    norm = face.normal_at(c) if c is not None else face.normal_at()
                    face_entry["normal"] = [_round6(norm.X), _round6(norm.Y), _round6(norm.Z)]
                except Exception:
                    pass
            elif kind == "cylinder":
                try:
                    adaptor = BRepAdaptor_Surface(face.wrapped)
                    cyl = adaptor.Cylinder()
                    face_entry["radius"] = _round6(cyl.Radius())
                    axis_dir = cyl.Axis().Direction()
                    face_entry["axis"] = [_round6(axis_dir.X()), _round6(axis_dir.Y()), _round6(axis_dir.Z())]
                except Exception:
                    pass
            elif kind == "cone":
                try:
                    adaptor = BRepAdaptor_Surface(face.wrapped)
                    cone = adaptor.Cone()
                    face_entry["radius"] = _round6(cone.RefRadius())
                    axis_dir = cone.Axis().Direction()
                    face_entry["axis"] = [_round6(axis_dir.X()), _round6(axis_dir.Y()), _round6(axis_dir.Z())]
                except Exception:
                    pass
            elif kind == "sphere":
                try:
                    adaptor = BRepAdaptor_Surface(face.wrapped)
                    sph = adaptor.Sphere()
                    face_entry["radius"] = _round6(sph.Radius())
                    axis_dir = sph.Position().Axis().Direction()
                    face_entry["axis"] = [_round6(axis_dir.X()), _round6(axis_dir.Y()), _round6(axis_dir.Z())]
                except Exception:
                    pass
            elif kind == "torus":
                try:
                    adaptor = BRepAdaptor_Surface(face.wrapped)
                    tor = adaptor.Torus()
                    face_entry["radius"] = _round6(tor.MajorRadius())
                    axis_dir = tor.Axis().Direction()
                    face_entry["axis"] = [_round6(axis_dir.X()), _round6(axis_dir.Y()), _round6(axis_dir.Z())]
                except Exception:
                    pass

            faces_list.append(face_entry)

            # Map edges in this face
            try:
                exp = TopExp_Explorer(face.wrapped, TopAbs_EDGE)
                while exp.More():
                    he = _HashableEdge(exp.Current())
                    part_edge_to_faces.setdefault(he, []).append(face_id)
                    exp.Next()
            except Exception:
                pass

        # Build edge list for this part
        for he, f_ids in part_edge_to_faces.items():
            edge_id = global_edge_id
            global_edge_id += 1
            edge = he.edge

            e_kind = "other"
            if hasattr(edge, "geom_type"):
                egt = edge.geom_type
                if egt == GeomType.LINE:
                    e_kind = "line"
                elif egt == GeomType.CIRCLE:
                    e_kind = "circle"

            try:
                length_val = _round6(edge.length)
            except Exception:
                length_val = 0.0

            edge_entry: dict[str, Any] = {
                "id": edge_id,
                "kind": e_kind,
                "length": length_val,
                "faces": f_ids,
            }

            if e_kind == "circle":
                try:
                    edge_entry["radius"] = _round6(edge.radius)
                except Exception:
                    try:
                        adaptor = BRepAdaptor_Curve(edge.wrapped)
                        edge_entry["radius"] = _round6(adaptor.Circle().Radius())
                    except Exception:
                        pass
                try:
                    center = edge.arc_center
                    edge_entry["center"] = [_round6(center.X), _round6(center.Y), _round6(center.Z)]
                except Exception:
                    try:
                        adaptor = BRepAdaptor_Curve(edge.wrapped)
                        loc = adaptor.Circle().Location()
                        edge_entry["center"] = [_round6(loc.X()), _round6(loc.Y()), _round6(loc.Z())]
                    except Exception:
                        pass

            edges_list.append(edge_entry)

    return {
        "mesh": {
            "positions": mesh_positions,
            "indices": mesh_indices,
            "faceIds": mesh_face_ids,
        },
        "faces": faces_list,
        "edges": edges_list,
        "parts": parts_list,
    }


def write_topology(result: Any, part_shapes: list[tuple[str, Any]] | None, outdir: str | os.PathLike) -> None:
    """Compute topology and write outdir/topology.json with compact separators."""
    topo = export_topology(result, part_shapes)
    path = os.path.join(os.fspath(outdir), "topology.json")
    temporary = path + ".tmp"
    _replace_output(path)
    if os.path.lexists(temporary):
        os.unlink(temporary)
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(topo, handle, separators=(",", ":"))
    os.replace(temporary, path)
