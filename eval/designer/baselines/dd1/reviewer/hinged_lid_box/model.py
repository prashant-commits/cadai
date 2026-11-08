from build123d import *

box_w = 100  # [60:5:200] width X
box_d = 70  # [40:5:150] depth Y
box_h = 50  # [30:5:100] body height
wall = 3
lid_t = 5
pin_d = 4
clr = 0.3
kn_r = 5
lid_open_deg = 0  # [0:5:110] lid angle

ay = box_d + kn_r + 0.5
az = box_h
M = (Align.MIN,)*3
def cx(x0, l, r):
    return Pos(x0 + l/2, ay, az) * Cylinder(r, l, rotation=(0, 90, 0))
body = Box(box_w, box_d, box_h, align=M)
body = fillet(body.edges().filter_by(Axis.Z), 3)
body = body - Pos(wall, wall, wall) * Box(box_w-2*wall, box_d-2*wall, box_h, align=M)
kl = 12; gap = 0.5
box = body
for x0 in (5, box_w-5-kl):
    box = box + cx(x0, kl, kn_r) + Pos(x0, box_d-3, az-2*kn_r) * Box(kl, ay-box_d+3, 2*kn_r, align=M)
lx = 5+kl+gap
lw = box_w-10-2*kl-2*gap
lid = Pos(0, 0, az) * Box(box_w, box_d, lid_t, align=M)
lid = fillet(lid.edges().filter_by(Axis.Z), 3)
lid = lid + Pos(lx, box_d-3, az) * Box(lw, ay-box_d+3, lid_t, align=M) + cx(lx, lw, kn_r)
lid = lid - cx(0, box_w, pin_d/2+clr)
box = box - cx(0, box_w, pin_d/2)
pin = cx(5.5, box_w-11, pin_d/2)
pin.label="pin"
lid = Pos(0, ay, az) * (Rot(X=-lid_open_deg) * (Pos(0, -ay, -az) * lid))
box.label="box"; lid.label="lid"
_cadai_parts=[box, lid, pin]
result = Compound([box, lid, pin])