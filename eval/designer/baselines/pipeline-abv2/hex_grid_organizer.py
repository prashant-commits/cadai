from build123d import *
import math as _math
from math import sin, cos, tan, radians, sqrt, pi

tray_l = 200  # [150:1:300] Tray length
tray_w = 120  # [100:1:200] Tray width
tray_h = 40  # [20:1:80] Tray height
flat = 30  # [20:1:36] Hex pocket across flats
wall = 2  # [1:0.5:4] Wall between pockets
floor_wall = 2  # [1:0.5:6] Floor thickness
edge_r = 4  # [0.5:0.5:10] main edge radius
pitch = flat + wall
cx = pitch * 0.8660254
r = flat / 1.7320508
wall_h = tray_h - floor_wall

def hexp(x, y):
    return Pos(x, y, 0) * RegularPolygon(r, 6)

cols = [tray_l/2 + (i-1.5)*cx for i in range(4)]
cutters = None
polys = []
for i, x in enumerate(cols):
    ys = [tray_w/2 + (j-1)*pitch + (0.5*pitch if i % 2 == 0 else 0) - 0.25*pitch*0 for j in range(3)]
    off = -0.25*pitch if i % 2 == 0 else 0.25*pitch
    for j in range(3):
        y = tray_w/2 + (j-1)*pitch + off
        polys.append(hexp(x, y))
prof = Rectangle(tray_l, tray_w, align=(Align.MIN, Align.MIN))
for p in polys:
    prof = prof - p
walls = extrude(Plane.XY.offset(floor_wall - 0.02) * prof, amount=wall_h + 0.02)
floor = Box(tray_l, tray_w, floor_wall, align=(Align.MIN, Align.MIN, Align.MIN))
_cadai_parts = [floor, walls]
floor.label = "tray_floor"; walls.label = "tray_walls"
body = floor + walls
body = _round(body, edge_r, edges="vertical")
result = body
print(body.is_valid, len(body.solids()), body.bounding_box().size)