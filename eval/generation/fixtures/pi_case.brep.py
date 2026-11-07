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
board_l = 85  # [85:1:85] Raspberry Pi 4 board length (X)
board_w = 56  # [56:1:56] Raspberry Pi 4 board width (Y)
board_t = 1.6  # [1.6:0.1:1.6] Raspberry Pi 4 board thickness
pat_x = 58  # [58:1:58] M2.5 mounting hole pattern spacing along X
pat_y = 49  # [49:1:49] M2.5 mounting hole pattern spacing along Y
hole_d = 2.7  # [2.4:0.1:3.2] Standoff bore diameter for M2.5 screw
standoff_h = 8  # [3:0.5:20] Standoff height above tray floor (assumed; user question)
standoff_od = 5  # [4:0.5:7] Standoff outer diameter (assumed)
wall = 2  # [1.5:0.5:4] Tray wall and floor thickness (assumed)
cav = 0  # [0:0.1:2] Inside clearance per side around the board (none in variant A; user question)
lid_t = 2  # [1:0.5:4] Flat lid plate thickness (suggested 2 mm)
cav_in_x = board_l + 2 * cav
cav_in_y = board_w + 2 * cav
tray_x = cav_in_x + 2 * wall
tray_y = cav_in_y + 2 * wall
wall_h = board_t + standoff_h + 2
tray_h = wall + wall_h
bx = wall + cav
by = wall + cav
bz = wall + standoff_h
so_x0 = (board_l - pat_x) / 2 - standoff_od / 2
so_x1 = so_x0 + pat_x
so_y0 = (board_w - pat_y) / 2 - standoff_od / 2
so_y1 = so_y0 + pat_y

# ---- placement (assembly coordinates, mm)
standoff_1_pos_x = bx + so_x0  # x = bx+so_x0 = (wall+cav)+(85-58)/2-2.5; y = by+so_y0 = (wall+cav)+(56-49)/2-2.5; z = wall on the floor
standoff_1_pos_y = by + so_y0
standoff_1_pos_z = wall
standoff_2_pos_x = bx + so_x1  # x = bx+so_x1 = bx+so_x0+58; y = by+so_y0; z = wall on the floor
standoff_2_pos_y = by + so_y0
standoff_2_pos_z = wall
standoff_3_pos_x = bx + so_x0  # x = bx+so_x0; y = by+so_y1 = by+so_y0+49; z = wall on the floor
standoff_3_pos_y = by + so_y1
standoff_3_pos_z = wall
standoff_4_pos_x = bx + so_x1  # x = bx+so_x1; y = by+so_y1; z = wall on the floor
standoff_4_pos_y = by + so_y1
standoff_4_pos_z = wall
lid_pos_z = tray_h  # z = tray_h = wall + board_t + standoff_h + 2 so the plate sits on the rim top; x,y = 0 over the tray outline

# ---- components, each in its own frame with the min corner at the origin
def tray():
    part = Box(tray_x, tray_y, tray_h, align=(Align.MIN, Align.MIN, Align.MIN))
    part = part - Pos(wall, wall, wall) * Box(tray_x - 2 * wall, tray_y - 2 * wall, tray_h - wall + 0.02, align=(Align.MIN, Align.MIN, Align.MIN))
    return part

def standoff_1():
    part = Pos(standoff_od / 2, standoff_od / 2, 0) * Cylinder(standoff_od / 2, standoff_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    part = part - Pos(standoff_od / 2, standoff_od / 2, -0.02) * Cylinder(hole_d / 2, standoff_h + 0.04, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return part

def standoff_2():
    part = Pos(standoff_od / 2, standoff_od / 2, 0) * Cylinder(standoff_od / 2, standoff_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    part = part - Pos(standoff_od / 2, standoff_od / 2, -0.02) * Cylinder(hole_d / 2, standoff_h + 0.04, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return part

def standoff_3():
    part = Pos(standoff_od / 2, standoff_od / 2, 0) * Cylinder(standoff_od / 2, standoff_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    part = part - Pos(standoff_od / 2, standoff_od / 2, -0.02) * Cylinder(hole_d / 2, standoff_h + 0.04, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return part

def standoff_4():
    part = Pos(standoff_od / 2, standoff_od / 2, 0) * Cylinder(standoff_od / 2, standoff_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
    part = part - Pos(standoff_od / 2, standoff_od / 2, -0.02) * Cylinder(hole_d / 2, standoff_h + 0.04, align=(Align.CENTER, Align.CENTER, Align.MIN))
    return part

def lid():
    part = Box(tray_x, tray_y, lid_t, align=(Align.MIN, Align.MIN, Align.MIN))
    return part

# ---- parts: each measured in its own frame, then placed in the assembly (labelled)
_l_tray = tray()
_l_tray.label = "tray"
_p_tray = Pos(0, 0, 0) * _l_tray
_p_tray.label = "tray"
_l_standoff_1 = standoff_1()
_l_standoff_1.label = "standoff_1"
_p_standoff_1 = Pos(standoff_1_pos_x, standoff_1_pos_y, standoff_1_pos_z) * _l_standoff_1
_p_standoff_1.label = "standoff_1"
_l_standoff_2 = standoff_2()
_l_standoff_2.label = "standoff_2"
_p_standoff_2 = Pos(standoff_2_pos_x, standoff_2_pos_y, standoff_2_pos_z) * _l_standoff_2
_p_standoff_2.label = "standoff_2"
_l_standoff_3 = standoff_3()
_l_standoff_3.label = "standoff_3"
_p_standoff_3 = Pos(standoff_3_pos_x, standoff_3_pos_y, standoff_3_pos_z) * _l_standoff_3
_p_standoff_3.label = "standoff_3"
_l_standoff_4 = standoff_4()
_l_standoff_4.label = "standoff_4"
_p_standoff_4 = Pos(standoff_4_pos_x, standoff_4_pos_y, standoff_4_pos_z) * _l_standoff_4
_p_standoff_4.label = "standoff_4"
_l_lid = lid()
_l_lid.label = "lid"
_p_lid = Pos(0, 0, lid_pos_z - 0.02) * _l_lid
_p_lid.label = "lid"
_local = [_l_tray, _l_standoff_1, _l_standoff_2, _l_standoff_3, _l_standoff_4, _l_lid]
_cadai_parts = [_p_tray, _p_standoff_1, _p_standoff_2, _p_standoff_3, _p_standoff_4, _p_lid]

# ---- fuse parts that really touch; jointContract partners stay separate solids
_group_1 = _fuse([("tray", _p_tray), ("standoff_1", _p_standoff_1), ("standoff_2", _p_standoff_2), ("standoff_3", _p_standoff_3), ("standoff_4", _p_standoff_4), ("lid", _p_lid)])

result = Compound(children=[*_group_1], label="pi4_case_variant_a")
