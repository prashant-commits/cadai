import { createOpenSCAD } from 'openscad-wasm';

export interface ValidationResult {
  valid: boolean;
  stl?: string;
  error?: string;
}

/**
 * Basic syntax balance validation for brackets and quotes.
 */
export function checkSyntaxBalance(code: string): { valid: boolean; error?: string } {
  if (!code || code.trim().length === 0) {
    return { valid: false, error: 'OpenSCAD code is empty.' };
  }

  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const nextChar = i + 1 < code.length ? code[i + 1] : '';

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (char === '/' && nextChar === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (char === '/' && nextChar === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === '"' && (i === 0 || code[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '(' || char === '{' || char === '[') {
      stack.push(char);
    } else if (char === ')' || char === '}' || char === ']') {
      const expected = pairs[char];
      const actual = stack.pop();
      if (actual !== expected) {
        return {
          valid: false,
          error: `Unmatched closing bracket '${char}' found.`,
        };
      }
    }
  }

  if (stack.length > 0) {
    const unclosed = stack.pop();
    return {
      valid: false,
      error: `Unclosed bracket '${unclosed}' found in OpenSCAD code.`,
    };
  }

  return { valid: true };
}

/**
 * Validates OpenSCAD code by compiling it with openscad-wasm.
 */
export async function validateOpenScadCode(code: string): Promise<ValidationResult> {
  // 1. Fast static check
  const staticCheck = checkSyntaxBalance(code);
  if (!staticCheck.valid) {
    return { valid: false, error: staticCheck.error };
  }

  // 2. OpenSCAD WASM compilation check
  try {
    const instance = await createOpenSCAD();
    const stl = await instance.renderToStl(code);
    
    if (!stl || stl.trim().length === 0 || !stl.includes('facet normal')) {
      return {
        valid: false,
        error: 'OpenSCAD compilation produced an empty or degenerate 3D model (no facets). Check that object dimensions are non-zero.',
      };
    }

    return {
      valid: true,
      stl,
    };
  } catch (err: unknown) {
    let message = 'Unknown error';
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === 'object' && err !== null) {
      message = (err as any).message || (err as any).stderr || JSON.stringify(err);
    } else {
      message = String(err);
    }

    return {
      valid: false,
      error: `OpenSCAD Compiler Error: ${message}`,
    };
  }
}
