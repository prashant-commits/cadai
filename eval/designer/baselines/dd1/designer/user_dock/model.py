from build123d import *
base_w = 260  # [200:10:320] width
base_d = 110  # [90:5:140] depth
base_h = 40  # [30:2:60] body height
wall = 3  # [2:0.5:5] wall
lid_open_deg = 0  # [0:5:100] lid opening angle
tab_slot_w = 12  # [9:1:16] tablet slot width
ph_slot_w = 12  # [10:1:16] phone slot width
tilt = 15
lid_t = 4

body = Box(base_w, base_d, base_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
body = _round(body, 8, edges="all")
cav_w = base_w - 2*wall - 20
cy = -base_d/2 + 55
body = body - Pos(0, cy, base_h - 25 + 0.01) * Box(cav_w, 40, 25, align=(Align.CENTER, Align.CENTER, Align.MIN))
body = body - Pos(0, cy, base_h - 2) * Box(cav_w + 6, 46, 3, align=(Align.CENTER, Align.CENTER, Align.MIN))
back = _round(Pos(0, base_d/2 - 12, base_h) * Box(base_w - 16, 20, 40, align=(Align.CENTER, Align.CENTER, Align.MIN)), 6, edges="all")
body = body + back
body = body - Pos(0, base_d/2 - 12, base_h + 25) * Rot(-tilt, 0, 0) * Box(base_w - 40, tab_slot_w, 60)
body = body - Pos(0, -base_d/2 + 18, base_h) * Rot(-tilt, 0, 0) * Box(100, ph_slot_w, 30)

hy = cy - 22
lid = Pos(0, cy - 22, base_h - 2) * Box(cav_w + 2, 44, lid_t, align=(Align.CENTER, Align.MIN, Align.MIN))
lid = _round(lid, 1.5, edges="all")
lid = Pos(0, hy, base_h + 2) * Rot(lid_open_deg, 0, 0) * Pos(0, -hy, -(base_h + 2)) * lid
body.label = "body"; lid.label = "lid"
_cadai_parts = [body, lid]
result = Compound([body, lid])