import { ChatThread, ChatMessage, ModelInfo } from '@/types';

const THREADS_KEY = 'cadai_threads_v1';
const ACTIVE_THREAD_KEY = 'cadai_active_thread_id_v1';

export const DEFAULT_OPENSCAD_CODE = `// CAD AI - Welcome Demo: Parametric Rounded Box with Center Bore
// Designed for FDM 3D Printing

// [Parameters]
width = 40;          // [20:80] Width in mm
depth = 40;          // [20:80] Depth in mm
height = 25;         // [10:60] Total height in mm
wall_thickness = 2.4;// [1.2:5] Minimum wall thickness
corner_radius = 5;   // [1:10] Corner fillet radius
hole_radius = 8;     // [3:15] Center bore radius
$fn = 48;            // Smooth curve resolution

module rounded_box(w, d, h, r) {
    hull() {
        translate([-(w/2-r), -(d/2-r), 0]) cylinder(h=h, r=r);
        translate([ (w/2-r), -(d/2-r), 0]) cylinder(h=h, r=r);
        translate([-(w/2-r),  (d/2-r), 0]) cylinder(h=h, r=r);
        translate([ (w/2-r),  (d/2-r), 0]) cylinder(h=h, r=r);
    }
}

difference() {
    // 1. Outer solid body with rounded corners
    rounded_box(width, depth, height, corner_radius);

    // 2. Center through-bore
    translate([0, 0, -1])
        cylinder(h=height + 2, r=hole_radius);
}
`;

export function createInitialThread(): ChatThread {
  const initialId = 'thread-' + Date.now();
  return {
    id: initialId,
    title: 'Demo Rounded Box',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    selectedModel: 'gemini-3.6-flash',
    code: DEFAULT_OPENSCAD_CODE,
    messages: [
      {
        id: 'welcome-msg',
        role: 'assistant',
        content: `👋 **Welcome to CAD AI!** I am your 3D parametric mechanical design assistant.

I specialize in creating 3D printable objects for **FDM, SLA, and SLS** printing. You can describe any part or mechanical design in plain English, and I will:
1. 🧠 Plan and reason about the mechanics & printability
2. ⚙️ Generate parametric OpenSCAD code
3. 🔍 Validate geometry & manifoldness before rendering
4. 🖨️ Recommend slicing settings (walls, infill, layer height, orientation)

**Try asking:**
- *"Design a snap-fit lid enclosure for an Arduino Uno"*
- *"Create a parametric phone stand tilted at 60 degrees with cable pass-through"*
- *"Make a durable hex-grid storage container"*
- *"Model a GT2 20-tooth timing pulley with 5mm shaft bore"*`,
        code: DEFAULT_OPENSCAD_CODE,
        timestamp: Date.now(),
      },
    ],
  };
}

export function loadStoredThreads(): { threads: ChatThread[]; activeThreadId: string } {
  if (typeof window === 'undefined') {
    const initial = createInitialThread();
    return { threads: [initial], activeThreadId: initial.id };
  }

  try {
    const raw = localStorage.getItem(THREADS_KEY);
    const activeId = localStorage.getItem(ACTIVE_THREAD_KEY);

    if (raw) {
      const threads: ChatThread[] = JSON.parse(raw);
      if (Array.isArray(threads) && threads.length > 0) {
        const foundActive = threads.find((t) => t.id === activeId);
        return {
          threads,
          activeThreadId: foundActive ? foundActive.id : threads[0].id,
        };
      }
    }
  } catch (err) {
    console.error('Failed to load threads from localStorage:', err);
  }

  const initial = createInitialThread();
  saveStoredThreads([initial], initial.id);
  return { threads: [initial], activeThreadId: initial.id };
}

export function saveStoredThreads(threads: ChatThread[], activeThreadId: string) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
    localStorage.setItem(ACTIVE_THREAD_KEY, activeThreadId);
  } catch (err) {
    console.error('Failed to save threads to localStorage:', err);
  }
}
