/**
 * Extracts OpenSCAD code from LLM markdown text.
 */
export function extractOpenScadCode(text: string): { code: string | null; error?: 'truncated' | 'no_code' } {
  if (!text) return { code: null, error: 'no_code' };

  // Detect unterminated fence (odd count of ```)
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 !== 0) {
    return { code: null, error: 'truncated' };
  }

  const geometryTokens = [
    'cube(', 'cylinder(', 'sphere(', 'difference()', 'union()', 'polyhedron(',
    'polygon(', 'offset(', 'linear_extrude(', 'rotate_extrude(', 'hull(', 'intersection(', 'module '
  ];

  let bestMatch: string | null = null;
  let maxLength = -1;

  // 1. Look for ```openscad ... ``` code blocks
  const openscadRegex = /```(?:openscad|scad)\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = openscadRegex.exec(text)) !== null) {
    const codeCandidate = match[1].trim();
    if (codeCandidate.length > maxLength && geometryTokens.some(token => codeCandidate.includes(token))) {
      bestMatch = codeCandidate;
      maxLength = codeCandidate.length;
    }
  }

  if (bestMatch) {
    return { code: bestMatch };
  }

  // 2. Look for any code block that contains OpenSCAD keywords
  const genericCodeRegex = /```(?:[a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g;
  while ((match = genericCodeRegex.exec(text)) !== null) {
    const codeCandidate = match[1].trim();
    if (codeCandidate.length > maxLength && geometryTokens.some(token => codeCandidate.includes(token))) {
      bestMatch = codeCandidate;
      maxLength = codeCandidate.length;
    }
  }

  if (bestMatch) {
    return { code: bestMatch };
  }

  return { code: null, error: 'no_code' };
}
