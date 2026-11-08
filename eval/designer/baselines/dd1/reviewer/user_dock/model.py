from build123d import *
base_w = 260  # [200:10:320] width
base_d = 120  # [90:5:140] depth
base_h = 30  # [20:2:40] body height
back_h = 70  # [50:5:90] rear rest height
wall = 3  # [2:0.5:5] wall
lid_open_deg = 0  # [0:5:80] lid angle
lid_t = 3
tilt = 12
cav_d = 50

front = Box(base_w, base_d, base_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
back_d = 60
back = Pos(0, base_d/2 - back_d/2, 0) * Box(base_w, back_d, back_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
body = _round(front + back, 8, edges="all")
cy = -base_d/2 + wall + 4 + cav_d/2
cav = Pos(0, cy, wall) * Box(base_w - 2*wall - 20, cav_d, base_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
body = body - cav
def slot(x, w, l):
    return Pos(x, base_d/2 - 30, base_h + 12) * Rot(-tilt, 0, 0) * Box(l, w, 80, align=(Align.CENTER, Align.CENTER, Align.MIN))
body = body - slot(-35, 12, 170) - slot(85, 12, 60)
lid_w = base_w - 2*wall - 14
lid_d = cav_d + 4
lid = _round(Box(lid_w, lid_d, lid_t, align=(Align.CENTER, Align.MIN, Align.MIN)), 2, edges="vertical")
hy = cy + cav_d/2 + 1 - 6
lid = Pos(0, hy, base_h) * Rot(-lid_open_deg, 0, 0) * Pos(0, -lid_d, 0) * lid
lid.label = "lid"
body.label = "dock"
_cadai_parts = [body, lid]
result = Compound([body, lid])