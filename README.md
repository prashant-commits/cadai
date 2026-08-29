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

## Technologies Used
- Next.js (App Router)
- Model Context Protocol (MCP) SDK
- LangGraph & Google Gemini
- Three.js / React Three Fiber
- Monaco Editor
- OpenSCAD WASM
