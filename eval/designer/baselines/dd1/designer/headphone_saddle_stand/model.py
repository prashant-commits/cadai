from build123d import *
from math import sin, cos, radians

base_r = 70  # [50:5:100] base radius
base_h = 14  # [8:1:25] base height
post_r = 9  # [6:1:14] post radius
post_h = 230  # [150:10:300] post height above base
saddle_R = 50  # [30:5:80] saddle arc radius
saddle_arc = 120  # [60:10:180] arc angle
saddle_w = 40  # [25:5:60] saddle width
saddle_t = 8  # [5:1:12] saddle thickness

base = Cylinder(base_r, base_h, align=(Align.CENTER, Align.CENTER, Align.MIN))
base = fillet(base.edges().sort_by(Axis.Z)[-1], 5)
post = Pos(0, 0, base_h) * Cylinder(post_r, post_h, align=(Align.CENTER, Align.CENTER, Align.MIN))

top = base_h + post_h
half = saddle_arc / 2
ring = Circle(saddle_R + saddle_t) - Circle(saddle_R)
wedge = Polygon((0, 0), (200*sin(radians(-half)), -200*cos(radians(-half))),
                (200*sin(radians(half)), -200*cos(radians(half))), align=None)
sector = ring & wedge
saddle = extrude(Plane.XZ * sector, amount=saddle_w / 2, both=True)
saddle = Pos(0, 0, top + saddle_R) * saddle
post = post - saddle
base.label = "base"; post.label = "post"; saddle.label = "saddle"
_cadai_parts = [base, post, saddle]
result = base + post + saddle