from build123d import *
import math as _math
from math import sin, cos, tan, radians, sqrt, pi
def _sind(deg): return _math.sin(_math.radians(deg))
def _cosd(deg): return _math.cos(_math.radians(deg))

plate_h = 150  # [100:5:300] Wall plate height
arm_len = 200  # [100:5:400] Shelf arm length along its axis
arm_angle = 90  # [80:1:100] Angle between plate face and arm
width = 30  # [15:1:80] Width of all members (x)
wall_t = 5  # [3:0.5:12] Plate and arm thickness
brace_t = 5  # [3:0.5:12] Brace strip thickness
brace_frac_plate = 0.5  # [0.2:0.05:0.8] Brace distance down plate, fraction
brace_frac_arm = 0.5  # [0.2:0.05:0.8] Brace distance along arm, fraction
sa = _sind(arm_angle); ca = _cosd(arm_angle)
dp = plate_h * brace_frac_plate
da = arm_len * brace_frac_arm
b1y = wall_t / 2
b1z = plate_h - dp
b2y = da * sa - wall_t * ca / 2
b2z = plate_h - wall_t * sa / 2 - da * ca
blen = sqrt((b2y-b1y)**2 + (b2z-b1z)**2)
hy = -(b2z-b1z)/blen*brace_t/2
hz = (b2y-b1y)/blen*brace_t/2
pts = [(b1y-hy,b1z-hz),(b2y-hy,b2z-hz),(b2y+hy,b2z+hz),(b1y+hy,b1z+hz)]

plate = Box(width, wall_t, plate_h, align=(Align.MIN,)*3)
arm = extrude(Plane.YZ * Polygon((0, plate_h-wall_t/sa),(arm_len*sa-wall_t*ca, plate_h-arm_len*ca-wall_t*sa),(arm_len*sa, plate_h-arm_len*ca),(0, plate_h), align=None), amount=width)
brace = extrude(Plane.YZ * Polygon(*pts, align=None), amount=width)
plate.label="wall_plate"; arm.label="shelf_arm"; brace.label="diagonal_brace"
_cadai_parts = [plate, arm, brace]
result = plate + arm + brace
