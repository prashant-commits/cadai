from build123d import *
crate_l = 160  # [100:1:300] Outer length (x)
crate_w = 120  # [80:1:250] Outer width (y)
crate_h = 90  # [50:1:200] Overall height including lip
wall = 3  # [2:0.5:6] Wall and floor thickness
lip_h = 5  # [3:1:10] Stacking lip height
slot_l = 14  # [8:1:18] Vent slot length (sets slot pitch)
slot_h = 10  # [5:1:14] Vent slot height (opening diameter)
body_h = crate_h - lip_h
slot_pitch = slot_l + 6
slot_z = body_h / 2
M = (Align.MIN, Align.MIN, Align.MIN)
body = Box(crate_l, crate_w, body_h, align=M) - Pos(wall, wall, wall) * Box(crate_l-2*wall, crate_w-2*wall, body_h, align=M)
body = _round(body, 2, edges="vertical")
for i in range(-3, 3):
    c = (i + 0.5) * slot_pitch
    body = body - Pos(crate_l/2 + c, -1, slot_z) * Rot(-90, 0, 0) * Cylinder(slot_h/2, crate_w+2, align=(Align.CENTER, Align.CENTER, Align.MIN))
for i in range(-2, 2):
    c = (i + 0.5) * slot_pitch
    body = body - Pos(-1, crate_w/2 + c, slot_z) * Rot(0, 90, 0) * Cylinder(slot_h/2, crate_l+2, align=(Align.CENTER, Align.CENTER, Align.MIN))
ring = Pos(wall, wall, body_h) * (Box(crate_l-2*wall, crate_w-2*wall, lip_h, align=M) - Pos(wall, wall, -1) * Box(crate_l-4*wall, crate_w-4*wall, lip_h+2, align=M))
body.label = "crate_body"; ring.label = "stacking_lip"
_cadai_parts = [body, ring]
result = body + ring
result.label = "Stackable crate A"