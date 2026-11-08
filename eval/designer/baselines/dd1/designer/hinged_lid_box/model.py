from build123d import *

L = 100  # box length X
W = 70
H = 50
wall = 3
lid_t = 4
pin_d = 4
clr = 0.3
kn_r = 4.5
kn_len = 12
lid_open_deg = 0  # [0:5:110] lid opening angle

ay = W + kn_r - 2
az = H
def cyl(r, a, b):
    return Pos((a+b)/2, ay, az) * Cylinder(r, b-a, rotation=(0,90,0))
def blk(a, b, z0, h):
    return Pos(a, W-3, z0) * Box(b-a, ay-W+3, h, align=(Align.MIN,)*3)
box = Box(L, W, H, align=(Align.MIN,)*3)
box = fillet(box.edges().filter_by(Axis.Z), 3)
box = box - Pos(wall, wall, wall) * Box(L-2*wall, W-2*wall, H, align=(Align.MIN,)*3)
a, b = kn_len+0.5, L-kn_len-0.5
box = box - cyl(kn_r+0.5, a, b)
for x0, x1 in [(0, kn_len), (L-kn_len, L)]:
    box = box + cyl(kn_r, x0, x1) + blk(x0, x1, az-2*kn_r, 2*kn_r)
box = box - cyl(pin_d/2+clr, -1, L+1)
pin = cyl(pin_d/2, 0.5, L-0.5)
pin.label = "pin"

lid = Pos(0, 0, H) * Box(L, W, lid_t, align=(Align.MIN,)*3)
lid = fillet(lid.edges().filter_by(Axis.Z), 3)
for x0, x1 in [(0, a), (b, L)]:
    lid = lid - Pos(x0-0.01, W-3, H-1) * Box(x1-x0+0.02, 10, lid_t+2, align=(Align.MIN,)*3)
lid = lid + cyl(kn_r, a, b) + blk(a, b, az, lid_t)
lid = lid - cyl(pin_d/2+clr, -1, L+1)
lid = Pos(0, ay, az) * Rot(-lid_open_deg, 0, 0) * Pos(0, -ay, -az) * lid
box.label = "box"; lid.label = "lid"
_cadai_parts = [box, lid, pin]
result = Compound([box, lid, pin])