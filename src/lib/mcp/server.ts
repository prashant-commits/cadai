import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createOpenSCAD } from 'openscad-wasm';
import * as fs from 'fs';
import * as path from 'path';
import { ENGINEERING_MODULE_REGISTRY } from '../agent/engineering-tools';
import { parseStlToGeometry } from '../engine/geometry-utils';

// Create MCP Server instance
export const server = new McpServer({
  name: 'cadai-mcp-server',
  version: '1.0.0',
});

/**
 * Tool 1: compile_and_validate_scad
 * Compiles OpenSCAD code to STL via WASM, verifies watertight manifoldness,
 * calculates volume & bounding box telemetry, and optionally writes output files to disk.
 */
server.tool(
  'compile_and_validate_scad',
  'Compiles OpenSCAD code to STL using in-memory WebAssembly (openscad-wasm), verifies geometric manifoldness, calculates physical volume and dimensions, and optionally exports .scad and .stl files to disk.',
  {
    code: z.string().describe('The complete, self-contained OpenSCAD code to compile.'),
    outputName: z.string().optional().describe('Optional basename for saving files in output/ directory (e.g., "m4_bracket").'),
  },
  async ({ code, outputName }) => {
    const startTime = Date.now();

    if (!code || code.trim().length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'Empty OpenSCAD code provided.',
            }),
          },
        ],
      };
    }

    try {
      const instance = await createOpenSCAD({
        print: (text: string) => console.error('[OpenSCAD stdout]:', text),
        printErr: (text: string) => console.error('[OpenSCAD stderr]:', text),
      });
      const stl = await instance.renderToStl(code);

      if (!stl || !stl.includes('facet normal')) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: 'OpenSCAD produced an empty or zero-volume model (no facets). Check that object dimensions and boolean cuts are non-zero.',
              }),
            },
          ],
        };
      }

      // Compute geometric metadata and physical slicer telemetry
      const { modelInfo } = parseStlToGeometry(stl);
      const compileTimeMs = Date.now() - startTime;

      let savedPaths: { scad?: string; stl?: string } = {};

      if (outputName) {
        const outputDir = path.resolve(process.cwd(), 'output');
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const cleanName = outputName.replace(/[^a-zA-Z0-9_-]/g, '_');
        const scadPath = path.join(outputDir, `${cleanName}.scad`);
        const stlPath = path.join(outputDir, `${cleanName}.stl`);

        fs.writeFileSync(scadPath, code, 'utf8');
        fs.writeFileSync(stlPath, stl, 'utf8');

        savedPaths = {
          scad: scadPath,
          stl: stlPath,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              compileTimeMs,
              modelInfo,
              savedFiles: savedPaths,
              stlPreviewSnippet: stl.slice(0, 300) + '...',
            }, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      let message = 'Unknown compiler error';
      if (err instanceof Error) {
        message = err.message;
      } else if (typeof err === 'object' && err !== null) {
        message = (err as any).message || (err as any).stderr || JSON.stringify(err);
      } else {
        message = String(err);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `OpenSCAD WASM Compiler Error: ${message}`,
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Tool 2: get_engineering_module
 * Retrieves tested, watertight OpenSCAD parametric modules for fasteners, snap-fits, enclosures, gears, and lattices.
 */
server.tool(
  'get_engineering_module',
  'Retrieves verified parametric OpenSCAD modules and design rules for mechanical fasteners, snap-fits, enclosures, stiffening gussets, dovetails, print-in-place hinges, honeycomb lattices, polar bolt circles, and involute spur gears.',
  {
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
    ]).describe('The key of the engineering module to retrieve.'),
  },
  async ({ moduleKey }) => {
    const moduleRecipe = ENGINEERING_MODULE_REGISTRY[moduleKey];
    if (!moduleRecipe) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Module '${moduleKey}' not found. Available keys: ${Object.keys(ENGINEERING_MODULE_REGISTRY).join(', ')}`,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            name: moduleRecipe.name,
            category: moduleRecipe.category,
            description: moduleRecipe.description,
            parameters: moduleRecipe.engineeringParameters,
            designRules: moduleRecipe.designRules,
            codeTemplate: moduleRecipe.codeTemplate,
          }, null, 2),
        },
      ],
    };
  }
);

/**
 * Tool 3: list_engineering_modules
 * Returns a list of all available mechanical and mathematical engineering modules in the catalog.
 */
server.tool(
  'list_engineering_modules',
  'Lists all available functional mechanical engineering and mathematical CAD modules in the catalog with summaries.',
  {},
  async () => {
    const list = Object.values(ENGINEERING_MODULE_REGISTRY).map((m) => ({
      id: m.id,
      name: m.name,
      category: m.category,
      description: m.description,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(list, null, 2),
        },
      ],
    };
  }
);
