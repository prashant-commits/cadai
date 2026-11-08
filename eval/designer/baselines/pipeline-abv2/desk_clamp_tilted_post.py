throat_h = 40  # [40:1:60] Clear jaw gap
throat_d = 50  # [30:1:90] Throat depth
jaw_wall = 12  # [8:1:20] Jaw thickness
clamp_w = 30  # [24:1:60] Clamp width
boss_d = 20  # [16:1:26] Boss diameter
boss_up = 10  # [4:1:16] Boss height above lower jaw
screw_d = 8  # [4:0.5:10] Screw hole diameter
post_d = 18  # [12:1:26] Post diameter
post_len = 150  # [60:5:300] Post length
tilt = 15  # [0:1:30] Post tilt
post_x = 52  # [30:1:60] Post base centre x
edge_r = 3  # [0.5:0.5:10] edge radius
clamp_l = jaw_wall + throat_d
clamp_h = 2 * jaw_wall + throat_h
boss_x = jaw_wall + throat_d * 0.6

body = Pos(0, clamp_w, 0) * extrude(Plane.XZ * Polygon((0, 0), (clamp_l, 0), (clamp_l, jaw_wall), (jaw_wall, jaw_wall), (jaw_wall, jaw_wall + throat_h), (clamp_l, jaw_wall + throat_h), (clamp_l, clamp_h), (0, clamp_h), align=None), amount=clamp_w)
body = _round(body, edge_r, edges="outer")
boss = Pos(boss_x, clamp_w/2, jaw_wall) * Cylinder(boss_d/2, boss_up, align=(Align.CENTER, Align.CENTER, Align.MIN))
post = Pos(post_x, clamp_w/2, clamp_h-1) * Rot(0, -tilt, 0) * Cylinder(post_d/2, post_len, align=(Align.CENTER, Align.CENTER, Align.MIN))
hole = Pos(boss_x, clamp_w/2, -1) * Cylinder(screw_d/2, jaw_wall+boss_up+2, align=(Align.CENTER, Align.CENTER, Align.MIN))
body.label="c_body"; boss.label="screw_boss"; post.label="post"
_cadai_parts = [body, boss, post]
result = (body + boss + post) - hole