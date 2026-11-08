main_len = 60  # [30:1:200] Main tube length
od = 25  # [10:0.5:50] Tube outer diameter
wall_t = 2.5  # [1:0.5:5] Tube wall thickness
branch_len = 40  # [20:1:150] Branch open end height above main axis
p_id = od - 2 * wall_t
r = od / 2
cx = main_len / 2

main_o = Pos(0, 0, r) * Rot(0, 90, 0) * Cylinder(r, main_len, align=(Align.CENTER, Align.CENTER, Align.MIN))
br_o = Pos(cx, 0, r) * Cylinder(r, branch_len, align=(Align.CENTER, Align.CENTER, Align.MIN))
main_b = Pos(-0.02, 0, r) * Rot(0, 90, 0) * Cylinder(p_id / 2, main_len + 0.04, align=(Align.CENTER, Align.CENTER, Align.MIN))
br_b = Pos(cx, 0, r) * Cylinder(p_id / 2, branch_len + 1, align=(Align.CENTER, Align.CENTER, Align.MIN))

main_tube = main_o - main_b - br_b
branch_tube = br_o - main_o - br_b
main_tube.label = "main_tube"; branch_tube.label = "branch_tube"
_cadai_parts = [main_tube, branch_tube]
result = (main_o + br_o) - main_b - br_b
result.label = "pipe_tee_fitting"
