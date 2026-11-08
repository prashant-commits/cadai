from build123d import *

W = 150  # [100:5:250] outer width X
D = 120  # [80:5:200] outer depth Y
H = 80  # [50:5:150] outer height Z
wall = 3  # [2:0.5:6] shell wall
rail_h = 4  # [2:1:8] rail height
rail_w = 6  # [3:1:10] rail protrusion
rail_z = 15  # [5:1:40] rail height above floor
clr = 0.5  # [0.2:0.1:1] side clearance
dwall = 2.5  # [2:0.5:4] drawer wall
dh = 40  # [20:5:60] drawer height
drawer_travel = 0  # [0:5:90] drawer slide out

MM = (Align.CENTER, Align.MIN, Align.MIN)
iw = W - 2*wall
shell = Box(W, D, H, align=MM) - Pos(0, -1, wall) * Box(iw, D-wall+1, H-2*wall, align=MM)
for s in (-1, 1):
    shell = shell + Pos(s*(iw/2 - rail_w/2), 0, wall+rail_z) * Box(rail_w, D-wall, rail_h, align=MM)

dw = iw - 2*clr
dl = D - wall - 5
zr = wall + rail_z + rail_h
body = Box(dw, dl, dh, align=MM) - Pos(0, dwall, dwall) * Box(dw-2*dwall, dl, dh, align=MM)
front = Pos(0, -dwall*2, 0) * Box(W-2, dwall*2, dh, align=MM)
handle = Pos(0, -dwall*2, dh/2 - 5) * Box(50, 12, 10, align=(Align.CENTER, Align.MAX, Align.MIN))
handle = Pos(0, 0, 0) * handle
# handle with finger recess: hollow it from below
grip = Pos(0, -dwall*2-12, dh/2-5) * Box(50, 12, 10, align=MM)
grip = grip - Pos(0, -dwall*2-12+3, dh/2-5-1) * Box(44, 12, 6, align=MM)
drawer = body + front + grip
drawer = Pos(0, -0.5 - drawer_travel + 0.5, zr + 0.01) * drawer
shell.label = "shell_with_rails"
drawer.label = "drawer"
_cadai_parts = [shell, drawer]
result = Compound([shell, drawer])