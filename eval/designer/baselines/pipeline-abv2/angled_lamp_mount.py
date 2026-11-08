from build123d import *
import math as _math
from math import sin, cos, tan, radians, sqrt, pi
def _sind(deg): return _math.sin(_math.radians(deg))
def _cosd(deg): return _math.cos(_math.radians(deg))
base_d = 100  # [80:1:160] Base diameter
base_t = 8  # [5:1:20] Base thickness
arm_len = 150  # [100:1:250] Arm edge length
arm_angle = 60  # [30:1:80] Arm angle from horizontal
arm_t = 12  # [6:1:25] Arm thickness perpendicular to axis
arm_w = 20  # [10:1:40] Arm width along x
ring_id = 40  # [20:1:80] Ring inner diameter
ring_wall = 8  # [3:1:15] Ring wall thickness
ring_h = 20  # [8:1:50] Ring height
ring_d = ring_id + 2 * ring_wall
run = arm_len * _cosd(arm_angle)
rise = arm_len * _sind(arm_angle)
wh = arm_t / _sind(arm_angle)
foot_y = base_d / 2 - 40
base = Pos(base_d/2, base_d/2, 0) * Cylinder(base_d/2, base_t, align=(Align.CENTER, Align.CENTER, Align.MIN))
base = _round(base, 2, edges="top")
arm = extrude(Plane.YZ * Polygon((0, 0), (wh, 0), (run + wh, rise), (run, rise), align=None), amount=arm_w)
arm = Pos(base_d/2 - arm_w/2, foot_y, base_t - 0.02) * arm
rh = Pos(0, 0, 0) * (Cylinder(ring_d/2, ring_h, align=(Align.CENTER, Align.CENTER, Align.MIN)) - Pos(0, 0, -0.02) * Cylinder(ring_id/2, ring_h + 0.04, align=(Align.CENTER, Align.CENTER, Align.MIN)))
rh = Pos(base_d/2, foot_y + run + wh - 4 + ring_d/2, base_t + rise - ring_h) * rh
base.label = "base"; arm.label = "arm"; rh.label = "ring_holder"
_cadai_parts = [base, arm, rh]
f = base + arm + rh
result = Compound(children=[f], label="lamp_mount_a")