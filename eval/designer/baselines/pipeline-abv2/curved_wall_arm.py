from build123d import *
import math as _math
def _sind(d): return _math.sin(_math.radians(d))
def _cosd(d): return _math.cos(_math.radians(d))
arm_r = 120  # [60:5:200] Arm outer quarter-circle radius
arm_t = 10  # [5:1:20] Arm thickness
arm_w = 20  # [10:1:40] Arm width
ring_id = 50  # [30:1:100] Ring inner diameter
ring_wall = 5  # [3:1:10] Ring wall
ring_h = 10  # [5:1:30] Ring height
plate_t = 8  # [4:1:15] Plate thickness
plate_w = 60  # [40:5:120] Plate width
plate_h = 100  # [60:5:200] Plate height
ring_od = ring_id + 2 * ring_wall
ri = arm_r - arm_t
pz = arm_r + arm_t - plate_h
def pt(r,a): return (arm_r + r*_cosd(a), arm_r + r*_sind(a))
angs = list(range(180,271,15))
pts = [pt(arm_r,a) for a in angs] + [pt(ri,a) for a in reversed(angs)]
arm = extrude(Plane.YZ * Polygon(*pts, align=None), amount=arm_w)
arm = Pos((plate_w-arm_w)/2, plate_t-1, 0) * arm
plate = Box(plate_w, plate_t, plate_h, align=(Align.MIN,)*3)
for zz in (plate_h/5, plate_h*0.8):
    plate = plate - Pos(plate_w/2, -1, zz) * Rot(-90,0,0) * Cylinder(2.5, plate_t+2, align=(Align.CENTER,Align.CENTER,Align.MIN))
plate = Pos(0,0,pz) * plate
cy = plate_t - 1 + arm_r + ring_od/2 - ring_wall
ringb = Pos(plate_w/2, cy, 0) * (Cylinder(ring_od/2, ring_h, align=(Align.CENTER,Align.CENTER,Align.MIN)))
ringb = ringb - Pos(plate_w/2, cy, -1) * Cylinder(ring_id/2, ring_h+2, align=(Align.CENTER,Align.CENTER,Align.MIN))
plate.label="wall_plate"; arm.label="quarter_arm"; ringb.label="ring"
_cadai_parts=[plate,arm,ringb]
result = plate+arm+ringb
bb=result.bounding_box()
print(bb.min,bb.max,len(result.solids()))