from build123d import *
W = 150  # [100:5:250] shell width X
D = 120  # [80:5:200] depth Y
H = 80  # [50:5:150] height Z
wall = 3  # [2:0.5:6] wall
rail_w = 6  # [3:1:10] rail width
rail_h = 5  # [3:1:10] rail height
rail_z = 20  # [10:2:40] rail bottom z
clr = 0.5  # [0.2:0.1:1] clearance per side
front_t = 6  # [3:1:10] drawer front thickness
drawer_travel = 0  # [0:5:60] drawer slide out (keeps >=50 mm engaged on rails)

M = (Align.CENTER, Align.MIN, Align.MIN)
shell = _round(Box(W, D, H, align=M), 3, edges="outer")
iw = W-2*wall
shell = shell - Pos(0, -1, wall) * Box(iw, D-wall+1, H-2*wall, align=M)
rails = []
for s in (-1, 1):
    r = Pos(s*(iw/2 - rail_w/2), 0, rail_z) * Box(rail_w, D-wall-1, rail_h, align=M)
    r.label = "rail_L" if s < 0 else "rail_R"
    rails.append(r)
dw = iw - 2*clr
dd = D - wall - 1 - front_t   # tray length behind front; closed front is flush at y=0
dh = 40
bz = rail_z + rail_h
# tray: floor rides on rail tops; front panel flush with shell front
tray = Box(dw, dd, dh, align=M) - Pos(0, 0, 2) * Box(dw-4, dd-2, dh, align=M)
tray = Pos(0, front_t-1, bz) * tray
front = Pos(0, 0, bz) * Box(dw, front_t, dh, align=M)
front = _round(front, 1.5, edges="outer")
hx = 30
zc = bz + dh/2
posts = [Pos(sx*hx/2, -7, zc) * Cylinder(3, 8, rotation=(-90,0,0), align=(Align.CENTER,Align.CENTER,Align.MIN)) for sx in (-1,1)]
grip = Pos(0, -8, zc) * Cylinder(4, hx+8, rotation=(0,90,0))
drawer = tray + front + posts[0] + posts[1] + grip
drawer = Pos(0, -drawer_travel, 0) * drawer
drawer.label = "drawer"
shell.label = "shell"
_cadai_parts = [shell] + rails + [drawer]
result = Compound(_cadai_parts)