import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { compileScad } from '../engine/scad-compiler';
import * as fs from 'fs';
import * as path from 'path';
import { ENGINEERING_MODULE_REGISTRY } from '../agent/engineering-tools';
import { parseStlToGeometry } from '../engine/geometry-utils';
import { checkInterference } from '../engine/assembly-verifier';

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
      const result = await compileScad(code);

      if (!result.valid) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                error: result.error || 'OpenSCAD compilation failed.',
                diagnostics: {
                  errors: result.errors,
                  warnings: result.warnings,
                },
              }),
            },
          ],
        };
      }

      const stl = result.stl!;
      // Compute geometric metadata and physical slicer telemetry
      const { modelInfo } = parseStlToGeometry(stl);

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
              compileTimeMs: result.compileTimeMs,
              modelInfo,
              savedFiles: savedPaths,
              stlPreviewSnippet: stl.slice(0, 300) + '...',
              summary: result.summary,
              diagnostics: {
                errors: result.errors,
                warnings: result.warnings,
              },
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
const moduleKeys = Object.keys(ENGINEERING_MODULE_REGISTRY) as [string, ...string[]];

server.tool(
  'get_engineering_module',
  'Retrieves verified parametric OpenSCAD modules and design rules for mechanical fasteners, snap-fits, enclosures, stiffening gussets, dovetails, print-in-place hinges, honeycomb lattices, polar bolt circles, and involute spur gears.',
  {
    moduleKey: z.enum(moduleKeys).describe('The key of the engineering module to retrieve.'),
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

/**
 * Tool 4: verify_assembly_interference
 * Probes for physical interference/collision between two instantiated CAD modules by compiling their intersection.
 */
server.tool(
  'verify_assembly_interference',
  'Checks for physical collision between two parts in a CAD assembly. Compiles their intersection and measures if resulting volume is > 0.',
  {
    code: z.string().describe('The shared OpenSCAD code containing module definitions.'),
    callA: z.string().describe('The instantiation code for part A (e.g., "translate([0,0,0]) partA();")'),
    callB: z.string().describe('The instantiation code for part B (e.g., "translate([10,0,0]) partB();")'),
  },
  async ({ code, callA, callB }) => {
    const result = await checkInterference(code, callA, callB);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);
