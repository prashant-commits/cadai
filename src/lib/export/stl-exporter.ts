/**
 * Triggers a browser file download from string or Blob.
 */
export function downloadFile(filename: string, content: string | Blob, mimeType = 'application/octet-stream') {
  if (typeof document === 'undefined') return;
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Exports the current STL content to a downloaded file.
 */
export function exportStl(stlContent: string, filename = 'cadai_model.stl') {
  if (!stlContent) {
    throw new Error('No STL content available to export.');
  }
  downloadFile(filename, stlContent, 'application/sla');
}

/**
 * Exports STEP content (base64 or raw string) to a downloaded file.
 */
export function exportStep(
  stepContent: string,
  filename = 'cadai_model.step',
  encoding: 'base64' | 'text' = 'base64'
) {
  if (!stepContent) {
    throw new Error('No STEP content available to export.');
  }
  let blob: Blob;
  if (encoding === 'base64') {
    const binaryString = atob(stepContent);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    blob = new Blob([bytes], { type: 'application/step' });
  } else {
    blob = new Blob([stepContent], { type: 'application/step' });
  }
  downloadFile(filename, blob, 'application/step');
}
