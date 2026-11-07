// [Mechanical Parameters]
lean_deg = 65;   // [45:1:80] Backrest angle from the base plane, leaning back away from the user
base_len = 90;   // [60:1:150] Base plate length along x (front to back depth)
base_wid = 80;   // [50:1:120] Base plate width along y; also the backrest width
base_t = 6;      // [3:0.5:12] Base plate thickness along z
back_t = 6;      // [3:0.5:12] Backrest plate thickness, normal to its face
back_len = 90;   // [60:1:120] Backrest plate length measured along its face from the lower end
slot_w = back_t/sin(lean_deg);
plate_x = base_len/2 - slot_w/2 - back_len*cos(lean_deg);
$fn = 48;

module base_plate() {   // min corner at origin, resting on z = 0
    cube([base_len, base_wid, base_t]);
}

module backrest() {   // xz profile extruded along y; local min corner at origin
    translate([0, base_wid, 0])
        rotate([90, 0, 0])
            linear_extrude(height = base_wid)
                polygon(points = [
                    [back_len*cos(lean_deg), 0],
                    [back_len*cos(lean_deg) + back_t*sin(lean_deg), back_t*cos(lean_deg)],
                    [back_t*sin(lean_deg), back_len*sin(lean_deg) + back_t*cos(lean_deg)],
                    [0, back_len*sin(lean_deg)]
                ]);
}

// ---- Assembly placement (generated from the approved Assembly Spec) ----
// Placement is computed from the spec, not written by the model.
// Edit the *_pos_* parameters to preview a move; change the spec to keep it.
/* [Assembly Placement] */
backrest_pos_x = plate_x;   // x = plate_x = base_len/2 - slot_w/2 - back_len*cos(lean_deg), which centres the lower edge on the base midline; y = 0; z = 0 because the lowest corner of the profile is at z = 0.
union() {
    // base_plate: Origin is the base min corner, so position is [0,0,0].
    base_plate();
    translate([backrest_pos_x, 0, 0]) backrest();
}
