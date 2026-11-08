from build123d import *
box_w = 100  # [60:1:200] Box width X
box_d = 70  # [40:1:150] Box depth Y
box_h = 50  # [20:1:100] Box height Z
wall = 3  # [2:0.5:6] Wall
lid_wall = 3  # [2:0.5:6] Lid thickness
pin_d = 4  # [2:0.5:6] Pin diameter
clr = 0.3  # [0.1:0.05:0.6] clearance
knuckle_d = 10  # [8:1:14] Knuckle OD
knuckle_len = 12  # [8:1:20] Knuckle length
knuckle_x = 10  # [5:1:20] inset
axis_off = 3  # [2:0.5:5] axis offset
lid_open_deg = 0  # [0:5:110] lid opening angle
bore_d = pin_d + 2*clr
axis_y = box_d + axis_off
axis_z = box_h
M = (Align.MIN, Align.MIN, Align.MIN)
CA = (Align.CENTER, Align.CENTER, Align.MIN)
def cyl(x0, r, L):
    return Pos(x0, axis_y, axis_z) * Rot(0, 90, 0) * Cylinder(r, L, align=CA)
def tube(x0):
    return cyl(x0, knuckle_d/2, knuckle_len) - cyl(x0-1, bore_d/2, knuckle_len+2)
body = Box(box_w, box_d, box_h, align=M)
body = fillet(body.edges().filter_by(Axis.Z), 2)
body = body - Pos(wall, wall, wall) * Box(box_w-2*wall, box_d-2*wall, box_h, align=M)
lid_flat = Box(box_w, box_d, lid_wall, align=M)
lid_flat = fillet(lid_flat.edges().filter_by(Axis.Z), 2)
lid_flat = Pos(0, 0, box_h) * lid_flat
lx1 = knuckle_x + knuckle_len + clr
lx2 = box_w - lx1 - knuckle_len
bx1 = knuckle_x
bx2 = box_w - knuckle_x - knuckle_len
def bweb(x):
    return Pos(x, box_d-1, box_h-knuckle_d/2) * Box(knuckle_len, axis_y-box_d+1, knuckle_d/2, align=M)
def lweb(x):
    return Pos(x, box_d-1, box_h) * Box(knuckle_len, axis_y-box_d+1, lid_wall, align=M)
relief = Compound([cyl(x-clr, knuckle_d/2+clr, knuckle_len+2*clr) for x in (lx1, lx2)])
body = body - relief
lid_flat = lid_flat - Compound([cyl(x-clr, knuckle_d/2+clr, knuckle_len+2*clr) for x in (bx1, bx2)])
for x in (bx1, bx2):
    body = body + tube(x) + bweb(x)
body = body - Compound([cyl(x-1, bore_d/2, knuckle_len+2) for x in (bx1, bx2)])
lid_all = lid_flat
for x in (lx1, lx2):
    lid_all = lid_all + tube(x) + lweb(x)
lid_all = lid_all - Compound([cyl(x-1, bore_d/2, knuckle_len+2) for x in (lx1, lx2)])
if lid_open_deg:
    lid_all = Pos(0, axis_y, axis_z) * Rot(-lid_open_deg,0,0) * Pos(0,-axis_y,-axis_z) * lid_all
L = knuckle_len*2+clr
pl = cyl(knuckle_x, pin_d/2, L)
pr = cyl(box_w-knuckle_x-L, pin_d/2, L)
for n, s in [("box_body", body), ("lid", lid_all), ("pin_left", pl), ("pin_right", pr)]:
    s.label = n
_cadai_parts = [body, lid_all, pl, pr]
result = Compound(children=_cadai_parts, label="Hinged box")
