plate = Box(40, 20, 5, align=(Align.CENTER, Align.CENTER, Align.MIN))
# cadai:op text id=op_text01 {"kind":"text","id":"op_text01","part":"plate","plane":{"origin":[0,0,5],"normal":[0,0,1],"xDir":[1,0,0]},"offset":[0,0],"rotationDeg":0,"text":"AB","font":"inter-bold","sizeMm":8,"mode":"engrave","depthMm":1}
op_text01_plane_orig_x = 0.0  # plane origin x mm
op_text01_plane_orig_y = 0.0  # plane origin y mm
op_text01_plane_orig_z = 5.0  # plane origin z mm
op_text01_plane_norm_x = 0.0  # plane normal x
op_text01_plane_norm_y = 0.0  # plane normal y
op_text01_plane_norm_z = 1.0  # plane normal z
op_text01_plane_xdir_x = 1.0  # plane x_dir x
op_text01_plane_xdir_y = 0.0  # plane x_dir y
op_text01_plane_xdir_z = 0.0  # plane x_dir z
op_text01_offset_x = 0.0  # offset x mm
op_text01_offset_y = 0.0  # offset y mm
op_text01_rotation = 0.0  # rotation deg
op_text01_size = 8.0  # text size mm
op_text01_depth = 1.0  # text depth mm
op_text01_overshoot = 0.01  # overshoot mm
op_text01_halign = TextAlign.CENTER  # text align
op_text01_plane = Plane(origin=(op_text01_plane_orig_x, op_text01_plane_orig_y, op_text01_plane_orig_z), z_dir=(op_text01_plane_norm_x, op_text01_plane_norm_y, op_text01_plane_norm_z), x_dir=(op_text01_plane_xdir_x, op_text01_plane_xdir_y, op_text01_plane_xdir_z))
op_text01_cutter = op_text01_plane * Pos(op_text01_offset_x, op_text01_offset_y, -op_text01_depth) * Rot(0, 0, op_text01_rotation) * extrude(Text("AB", op_text01_size, font_path=CADAI_FONTS + "/inter-bold.ttf", text_align=(op_text01_halign, TextAlign.CENTER)), op_text01_depth + op_text01_overshoot)
plate = plate - op_text01_cutter
# cadai:end op_text01
_cadai_parts = [plate]
result = plate
