from build123d import *
from math import sin, cos, radians

base_r = 80  # [50:5:120] base radius
base_h = 14  # [8:1:30] base height
post_r = 9  # [5:1:15] post radius
post_h = 220  # [150:5:300] post height above base
saddle_r = 50  # [30:5:80] saddle arc radius
saddle_arc = 120  # [60:5:180] saddle arc angle
saddle_w = 40  # [20:2:60] saddle width along headband
saddle_t = 10  # [4:1:14] saddle thickness
pad_h = 10  # [6:1:20] saddle hub height

base = Cylinder(base_r, base_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
base = _round(base, 4, edges="top")
post = Pos(0, 0, base_h) * Cylinder(post_r, post_h, align=(Align.CENTER, Align.CENTER, Align.MIN))

top_z = base_h + post_h
cz = top_z + saddle_r + pad_h
ro = saddle_r + saddle_t
half = saddle_arc / 2
ring = Cylinder(ro, saddle_w) - Cylinder(saddle_r, saddle_w + 2)
ring = Rot(90, 0, 0) * ring
wedge_pts = [(0, 0), (-3*ro*sin(radians(half)), -3*ro*cos(radians(half))),
             (-3*ro*sin(radians(half)), -3*ro), (3*ro*sin(radians(half)), -3*ro),
             (3*ro*sin(radians(half)), -3*ro*cos(radians(half)))]
wedge = extrude(Plane.XZ * Polygon(*wedge_pts, align=None), amount=saddle_w / 2 + 1, both=True)
hub = Pos(0, 0, top_z) * Cylinder(post_r + 6, pad_h + 3, align=(Align.CENTER, Align.CENTER, Align.MIN))
saddle = Pos(0, 0, cz) * (ring & wedge) + hub
base.label = "base"; post.label = "post"; saddle.label = "saddle"
_cadai_parts = [base, post, saddle]
result = Compound([base, post, saddle])