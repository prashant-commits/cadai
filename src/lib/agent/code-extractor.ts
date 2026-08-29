/**
 * Extracts OpenSCAD code from LLM markdown text.
 */
export function extractOpenScadCode(text: string): string | null {
  if (!text) return null;

  // 1. Look for ```openscad ... ``` code block
  const openscadRegex = /```(?:openscad|scad)\s*([\s\S]*?)```/i;
  const match = text.match(openscadRegex);
  if (match && match[1] && match[1].trim().length > 0) {
    return match[1].trim();
  }

  // 2. Look for any code block that contains OpenSCAD keywords
  const genericCodeRegex = /```(?:[a-zA-Z0-9_-]*)\s*([\s\S]*?)```/g;
  let genericMatch: RegExpExecArray | null;
  while ((genericMatch = genericCodeRegex.exec(text)) !== null) {
    const codeCandidate = genericMatch[1].trim();
    if (
      codeCandidate.includes('cube(') ||
      codeCandidate.includes('cylinder(') ||
      codeCandidate.includes('sphere(') ||
      codeCandidate.includes('difference()') ||
      codeCandidate.includes('union()') ||
      codeCandidate.includes('linear_extrude(') ||
      codeCandidate.includes('polyhedron(')
    ) {
      return codeCandidate;
    }
  }

  return null;
}
