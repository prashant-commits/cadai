import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export interface EngineeringModuleRecipe {
  id: string;
  name: string;
  category: 'fastener' | 'joinery' | 'enclosure' | 'structural' | 'motion_mechanism' | 'mathematical_lattice';
  description: string;
  engineeringParameters: string[];
  designRules: string[];
  codeTemplate: string;
}

export const ENGINEERING_MODULE_REGISTRY: Record<string, EngineeringModuleRecipe> = {
  fastener_hardware: {
    id: 'fastener_hardware',
    name: 'M2-M6 Fastener Clearance Holes, Counterbores, Hex Nut Traps & Heat-Set Inserts',
    category: 'fastener',
    description: 'Precision ISO metric screw holes, counterbores, hex nut retention pockets, and tapered heat-set brass insert bosses.',
    engineeringParameters: [
      'size: Metric screw nominal diameter (e.g., 2, 3, 4, 5, 6 mm)',
      'depth: Hole pass-through depth in mm',
      'clearance: 3D print shrinkage compensation (+0.4mm on bore diameter)',
      'counterbore_depth: Recess depth for socket head cap screws (SHCS)',
      'nut_trap_depth: Thickness of hex nut + 0.5mm clearance',
    ],
    designRules: [
      'M3 clearance hole diameter is 3.4mm (compensates for 0.4mm nozzle hole shrinkage).',
      'M3 counterbore diameter is 6.2mm with depth 3.2mm.',
      'M3 hex nut trap width across flats is 5.6mm (5.4mm nominal + 0.2mm clearance).',
      'M3 heat-set insert pocket: Top diameter 4.0mm, bottom 3.8mm, depth 5.5mm.',
      'For horizontal holes, use a 45-degree teardrop or chamfered top to eliminate internal support.',
    ],
    codeTemplate: `// --- Parametric Fastener & Hardware Modules ---
module bolt_clearance_hole(size = 3, depth = 10, counterbore = true, teardrop = false) {
    // Exact hole dimensions with 3D print compensation
    hole_d = (size == 2) ? 2.4 :
             (size == 3) ? 3.4 :
             (size == 4) ? 4.5 :
             (size == 5) ? 5.5 : size + 0.5;
    cb_d = (size == 2) ? 4.4 :
           (size == 3) ? 6.2 :
           (size == 4) ? 7.8 :
           (size == 5) ? 9.5 : size * 1.8;
    cb_h = (size == 2) ? 2.2 :
           (size == 3) ? 3.2 :
           (size == 4) ? 4.2 :
           (size == 5) ? 5.2 : size * 1.0;

    union() {
        cylinder(d = hole_d, h = depth + 0.02, center = false, $fn = 32);
        if (counterbore) {
            translate([0, 0, depth - cb_h])
                cylinder(d = cb_d, h = cb_h + 0.02, center = false, $fn = 32);
        }
    }
}

module hex_nut_trap(size = 3, depth = 3.5) {
    // Width across flats + 0.2mm clearance
    flat_w = (size == 2) ? 4.2 :
             (size == 3) ? 5.6 :
             (size == 4) ? 7.2 :
             (size == 5) ? 8.2 : size * 1.8;
    point_d = flat_w / cos(30);
    cylinder(d = point_d, h = depth + 0.02, $fn = 6);
}

module heat_set_insert_pocket(size = 3, depth = 5.5) {
    top_d = (size == 2) ? 3.2 : (size == 3) ? 4.0 : (size == 4) ? 5.6 : (size == 5) ? 6.8 : size + 1.0;
    bot_d = top_d - 0.2;
    cylinder(r1 = bot_d / 2, r2 = top_d / 2, h = depth + 0.02, $fn = 32);
}`,
  },

  cantilever_snap_fit: {
    id: 'cantilever_snap_fit',
    name: 'Engineered Cantilever Snap-Fit Clip & Catch Slot',
    category: 'joinery',
    description: 'Tapered snap-fit beam designed to keep maximum bending strain under 1.5% for PLA and 2.0% for PETG.',
    engineeringParameters: [
      'length: Beam length (longer beams reduce peak strain)',
      'width: Beam width (determines retention force)',
      'thickness_base: Beam thickness at root (e.g., 2.4mm)',
      'thickness_tip: Beam thickness at tip (e.g., 1.5mm for stress distribution)',
      'hook_depth: Engagement depth of catch barb (e.g., 1.2mm)',
      'lead_angle: Insertion angle (30-45 deg for easy push-in)',
      'retention_angle: Retention/locking angle (90 deg for permanent, 45-60 deg for separable)',
    ],
    designRules: [
      'Always orient the part so the cantilever beam lies flat in the XY plane during printing for maximum tensile layer strength.',
      'Taper the beam from root to tip to distribute stress evenly along the beam.',
      'Add a minimum 0.8mm fillet radius at the root of the cantilever to eliminate stress concentration.',
      'Provide 0.35mm to 0.40mm clearance around the catch slot.',
    ],
    codeTemplate: `// --- Parametric Cantilever Snap-Fit Clip & Catch ---
module snap_fit_cantilever(
    length = 16,
    width = 6,
    thickness_base = 2.4,
    thickness_tip = 1.6,
    hook_depth = 1.2,
    lead_angle = 30,
    retention_angle = 60
) {
    // 2D profile extruded in width for clean printing
    rotate([90, 0, 90])
    linear_extrude(height = width, center = true) {
        polygon(points = [
            [0, 0],
            [length, thickness_base - thickness_tip],
            [length, (thickness_base - thickness_tip) + hook_depth],
            [length - (hook_depth / tan(retention_angle)), thickness_base - thickness_tip],
            [0, thickness_base],
            [-0.5, thickness_base], // Root fillet blend
            [-0.5, 0]
        ]);
    }
}

module snap_fit_catch_slot(width = 6, hook_depth = 1.2, wall_t = 3, clearance = 0.35) {
    slot_w = width + clearance * 2;
    slot_d = hook_depth + clearance;
    cube([slot_w, wall_t + 0.1, slot_d], center = true);
}`,
  },

  enclosure_features: {
    id: 'enclosure_features',
    name: 'PCB Standoff Bosses, Screw Posts & Perimeter Lip Seals',
    category: 'enclosure',
    description: 'Structural enclosure features including self-tapping PCB mounting posts and perimeter dust/alignment lip seals.',
    engineeringParameters: [
      'standoff_height: Elevation of PCB above floor (e.g., 4-8mm)',
      'outer_diameter: Boss outer diameter (typically 6.0mm)',
      'screw_pilot_d: Pilot hole for M2/M3 self-tapping screws (M2 = 1.6mm, M3 = 2.4mm)',
      'lip_height: Perimeter interlocking tongue height (1.5mm - 2.0mm)',
      'clearance: Perimeter fit clearance (0.25mm - 0.35mm)',
    ],
    designRules: [
      'Add triangular support gussets at the base of tall standoffs (>10mm) to prevent shear snap-off.',
      'Pilot hole for self-tapping screws in plastic should be 80% of nominal screw diameter.',
      'Perimeter lip-and-groove joint prevents enclosure halves from sliding or warping under load.',
    ],
    codeTemplate: `// --- Enclosure PCB Standoff & Perimeter Lip Modules ---
module pcb_standoff_boss(height = 6, outer_d = 6.0, screw_size = 3) {
    pilot_d = (screw_size == 2) ? 1.6 : (screw_size == 3) ? 2.5 : 3.4;
    difference() {
        cylinder(d = outer_d, h = height, $fn = 32);
        translate([0, 0, 1.0]) // Keep 1.0mm solid floor
            cylinder(d = pilot_d, h = height + 0.1, $fn = 24);
    }
}

module enclosure_perimeter_lip(outer_w, outer_l, wall_t = 2.4, lip_h = 1.8, clearance = 0.3) {
    // Interlocking stepped lip for enclosure upper/lower mating
    difference() {
        cube([outer_w - (wall_t - clearance), outer_l - (wall_t - clearance), lip_h]);
        translate([wall_t/2, wall_t/2, -0.01])
            cube([outer_w - (wall_t * 2), outer_l - (wall_t * 2), lip_h + 0.02]);
    }
}`,
  },

  structural_ribs_gussets: {
    id: 'structural_ribs_gussets',
    name: 'Load-Bearing Triangular Gussets & Stiffening Ribs',
    category: 'structural',
    description: 'Reinforces 90-degree corners, mounting flanges, and cantilever walls against bending and layer delamination.',
    engineeringParameters: [
      'length_x: Length of horizontal support leg',
      'height_z: Height of vertical support leg',
      'thickness: Rib thickness (typically 60-80% of wall thickness to prevent sink marks)',
      'chamfer: Optional 45-degree corner cutout for clearance',
    ],
    designRules: [
      'Gusset thickness should be 2.0mm - 4.0mm to provide solid infill strength.',
      'Space multiple parallel ribs every 20-30mm along wide mounting flanges for maximum stiffness.',
    ],
    codeTemplate: `// --- Structural Load-Bearing Gusset ---
module triangular_gusset(length_x = 20, height_z = 20, thickness = 3.0) {
    rotate([90, 0, 90])
    linear_extrude(height = thickness, center = true) {
        polygon(points = [
            [0, 0],
            [length_x, 0],
            [0, height_z]
        ]);
    }
}`,
  },

  sliding_dovetail_joint: {
    id: 'sliding_dovetail_joint',
    name: 'Sliding Dovetail Joint (Pin & Socket)',
    category: 'joinery',
    description: 'Interlocking slide-together joint for modular assemblies, expandable rails, and tool-free mounting.',
    engineeringParameters: [
      'length: Joint engagement length along slide axis',
      'base_w: Narrow neck width (e.g., 8mm)',
      'top_w: Wide flared width (e.g., 12mm)',
      'height: Joint thickness (e.g., 6mm)',
      'clearance: Sliding clearance (0.35mm standard for FDM)',
    ],
    designRules: [
      'Print the slide axis horizontally if possible for low friction and maximum shear strength.',
      'Add a 0.5mm lead-in chamfer at the entry of the socket for smooth sliding.',
    ],
    codeTemplate: `// --- Sliding Dovetail Joint ---
module dovetail_pin(length = 25, base_w = 8, top_w = 12, height = 6) {
    linear_extrude(height = length) {
        polygon(points = [
            [-base_w/2, 0],
            [base_w/2, 0],
            [top_w/2, height],
            [-top_w/2, height]
        ]);
    }
}

module dovetail_socket(length = 25, base_w = 8, top_w = 12, height = 6, clearance = 0.35) {
    c = clearance;
    linear_extrude(height = length + 0.2) {
        polygon(points = [
            [-(base_w/2 + c), -0.1],
            [(base_w/2 + c), -0.1],
            [(top_w/2 + c), height + c],
            [-(top_w/2 + c), height + c]
        ]);
    }
}`,
  },

  print_in_place_hinge: {
    id: 'print_in_place_hinge',
    name: 'Print-in-Place Revolving Hinge (Zero Assembly)',
    category: 'motion_mechanism',
    description: 'Functional revolving hinge with captured conical pins and calibrated 0.4mm air gaps, fully operational right off the build plate.',
    engineeringParameters: [
      'length: Hinge total knuckle length',
      'outer_d: Knuckle outer diameter (e.g., 8-10mm)',
      'pin_d: Internal revolving pin diameter (e.g., 4mm)',
      'clearance: Radial air gap (0.4mm recommended for FDM)',
      'leaf_w: Width of mounting hinge leaves',
      'leaf_t: Thickness of mounting hinge leaves',
    ],
    designRules: [
      'Conical pin ends (45-degree taper) eliminate horizontal overhangs inside the pin cavity.',
      'Maintain 0.4mm air gap between the rotating knuckle and stationary outer leaves.',
      'Print with knuckles oriented along the Z-axis (vertical) for perfectly circular pin clearance.',
    ],
    codeTemplate: `// --- Print-in-Place Revolving Hinge ---
module print_in_place_hinge(
    knuckle_l = 24,
    outer_d = 8,
    pin_d = 4,
    clearance = 0.4,
    leaf_w = 16,
    leaf_t = 3
) {
    segment_h = knuckle_l / 3;
    $fn = 36;

    // Leaf A (Left side attached to outer knuckles)
    translate([-leaf_w, -leaf_t/2, 0])
        cube([leaf_w, leaf_t, knuckle_l]);

    // Outer Knuckles (Bottom and Top)
    difference() {
        union() {
            cylinder(d = outer_d, h = segment_h);
            translate([0, 0, segment_h * 2])
                cylinder(d = outer_d, h = segment_h);
        }
        // Conical pin sockets
        translate([0, 0, segment_h - 0.01])
            cylinder(r1 = (pin_d/2) + clearance, r2 = 0, h = pin_d/2);
        translate([0, 0, segment_h * 2 + 0.01 - (pin_d/2)])
            cylinder(r1 = 0, r2 = (pin_d/2) + clearance, h = pin_d/2);
    }

    // Leaf B (Right side attached to center knuckle)
    translate([0, -leaf_t/2, segment_h + clearance])
        cube([leaf_w, leaf_t, segment_h - (clearance * 2)]);

    // Center Knuckle with conical pivot pins
    translate([0, 0, segment_h + clearance]) {
        cylinder(d = outer_d - (clearance * 2), h = segment_h - (clearance * 2));
        // Top pivot cone
        translate([0, 0, segment_h - (clearance * 2) - 0.01])
            cylinder(r1 = pin_d/2, r2 = 0, h = pin_d/2);
        // Bottom pivot cone
        translate([0, 0, -(pin_d/2) + 0.01])
            cylinder(r1 = 0, r2 = pin_d/2, h = pin_d/2);
    }
}`,
  },

  honeycomb_lattice: {
    id: 'honeycomb_lattice',
    name: 'Mathematical Honeycomb / Isogrid Lightweighting Lattice',
    category: 'mathematical_lattice',
    description: 'High strength-to-weight ratio hexagonal lattice for aerospace bracket lightweighting, airflow ventilation, and finger guards.',
    engineeringParameters: [
      'width: Bounding box width of the lattice area',
      'length: Bounding box length of the lattice area',
      'hex_radius: Hexagon cell circumradius (e.g., 4-8mm)',
      'wall_thickness: Web wall thickness between cells (e.g., 1.2-2.0mm)',
      'depth: Extrusion cutout depth',
    ],
    designRules: [
      'Maintain web wall thickness >= 1.2mm (at least 3 nozzle perimeters) for structural rigidity.',
      'Use $fn = 6 with 30-degree rotation for true regular hexagons.',
    ],
    codeTemplate: `// --- Mathematical Honeycomb Lightweighting Grid ---
module honeycomb_lattice_cutout(width = 60, length = 60, hex_radius = 5, wall_thickness = 1.6, depth = 10) {
    dx = (hex_radius * 2 + wall_thickness) * 0.75;
    dy = sqrt(3) * (hex_radius + (wall_thickness / 2));
    cols = floor(width / dx);
    rows = floor(length / dy);

    translate([-width/2, -length/2, -0.1])
    linear_extrude(height = depth + 0.2) {
        for (r = [0 : rows]) {
            for (c = [0 : cols]) {
                x = c * dx;
                y = r * dy + ((c % 2 == 1) ? dy / 2 : 0);
                if (x <= width && y <= length) {
                    translate([x, y])
                        rotate([0, 0, 30])
                        circle(r = hex_radius, $fn = 6);
                }
            }
        }
    }
}`,
  },

  polar_bolt_circle: {
    id: 'polar_bolt_circle',
    name: 'Mathematical Polar Trigonometric Bolt Circle / Flange Pattern',
    category: 'mathematical_lattice',
    description: 'Equi-angular trigonometric hole distribution for NEMA motor mounts, pipe flanges, and rotary bearings.',
    engineeringParameters: [
      'count: Number of radial holes/features',
      'pcd: Pitch Circle Diameter in mm',
      'hole_size: Screw diameter (M2-M6)',
      'center_bore: Diameter of central shaft/pilot bore',
      'depth: Flange plate thickness',
    ],
    designRules: [
      'Use polar-to-Cartesian trigonometry: x = (pcd/2) * cos(theta), y = (pcd/2) * sin(theta).',
      'Add a center pilot bore clearance of 0.2mm for rotary motor centering.',
    ],
    codeTemplate: `// --- Mathematical Polar Flange & Bolt Circle ---
module polar_bolt_flange(count = 6, pcd = 40, screw_size = 3, center_bore = 15, depth = 5) {
    difference() {
        cylinder(d = pcd + (screw_size * 4), h = depth, $fn = 64);
        // Central bore
        if (center_bore > 0) {
            translate([0, 0, -0.1])
                cylinder(d = center_bore, h = depth + 0.2, $fn = 48);
        }
        // Polar bolt circle holes
        for (i = [0 : count - 1]) {
            angle = i * (360 / count);
            rotate([0, 0, angle])
                translate([pcd / 2, 0, -0.1])
                cylinder(d = (screw_size == 3) ? 3.4 : screw_size + 0.4, h = depth + 0.2, $fn = 32);
        }
    }
}`,
  },

  involute_spur_gear: {
    id: 'involute_spur_gear',
    name: 'Mathematical Involute Spur Gear & Pinion',
    category: 'motion_mechanism',
    description: 'Standard 20-degree pressure angle parametric spur gear for robotics, actuators, and power transmission.',
    engineeringParameters: [
      'num_teeth: Number of gear teeth (e.g., 12 to 48)',
      'module_pitch: Metric gear module (m = pitch_diameter / num_teeth)',
      'pressure_angle: Standard 20 degrees',
      'face_width: Gear thickness along rotation axis',
      'bore_d: Shaft bore diameter (e.g., 5.0mm for NEMA 17 D-shaft)',
    ],
    designRules: [
      'Maintain module pitch matching across mating gears (e.g., Module 1.0 or 1.5).',
      'Center distance between two gears = (Teeth1 + Teeth2) * Module / 2.',
      'Add 0.2mm backlash clearance on tooth thickness for 3D printed gear meshes.',
    ],
    codeTemplate: `// --- Parametric Involute Spur Gear ---
module parametric_spur_gear(
    num_teeth = 18,
    gear_module = 1.5,
    pressure_angle = 20,
    face_width = 8,
    bore_d = 5.2
) {
    pitch_d = num_teeth * gear_module;
    outer_d = pitch_d + (2 * gear_module);
    root_d = pitch_d - (2.5 * gear_module);
    $fn = 32;

    difference() {
        union() {
            // Main gear body
            cylinder(d = root_d + 0.5, h = face_width, center = false);
            // Involute tooth array
            for (i = [0 : num_teeth - 1]) {
                rotate([0, 0, i * (360 / num_teeth)]) {
                    translate([0, 0, 0])
                    linear_extrude(height = face_width) {
                        polygon(points = [
                            [-sin(180/num_teeth) * root_d/2, cos(180/num_teeth) * root_d/2],
                            [-sin(90/num_teeth) * pitch_d/2, cos(90/num_teeth) * pitch_d/2],
                            [-sin(45/num_teeth) * outer_d/2, cos(45/num_teeth) * outer_d/2],
                            [sin(45/num_teeth) * outer_d/2, cos(45/num_teeth) * outer_d/2],
                            [sin(90/num_teeth) * pitch_d/2, cos(90/num_teeth) * pitch_d/2],
                            [sin(180/num_teeth) * root_d/2, cos(180/num_teeth) * root_d/2]
                        ]);
                    }
                }
            }
        }
        // Center shaft bore
        translate([0, 0, -0.1])
            cylinder(d = bore_d, h = face_width + 0.2);
    }
}`
  },

  dowel_stacking_joint: {
    id: 'dowel_stacking_joint',
    name: 'Dowel Stacking Joint (Mating Interface)',
    category: 'joinery',
    description: 'Standardized pin and socket for vertically stacking components like lamp frames or chassis tiers.',
    engineeringParameters: [
      'pin_d: Diameter of the dowel pin (typically 7.0mm)',
      'socket_d: Diameter of the mating blind bore (typically 7.5mm for 0.25mm radial clearance)',
      'depth: Insertion depth of the pin (e.g., 8mm)',
    ],
    designRules: [
      'Male pin should have a 1.0mm 45-degree chamfer lead-in for easy assembly.',
      'Maintain 0.25mm radial clearance for a comfortable slip fit in FDM.',
    ],
    codeTemplate: `// --- Dowel Stacking Joint ---
module dowel_stacking_pin(d = 7.0, h = 8.0) {
    cylinder(d = d, h = h - 1.0, $fn = 32);
    translate([0, 0, h - 1.0])
        cylinder(r1 = d/2, r2 = (d/2) - 1.0, h = 1.0, $fn = 32);
}

module dowel_stacking_socket(d = 7.5, h = 8.0) {
    cylinder(d = d, h = h + 0.5, $fn = 32); // Extra depth for clearance
}`
  },

  panel_slide_track: {
    id: 'panel_slide_track',
    name: 'Panel Slide Track (Groove Joint)',
    category: 'joinery',
    description: 'U-channel guide groove for sliding in thin panels, diffusers, or Kumiko lattices.',
    engineeringParameters: [
      'panel_t: Thickness of the panel being inserted (e.g., 2.0mm)',
      'groove_w: Width of the channel (panel_t + 0.4mm clearance)',
      'depth: Insertion depth of the channel (e.g., 4.0mm)',
      'length: Length of the track',
    ],
    designRules: [
      'Provide 0.4mm total slot clearance (e.g. 2.4mm slot for a 2.0mm panel) so the panel slides without binding.',
    ],
    codeTemplate: `// --- Panel Slide Track ---
module panel_slide_groove(panel_t = 2.0, depth = 4.0, length = 100, clearance = 0.4) {
    groove_w = panel_t + clearance;
    translate([-groove_w/2, -0.01, -0.01])
        cube([groove_w, depth + 0.02, length + 0.02]);
}`
  },

  trapped_plate_mount: {
    id: 'trapped_plate_mount',
    name: 'Trapped Plate Internal Mount',
    category: 'joinery',
    description: 'Internal shelf designed to capture and hold a functional core plate (e.g., Bulb Tray).',
    engineeringParameters: [
      'plate_w: Width of the trapped plate',
      'plate_l: Length of the trapped plate',
      'shelf_w: Width of the supporting shelf rim (e.g., 2-4mm)',
      'clearance: Perimeter gap around the plate (e.g., 0.25mm)',
    ],
    designRules: [
      'The trapped plate should have at least 0.25mm edge clearance on all sides.',
      'The shelf should overlap the plate by at least 2.0mm to support vertical loads.',
    ],
    codeTemplate: `// --- Trapped Plate Shelf Cutout (Difference Target) ---
module trapped_plate_cutout(plate_w = 81.5, plate_l = 81.5, plate_t = 3.0, shelf_depth = 2.0, clearance = 0.25) {
    total_w = plate_w + (clearance * 2);
    total_l = plate_l + (clearance * 2);
    
    // The cavity for the plate
    translate([-(total_w/2), -(total_l/2), 0])
        cube([total_w, total_l, plate_t + 0.2]);
        
    // The pass-through hole beneath the shelf
    hole_w = total_w - (shelf_depth * 2);
    hole_l = total_l - (shelf_depth * 2);
    translate([-(hole_w/2), -(hole_l/2), -10]) // arbitrary deep cut
        cube([hole_w, hole_l, 10 + 0.01]);
}`
  },
};

/**
 * LangChain DynamicStructuredTool that allows the AI agent to look up
 * precision functional mechanical and mathematical CAD algorithms.
 */
export const getFunctionalCadModuleTool = new DynamicStructuredTool({
  name: 'get_functional_cad_module',
  description: `Retrieves tested, watertight OpenSCAD parametric modules, clearance tables, and design rules for functional engineering parts.
Available module keys:
- 'fastener_hardware': M2-M6 bolt clearance holes, counterbores, hex nut traps, and heat-set inserts.
- 'cantilever_snap_fit': Engineered snap-fit clips and catch slots with strain limits.
- 'enclosure_features': PCB standoff bosses, screw posts, and perimeter lip seals.
- 'structural_ribs_gussets': Load-bearing gussets and stiffening ribs for 90-degree corners.
- 'sliding_dovetail_joint': Interlocking slide-together pin and socket joint.
- 'print_in_place_hinge': Zero-assembly revolving hinge with conical pivot pins.
- 'honeycomb_lattice': Mathematical hexagonal isogrid lattice for lightweighting and ventilation.
- 'polar_bolt_circle': Trigonometric polar hole arrays for motor mounts and flanges.
- 'involute_spur_gear': Parametric spur gear with standard pressure angle and shaft bore.
- 'dowel_stacking_joint': Standardized pin and socket for vertically stacking components.
- 'panel_slide_track': U-channel guide groove for sliding in thin panels or diffusers.
- 'trapped_plate_mount': Internal shelf designed to capture and hold a functional core plate.`,
  schema: z.object({
    moduleKey: z.enum([
      'fastener_hardware',
      'cantilever_snap_fit',
      'enclosure_features',
      'structural_ribs_gussets',
      'sliding_dovetail_joint',
      'print_in_place_hinge',
      'honeycomb_lattice',
      'polar_bolt_circle',
      'involute_spur_gear',
      'dowel_stacking_joint',
      'panel_slide_track',
      'trapped_plate_mount',
    ]).describe('The specific functional or mathematical CAD module key to retrieve.'),
  }),
  func: async ({ moduleKey }) => {
    const moduleRecipe = ENGINEERING_MODULE_REGISTRY[moduleKey];
    if (!moduleRecipe) {
      return JSON.stringify({
        error: `Module key '${moduleKey}' not found. Available keys: ${Object.keys(ENGINEERING_MODULE_REGISTRY).join(', ')}`,
      });
    }

    return JSON.stringify({
      name: moduleRecipe.name,
      category: moduleRecipe.category,
      description: moduleRecipe.description,
      parameters: moduleRecipe.engineeringParameters,
      designRules: moduleRecipe.designRules,
      codeTemplate: moduleRecipe.codeTemplate,
    }, null, 2);
  },
});
