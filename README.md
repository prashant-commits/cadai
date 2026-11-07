# CAD AI

CAD AI is an intelligent, agent-driven Next.js application that enables Large Language Models (LLMs) to autonomously design, compile, and verify 3D printable mechanical parts using parametric OpenSCAD.

## Features

- **Agentic 3D Design:** An AI agent capable of writing parametric OpenSCAD scripts for mechanical fasteners, enclosures, snap-fits, gears, and more.
- **In-Memory Compilation:** Uses `openscad-wasm` to securely and instantly compile OpenSCAD scripts to STL geometry directly within the Node/V8 engine.
- **Geometry Verification:** Extracts physical volume, bounding boxes, and checks for zero-thickness manifold errors, providing a closed physical verification loop for the AI.
- **Interactive UI:** Next.js frontend built with React, Tailwind CSS, Monaco Editor, and Three.js for realtime code editing and 3D rendering.

## MCP Server Support

CAD AI functions natively as an **MCP (Model Context Protocol)** server. This allows external clients like Claude Desktop or other agents to connect and use its CAD compilation and engineering tools.

The server exposes three powerful MCP tools:
1. `list_engineering_modules`: Lists all available mechanical design templates (fasteners, snap-fits, lattices).
2. `get_engineering_module`: Retrieves exact parametric code and design rules for a chosen module.
3. `compile_and_validate_scad`: Compiles an OpenSCAD script, verifies its solid geometry, and exports the STL.

### Connecting to the MCP Server

There are two ways to run the MCP server:

**1. HTTP Server-Sent Events (SSE) via Next.js:**
By running the Next.js development server, the MCP is automatically available over HTTP.
```bash
npm run dev
```
- **Endpoint:** `http://localhost:3000/api/mcp`
- **Transport:** SSE (Server-Sent Events)

**2. Standard Input/Output (CLI):**
You can also run the MCP server directly via `stdio` for traditional integration.
```bash
npm run mcp
```

## Getting Started

First, install dependencies:
```bash
npm install
```

Start the development server:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to explore the interactive CAD workspace.

## Geometry kernel and pipeline

Runs use the **Architect pipeline** on the **B-rep kernel** (build123d, STEP export) by default.
The B-rep scripts execute in the Python geometry service in `geo/`.

Run it locally:
```bash
npm run geo:setup      # once: creates geo/.venv and installs build123d + the service
npm run geo:serve      # terminal 1: geometry service on http://127.0.0.1:8765
```
```bash
# terminal 2: the app. Do not export CADAI_GEO_TOKEN in terminal 1: the service
# refuses to start with it set (it reads its token from a file; geo:serve writes "dev").
export CADAI_GEO_URL=http://127.0.0.1:8765
export CADAI_GEO_TOKEN=dev
npm run dev
```

Switches (read once per run and pinned for its thread):

| Env | Effect |
| --- | --- |
| *(none)* | Architect pipeline, B-rep kernel |
| `CADAI_KERNEL=openscad` | Architect pipeline writing OpenSCAD (STL only, no STEP) |
| `CADAI_PIPELINE=drafter` | The legacy Drafter pipeline, which only writes OpenSCAD |
| `CADAI_PIPELINE=drafter` + `CADAI_KERNEL=brep` | Keeps OpenSCAD and logs one warning: the Drafter has no B-rep path |

Without `CADAI_GEO_URL` the B-rep scripts run through a local Python child process
(`geo/.venv`, or `CADAI_GEO_PYTHON`). That runner has no process sandbox and is
**dev-only**: it is refused under `NODE_ENV=production` unless `CADAI_GEO_ALLOW_LOCAL=1`.
Deployments should always set `CADAI_GEO_URL` (and `CADAI_GEO_TOKEN`).

## Evaluating generation quality

`npm run eval:generation -- --model claude-haiku-5.5 --tag baseline` runs the prompts in
`eval/generation/prompts.json` through the real agent graph (spec and accept gates
auto-approved, automatic repair off) and prints first-draft rates: spec produced,
placement composed from the spec, compiled, lowest point on the floor, no floating
parts, module origins correct, extents matching. Results are written to
`eval/results/` and, when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set, recorded
as a Langfuse experiment run on the `cadai-generation` dataset with one score per metric
(seed the dataset once with `--seed-dataset`). Each run costs roughly 2 to 5 model calls
per prompt. Use `--limit 2 --no-langfuse` for a quick local smoke test. The eval follows the
same defaults (Architect + B-rep, so it needs the geometry service); its start-up line prints
the effective pipeline and kernel. Pass `--kernel openscad` or `--pipeline drafter` to compare
against the old path.

## Prior-art research (optional)

Before the Architect commits to a construction, a research node can search the web for how
the requested class of part is normally built and pause at a gate where you pick one of 2–3
approaches; the Architect is then bound to it. Set `TAVILY_API_KEY` to enable it (Tavily's
free tier is 1,000 requests/month; a design run uses 2–4). Without a key the pipeline runs
exactly as before. `CADAI_RESEARCH=off` disables the node, and `CADAI_RESEARCH_STUB=1`
serves canned results so the gate can be tried without a key or quota. The eval opts in
with `--research on` and reports `researchRan` and `citedApproachChosen` alongside the
other rates.

## Technologies Used
- Next.js (App Router)
- Model Context Protocol (MCP) SDK
- LangGraph & Anthropic API
- Three.js / React Three Fiber
- Monaco Editor
- OpenSCAD WASM
