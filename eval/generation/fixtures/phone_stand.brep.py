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
base_w = 90  # [40:1:200] Base plate width along x
base_d = 120  # [60:1:200] Base plate depth along y
base_t = 6  # [2:0.5:15] Base plate thickness along z
backrest_w = 80  # [30:1:180] Backrest plate width along x
backrest_t = 5  # [2:0.5:10] Backrest plate thickness (tongue thickness)
backrest_len = 170  # [60:1:250] Backrest plate length along its tilted face
lean_deg = 65  # [30:1:85] Backrest lean angle measured from the base plane
slot_from_rear = 20  # [10:1:60] Distance from base rear edge to the slot centre line
phone_w = 75  # [50:1:100] Phone width (guide envelope)
phone_t = 8  # [5:0.5:12] Phone thickness (guide envelope)
phone_len = 145  # [100:1:180] Phone length along the backrest face (guide envelope)
phone_s0 = 10  # [0:1:30] Phone bottom edge offset up the backrest face from the backrest lower end
sin_l = _sind(lean_deg)
cos_l = _cosd(lean_deg)
slot_y = base_d - slot_from_rear
bk_px = (base_w - backrest_w) / 2
bk_py = slot_y + backrest_t * sin_l
ph_px = bk_px + (backrest_w - phone_w) / 2
ph_py = slot_y + phone_s0 * cos_l
ph_pz = phone_s0 * sin_l + backrest_t * cos_l

# ---- placement (assembly coordinates, mm)
backrest_plate_pos_x = bk_px  # x: (base_w - backrest_w)/2 centres it; y: slot_y + backrest_t*sin(lean) so the rotated lower corner lands on the slot line; z: 0 so the lower end touches the desk
backrest_plate_pos_y = bk_py

# ---- components, each in its own frame with the min corner at the origin
def base_plate():
    part = Box(base_w, base_d, base_t, align=(Align.MIN, Align.MIN, Align.MIN))
    return part

def backrest_plate():
    part = Box(backrest_w, backrest_len, backrest_t, align=(Align.MIN, Align.MIN, Align.MIN))
    return part

# ---- parts: each measured in its own frame, then placed in the assembly (labelled)
_l_base_plate = base_plate()
_l_base_plate.label = "base_plate"
_p_base_plate = Pos(0, 0, 0) * _l_base_plate
_p_base_plate.label = "base_plate"
_l_backrest_plate = backrest_plate()
_l_backrest_plate.label = "backrest_plate"
_p_backrest_plate = Pos(backrest_plate_pos_x, backrest_plate_pos_y, 0) * Rot(lean_deg, 0, 0) * _l_backrest_plate
_p_backrest_plate.label = "backrest_plate"
_local = [_l_base_plate, _l_backrest_plate]
_cadai_parts = [_p_base_plate, _p_backrest_plate]

# ---- mating cavities
_cav_base_plate = _p_base_plate - Pos(backrest_plate_pos_x, backrest_plate_pos_y, 0) * Rot(lean_deg, 0, 0) * Pos(-0.2, -0.2, -0.2) * Box((backrest_w) + 0.4, (backrest_len) + 0.4, (backrest_t) + 0.4, align=(Align.MIN, Align.MIN, Align.MIN))  # cavity for backrest_plate, 0.2 mm clearance
_cav_base_plate.label = "base_plate"

# ---- fuse parts that really touch; jointContract partners stay separate solids

result = Compound(children=[_cav_base_plate, _p_backrest_plate], label="phone_stand_variant_A_slot")
