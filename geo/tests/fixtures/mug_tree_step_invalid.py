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

# ---- parameters
base_d = 150  # [100:1:200] Round base diameter, stated by the user.
base_t = 10  # [5:1:25] Base disc thickness (assumed plain disc).
post_h = 250  # [150:5:400] Post height measured from the top of the base, stated by the user.
post_d = 20  # [10:1:40] Post diameter (assumed default).
peg_count = 4  # [3:1:8] Number of pegs around the post, stated as four.
peg_angle = 30  # [10:1:60] Peg tilt above horizontal, stated by the user.
peg_len = 60  # [30:1:90] Peg reach along its axis from the post axis (assumed default).
peg_d = 8  # [5:0.5:14] Peg diameter (assumed plain round peg).
peg_hub_drop = 10  # [0:1:40] Distance the peg hub sits below the post top (assumed so pegs stay within the post top band).
post_z0 = base_t
post_top = base_t + post_h
post_cx = base_d / 2
peg_hub_z = post_top - peg_hub_drop
peg_step = 360 / peg_count
peg_tip_rise = peg_len * _sind(peg_angle)
peg_tip_reach = peg_len * _cosd(peg_angle)
peg_tip_z = peg_hub_z + peg_tip_rise

# ---- placement (assembly coordinates, mm)
post_pos_x = base_d / 2 - post_d / 2  # Centred on the base: x = y = base_d/2 - post_d/2 = 65; starts at z = base_t = 10 and runs to z = 260.
post_pos_y = base_d / 2 - post_d / 2
post_pos_z = base_t
peg_1_pos_x = base_d / 2  # Hub on the post axis at x = 75; peg centreline on y = 75; hub at z = post_top - peg_hub_drop = 250.
peg_1_pos_y = base_d / 2 - peg_d / 2
peg_1_pos_z = peg_hub_z
peg_2_pos_x = base_d / 2  # Hub on the post axis; rotated 90 degrees about the post axis (z) from peg_1.
peg_2_pos_y = base_d / 2 - peg_d / 2
peg_2_pos_z = peg_hub_z
peg_3_pos_x = base_d / 2  # Hub on the post axis; rotated 180 degrees about z from peg_1.
peg_3_pos_y = base_d / 2 - peg_d / 2
peg_3_pos_z = peg_hub_z
peg_4_pos_x = base_d / 2  # Hub on the post axis; rotated 270 degrees about z from peg_1.
peg_4_pos_y = base_d / 2 - peg_d / 2
peg_4_pos_z = peg_hub_z

# ---- components, each in its own frame with the min corner at the origin
def base():
    part = Cylinder(base_d / 2, base_t, align=(Align.CENTER, Align.CENTER, Align.MIN))
    part = Pos(base_d / 2, base_d / 2, 0) * part
    return part

def post():
    part = Cylinder(post_d / 2, post_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    part = Pos(post_d / 2, post_d / 2, 0) * part
    return part

def peg_1():
    # hub at local origin; cylinder runs +X for peg_len, centred on local y/z at peg radius
    part = Cylinder(peg_d / 2, peg_len, rotation=(0, 90, 0), align=(Align.MIN, Align.CENTER, Align.CENTER))
    return part

def peg_2():
    # identical to peg_1; code applies the 90 degree rotation about the post axis via peg_step
    part = Cylinder(peg_d / 2, peg_len, rotation=(0, 90, 0), align=(Align.MIN, Align.CENTER, Align.CENTER))
    return part

def peg_3():
    # identical to peg_1; code applies the 180 degree rotation about the post axis via 2*peg_step
    part = Cylinder(peg_d / 2, peg_len, rotation=(0, 90, 0), align=(Align.MIN, Align.CENTER, Align.CENTER))
    return part

def peg_4():
    # identical to peg_1; code applies the 270 degree rotation about the post axis via 3*peg_step
    part = Cylinder(peg_d / 2, peg_len, rotation=(0, 90, 0), align=(Align.MIN, Align.CENTER, Align.CENTER))
    return part

# ---- parts: each measured in its own frame, then placed in the assembly (labelled)
_l_base = base()
_l_base.label = "base"
_p_base = Pos(0, 0, 0) * _l_base
_p_base.label = "base"
_l_post = post()
_l_post.label = "post"
_p_post = Pos(post_pos_x, post_pos_y, post_pos_z - 0.02) * _l_post
_p_post.label = "post"
_l_peg_1 = peg_1()
_l_peg_1.label = "peg_1"
_p_peg_1 = Pos(peg_1_pos_x, peg_1_pos_y, peg_1_pos_z) * Rot(0, -peg_angle, 0) * _l_peg_1
_p_peg_1.label = "peg_1"
_l_peg_2 = peg_2()
_l_peg_2.label = "peg_2"
_p_peg_2 = Pos(peg_2_pos_x, peg_2_pos_y, peg_2_pos_z) * Rot(0, 0, peg_step) * Rot(0, -peg_angle, 0) * _l_peg_2
_p_peg_2.label = "peg_2"
_l_peg_3 = peg_3()
_l_peg_3.label = "peg_3"
_p_peg_3 = Pos(peg_3_pos_x, peg_3_pos_y + 0.02, peg_3_pos_z) * Rot(0, 0, 2 * peg_step) * Rot(0, -peg_angle, 0) * _l_peg_3
_p_peg_3.label = "peg_3"
_l_peg_4 = peg_4()
_l_peg_4.label = "peg_4"
_p_peg_4 = Pos(peg_4_pos_x - 0.02, peg_4_pos_y, peg_4_pos_z) * Rot(0, 0, 3 * peg_step) * Rot(0, -peg_angle, 0) * _l_peg_4
_p_peg_4.label = "peg_4"
_local = [_l_base, _l_post, _l_peg_1, _l_peg_2, _l_peg_3, _l_peg_4]
_cadai_parts = [_p_base, _p_post, _p_peg_1, _p_peg_2, _p_peg_3, _p_peg_4]

# ---- fuse parts that really touch; jointContract partners stay separate solids
_group_1 = _fuse([("base", _p_base), ("post", _p_post), ("peg_1", _p_peg_1), ("peg_2", _p_peg_2), ("peg_3", _p_peg_3), ("peg_4", _p_peg_4)])

result = Compound(children=[*_group_1], label="mug_tree_variant_a")
