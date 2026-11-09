# Model-first workspace: design

**Status:** for the user's review, 2026-11-09 (builder check done; the user answered its two open questions). Written from the brainstorm with the user (mockups in `.cadai/scratch/pa/brainstorm-ui/.superpowers/brainstorm/*/content/`: `layout-b-input.html`, `landing-v3.html`, `tool-engrave.html`) and the Gemini UX audit (`.cadai/scratch/pa/ux/AUDIT.md`).

## Intent
cadai becomes **a 3D modeling app first, and an AI generation app second**.

The model and the tools to change it own the screen. The AI is a collaborator you talk to beside the model, and every edit, by hand or by the AI, lands in the same parametric design. The user generates with Opus and rates its quality and intent capture highly, so generation is no longer the bottleneck. The bottleneck is how the app feels to work in.

## Goals
1. **A landing page** for starting a project, with your projects below.
2. **A workspace** where the 3D model fills the screen, with floating panels around it: the chat on the left, a tool bar along the top, and the inspector on the right.
3. **Projects** as a new entity. Threads are scoped to a project, and each thread is its own design.
4. **A first set of direct modeling tools:**
   - tools that change the model: Text, Texture, Hole and cut shape;
   - tools that only look at it: Measure and Section.

   All of them follow one interaction pattern.
5. **Layers.** The design's parts and tool operations show as a list. Selecting a layer focuses Properties on it and gives the AI its context.
6. **The bugs and frictions the audit found in today's UI are fixed**, or made impossible by the new layout (list below).

## Non-goals (this release)
- Phones and tablets. **Desktop only.**
- These tools, which come later: add shape, extrude, SVG engraving, move/transform as a standalone tool, and editing on a section.
- Real-time collaboration, sharing and accounts. The owner is still the anonymous cookie; a login or users table is a separate decision.
- Changing the default model: it stays Sonnet 5.5, and the user picks Opus in the chat input.

## Anti-goals (a failure even if it "works")
- **A manual edit that is not parametric.** The model must stay code the AI can keep editing; mesh-only edits that the code can't reproduce are out.
- **The chat or the panels hiding the model.** Every panel floats, folds away, and leaves the 3D space as the main surface.
- **A tool that changes the model without a preview and an explicit Apply.**
- **Losing existing threads or versions in the move to projects.**
- **The header leaking implementation details**: engine, units, badges or the model name.

## The decisions the user made
### Landing page
- **Layout:** the logo and "cadai" sit top-left. "What do you want to make?" and a **big input box sit in the center of the screen**, and the **projects are listed below it**.
- **The input box:** it holds an **image upload button and the model selector inside it**, plus a Start button.
- **Starter ideas:** **two at a time**, picked from a list of **hardware-level** ideas, never hobby trinkets. For example:
  - a NEMA 17 motor mount with a belt tensioner;
  - a Raspberry Pi 5 enclosure with a fan and port cutouts;
  - a 608 bearing pillow block with M5 bolts;
  - a 2020 extrusion corner bracket;
  - a hinged electronics box with a cable gland.
- **The projects list:** cards with a thumbnail. **Search** and **Show all** were confirmed.
- **Start:** creates a project with its first thread and opens the workspace with the build running.

### Workspace (layout B)
- **Header:** only the logo and "cadai". The project name sits next to it and opens the project list (switch, new, rename, delete).
- **The 3D space** fills the window: an infinite grid with the model in it.
- **Chat:** a floating panel on the **left** that **collapses into and expands from the left edge only**.
  - It is ready to type when a thread opens.
  - A **Threads** menu at the top switches between the project's threads and has "+ New thread".
  - The **model selector and the image upload button live inside the input box**.
  - Replies show their **steps** (Designer, Checks…), saved permanently (lane U1).
- **Tool bar:** floats along the top center.
- **Inspector:** on the right, stacked as **Layers**, then **Properties** (the selected layer's parameters as sliders), then **Versions**.
  - **Versions are not in the chat.**

### Projects and threads
- **A project** is a new entity. **Threads are scoped to a project.**
- **Each thread is its own design**: its own chat, model, layers and versions.
- **A new thread** starts with **only a welcome message in the chat and an empty 3D space**.

### Tools
- **The first set:**
  - **Text:** engrave or emboss.
  - **Texture**, in two kinds:
    - **surface textures** are real geometry (knurling, hex grip, ribs, dimples);
    - **materials** are appearance only (brushed metal, matte plastic, wood, color).
  - **Hole and cut shape:** round holes with M3–M8 presets, counterbore, countersink, and rectangular cut-outs.
  - **Measure and Section:** view-only.
- **The pattern, the same for every tool:**
  1. Clicking a tool **opens its settings section on the right**. For Text, that is font, size, color, engrave or emboss, depth, and more of the same kind.
  2. Click a face, and a live preview appears there.
  3. Drag or rotate it into place.
  4. **Apply** creates a named layer and a new version; **Cancel** changes nothing.
- **Under the hood, every Apply writes a step into the design's build123d code** (the user confirmed this matches the goal over mesh editing). So a manual edit is parametric, versioned, and editable by the AI.
- **Layers** make it easier to instruct the AI: a selected layer travels with the next chat message as context.
- **A manual edit shows in the chat as a small line**, for example "You added Hole Ø5 · v4" (the user's answer to the builder check). Selecting that version highlights the line. The AI reads it as part of the conversation history.
- **Properties for an AI-made part layer shows all of the model's parameters** (the user's answer). Parameters are not grouped per part. A tool layer's Properties shows that tool's own settings (depth, size, diameter…).

### Visual style (the user's choice: style A, "graphite glass", in the softer v2)
The reference mockup is `style-a-glass-v2.html`.
- **Background:** a dark graphite 3D space (about `#0c0f15` to `#1a2230`) with a soft blue, violet and cyan glow, and a faint grid that fades out at the edges.
- **Panels (glassmorphism, "more glass, softer"):**
  - a translucent white tint (about 11–7% from top to bottom), `backdrop-filter: blur(~28px) saturate(160%)`;
  - a hairline border with a lighter top edge, and a soft large shadow;
  - big radii: about 24 px for panels, pill shapes for the tool bar, buttons, chips and the send button.
- **Accent:** a blue-to-violet gradient (about `#6b9bff` to `#a08bff`) for the active tool, Send, the selected layer, slider fills and primary actions. Accent glow stays subtle.
- **Icons:** thin line icons (Lucide), and **no emoji anywhere**.
- **Type:** **Inter** for the UI (the user's choice). For code and numbers, Geist Mono (my call; it is already loaded).

### Stack (agreed for consistency)
- **Tailwind CSS v4:** one token file (colors, radii, blur, shadows, the accent gradient). The glass surface is defined once (a shared utility or component) and reused by every panel.
- **shadcn/ui on Radix primitives:** every dropdown, menu, dialog, popover, tooltip, slider, tab and toggle, themed by the same tokens. *(New.)*
- **Icons:** `lucide-react` only.
- **3D:** three.js, React Three Fiber and drei:
  - drei's transform/pivot controls for the tool gizmo;
  - clipping planes for Section;
  - raycasting for Measure and for face picking.
- **Motion:** `tw-animate-css` and CSS transitions. **Toasts:** Sonner. *(Both new, small.)*
- **Kept:** Zustand, Monaco and react-markdown. `react-resizable-panels` goes once panels float, unless the code drawer uses it.

## Constraints (from the codebase and earlier decisions)
- **Stack:** Next.js (`task/dz`). Read `node_modules/next/dist/docs/` before writing Next code (AGENTS.md).
- **Persistence:**
  - The server owns history: Postgres or PGlite, through `DbRunStore`, plus the owner-scoped object store.
  - Migrations are **additive only**, starting at `db/migrations/0002_*`. Lane U1 also adds a 0002, so number after it.
- **The design is a build123d body plus a versioned prelude.**
  - The geo service runs it.
  - `_cadai_parts` already carries labelled parts.
  - The body check (`src/lib/brep/body-check.ts`) rejects imports and unsafe names. Tool-generated code must pass it.
- **UI text:** every string in the UI is either a fixed phrase or server-rendered markdown. No raw model output.
- **Parametric intent:** literal dimensions in generated code are named parameters (see the project memory "parametric-intent").
- **Lane U1** (running, merging before this work) changes:
  - chat steps (saved on the reply);
  - attachments on messages (`message_attachments.kind`);
  - upload on attach;
  - the framing of markup images;
  - the `nochange` reply.

  Build on it; don't redo it.

## Audit findings this design must close
Numbers are from `AUDIT.md`.
- **#1:** the demo thread is "legacy", so the chat is disabled on first load. The landing page and empty new threads replace the demo.
- **#3:** exports are scattered and STL names are timestamps. Make one **Export** menu (STL, STEP, 3MF) and name files `<design>-v<n>.<ext>`.
- **#4:** code and parameters share a slot. Properties live in the inspector, and the code editor opens as a drawer.
- **#5 and #14:** versions sit in the chat. Move them to the inspector. Selecting a version highlights the chat message that made it.
- **#6:** thread deletion has no confirm. Projects and threads both confirm before deleting.
- **#8:** emoji render as boxes. Use icons.
- **#9:** there are two Stop buttons. Keep one, in the chat input.
- **#11:** pin and reset only show on hover. Keep them visible and keyboard-reachable.
- **#12:** a new thread shows the old model. The new thread is empty.
- **#13:** the header is crowded. It becomes the logo and "cadai".
- **#15 and #16:** the wrong icon, and Three.js deprecation warnings.

(#2, mobile, is out of scope.)

## My calls (the builder may revisit; the user has not decided these)
- **Migration:** existing threads move into an automatic project named "My designs", so nothing is lost.
- **Tool steps in code:**
  - Each Apply appends **a delimited, named block** to the body, with a marker comment that carries the tool's settings, for example `# cadai:op text id=… {json}`.
  - The app parses the blocks back into **layers** and **Properties**. The designer prompt tells the AI to keep these blocks intact and edit their parameters rather than rewrite them.
- **Layers:**
  - the labelled parts from `_cadai_parts`;
  - plus one layer per tool block.
  - AI-only designs without blocks show their parts only.
- **Code editor:** a drawer you open from the inspector.
- **Export:** a button at the top right.
- **Materials:**
  - stored per layer, or for the whole model;
  - shown in the viewer;
  - written to 3MF and to STEP colors where the exporter supports it;
  - absent from STL by nature.
- **Where a tool block's code goes:** a tool block edits **the part that was clicked**: it rebinds that part's variable and re-exports `_cadai_parts`. Per-part meshes, layers and the interference checks therefore stay in sync. On a single-part model, it edits the one part.
- **Apply saves on the server immediately:**
  - an endpoint compiles the new body through the geo service;
  - it stores the STL/STEP artifacts;
  - it writes a `user_edit` version and the chat line in one transaction (the same lifecycle rules as a run's commit).

  It is not a client draft.
- **Measure and face picking are exact:**
  - the geo service exports B-Rep topology alongside the mesh: a face id per triangle, plus edge and cylinder data (lengths, hole axes and diameters);
  - Measure reads exact values ("Ø 5.0", not "Ø 4.97");
  - tools know exactly which face was clicked.
- **A selected layer is sent as data, not text:**
  - it is a structured field on the chat request (layer id and name), stored with the message;
  - it shows as a chip in the user's bubble;
  - it reaches the designer as explicit context.
- **The welcome message** is a fixed phrase from the app, not a model call.
- **Section:** clips along X, Y or Z or a draggable plane, view-only.
- **Measure:**
  - point-to-point distance;
  - edge length;
  - hole diameter;
  - it never changes the model.
- **View presets** (top, front, right, iso), from the audit's missing-tools list: cheap, and in scope.

## Left to the builder
- component structure and state shape;
- how live previews are computed (a client-side approximation, or a fast compile per change);
- the gizmo implementation;
- the texture generation strategy and its density limits (keep the geo runtime in budget);
- font handling for Text (a bundled font set);
- the project list's thumbnail source (the latest version's render);
- splitting the work into lanes:
  1. landing page, projects and layout;
  2. tool framework, layers and the tools.
