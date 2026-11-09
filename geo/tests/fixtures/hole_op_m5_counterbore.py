# Generated from the approved Assembly Spec. Edit a parameter to preview; change the spec to keep it.
from build123d import *
import math as _math
from math import sin, cos, tan, radians, sqrt, pi

# Spec expressions take degrees; model bodies use the math functions above (radians).
def _sind(deg): return _math.sin(_math.radians(deg))
def _cosd(deg): return _math.cos(_math.radians(deg))
def _tand(deg): return _math.tan(_math.radians(deg))

def _fuse(items):
    groups = [([name], shape) for name, shape in items]
    merged = True
    while merged:
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                a, b = groups[i][1], groups[j][1]
                fused = a + b
                if len(fused.solids()) < len(a.solids()) + len(b.solids()):
                    groups[i] = (groups[i][0] + groups[j][0], fused)
                    del groups[j]
                    merged = True
                    break
            if merged:
                break
    out = []
    for names, shape in groups:
        shape.label = "+".join(names)
        out.append(shape)
    return out

# ---- cadai prelude end ----

plate = Box(40, 30, 10, align=(Align.CENTER, Align.CENTER, Align.MIN))
plate.label = "plate"
# cadai:op hole id=op_hole_m5cbor {"id":"op_hole_m5cbor","part":"plate","plane":{"origin":[0,0,10],"normal":[0,0,1],"xDir":[1,0,0]},"offset":[0,0],"rotationDeg":0,"kind":"hole","size":"M5","diameterMm":5.5,"head":"counterbore","depthMm":"through"}
op_hole_m5cbor_plane_orig_x = 0.0  # plane origin x mm
op_hole_m5cbor_plane_orig_y = 0.0  # plane origin y mm
op_hole_m5cbor_plane_orig_z = 10.0  # plane origin z mm
op_hole_m5cbor_plane_norm_x = 0.0  # plane normal x
op_hole_m5cbor_plane_norm_y = 0.0  # plane normal y
op_hole_m5cbor_plane_norm_z = 1.0  # plane normal z
op_hole_m5cbor_plane_xdir_x = 1.0  # plane x_dir x
op_hole_m5cbor_plane_xdir_y = 0.0  # plane x_dir y
op_hole_m5cbor_plane_xdir_z = 0.0  # plane x_dir z
op_hole_m5cbor_offset_x = 0.0  # offset x mm
op_hole_m5cbor_offset_y = 0.0  # offset y mm
op_hole_m5cbor_rotation = 0.0  # rotation deg
op_hole_m5cbor_diameter = 5.5  # clearance mm
op_hole_m5cbor_depth = 1000.0  # depth mm (through)
op_hole_m5cbor_overshoot = 0.01  # cutter overshoot mm
op_hole_m5cbor_cb_diameter = 10.0  # counterbore diameter mm
op_hole_m5cbor_cb_depth = 5.4  # counterbore depth mm
op_hole_m5cbor_plane = Plane(origin=(op_hole_m5cbor_plane_orig_x, op_hole_m5cbor_plane_orig_y, op_hole_m5cbor_plane_orig_z), z_dir=(op_hole_m5cbor_plane_norm_x, op_hole_m5cbor_plane_norm_y, op_hole_m5cbor_plane_norm_z), x_dir=(op_hole_m5cbor_plane_xdir_x, op_hole_m5cbor_plane_xdir_y, op_hole_m5cbor_plane_xdir_z))
op_hole_m5cbor_cutter = op_hole_m5cbor_plane * Pos(op_hole_m5cbor_offset_x, op_hole_m5cbor_offset_y, 0) * Rot(0, 0, op_hole_m5cbor_rotation) * (Pos(0, 0, -op_hole_m5cbor_depth) * Cylinder(radius=op_hole_m5cbor_diameter / 2, height=op_hole_m5cbor_depth + op_hole_m5cbor_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)) + Pos(0, 0, -op_hole_m5cbor_cb_depth) * Cylinder(radius=op_hole_m5cbor_cb_diameter / 2, height=op_hole_m5cbor_cb_depth + op_hole_m5cbor_overshoot, align=(Align.CENTER, Align.CENTER, Align.MIN)))
plate = plate - op_hole_m5cbor_cutter
# cadai:end op_hole_m5cbor
_cadai_parts = [plate]
result = Compound([plate])
