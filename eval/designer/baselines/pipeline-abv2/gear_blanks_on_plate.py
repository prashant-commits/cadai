from build123d import *
plate_l = 120  # [100:1:200] Plate length (x)
plate_w = 80  # [70:1:150] Plate width (y)
plate_t = 6  # [3:0.5:12] Plate thickness
shaft_spacing = 50  # [50:1:90] Shaft centre distance
shaft_d = 10  # [6:1:16] Shaft diameter
shaft_h = 14  # [10:1:30] Shaft height above plate
gear_large_d = 60  # [40:1:70] Large blank OD
gear_small_d = 40  # [20:1:60] Small blank OD
gear_t = 8  # [4:1:16] Blank thickness
gear_gap = 0.5  # [0:0.1:3] Gap between plate top and blank
edge_r = 2  # [0.5:0.5:10] main edge radius
ax = plate_l/2 - shaft_spacing/2
bx = plate_l/2 + shaft_spacing/2
cy = plate_w/2
gz = plate_t + gear_gap
plate = _round(Box(plate_l, plate_w, plate_t, align=(Align.MIN,Align.MIN,Align.MIN)), edge_r, edges="outer")
def shaft(x):
    return Pos(x, cy, plate_t-0.5) * Cylinder(shaft_d/2, shaft_h+0.5, align=(Align.CENTER,Align.CENTER,Align.MIN))
def gear(x, d):
    return Pos(x, cy, gz) * (Cylinder(d/2, gear_t, align=(Align.CENTER,Align.CENTER,Align.MIN)) - Cylinder(shaft_d/2, gear_t, align=(Align.CENTER,Align.CENTER,Align.MIN)))
sa=shaft(ax); sb=shaft(bx)
gl=gear(ax,gear_large_d); gs=gear(bx,gear_small_d)
for s,n in ((plate,"mounting_plate"),(sa,"shaft_a"),(sb,"shaft_b"),(gl,"gear_large"),(gs,"gear_small")): s.label=n
_cadai_parts=[plate,sa,sb,gl,gs]
body = plate+sa+sb
result = Compound([body, gl, gs])