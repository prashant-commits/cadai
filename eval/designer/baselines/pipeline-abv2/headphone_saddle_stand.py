base_d = 140  # [100:5:200] Base diameter
base_t = 20  # [10:1:40] Base thickness
post_d = 16  # [10:1:30] Post diameter
total_h = 250  # [200:5:320] Overall height to top of saddle
saddle_r = 50  # [50:1:50] Saddle inner arc radius
saddle_wall = 6  # [3:1:12] Saddle wall
saddle_w = 30  # [20:1:50] Saddle width
ro = saddle_r + saddle_wall
sind = lambda d: sin(radians(d))
cosd = lambda d: cos(radians(d))
saddle_h = ro - saddle_r * cosd(60)
saddle_z = total_h - saddle_h
base = Cylinder(base_d/2, base_t, align=(Align.CENTER, Align.CENTER, Align.MIN))
base = _round(base, 4, edges="top")
post = Pos(0,0,base_t) * Cylinder(post_d/2, saddle_z - base_t + saddle_wall, align=(Align.CENTER, Align.CENTER, Align.MIN))
def pt(r,a): return (r*sind(a), ro - r*cosd(a))
outer = [pt(ro,a) for a in (-60,-30,0,30,60)]
inner = [pt(saddle_r,a) for a in (60,30,0,-30,-60)]
prof = make_face(Polyline(*(outer+inner), close=True))
saddle = Pos(0, saddle_w/2, saddle_z) * extrude(Plane.XZ * prof, amount=saddle_w)
base.label="base"; post.label="post"; saddle.label="saddle"
_cadai_parts = [base, post, saddle]
result = base + post + saddle
result.label="headphone_stand_a"
bb=result.bounding_box()
print(bb.min.Z,bb.max.Z,result.is_valid,len(result.solids()))