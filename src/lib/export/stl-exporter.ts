/**
 * Triggers a browser file download from string or Blob.
 */
export function downloadFile(filename: string, content: string | Blob, mimeType = 'application/octet-stream') {
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
 * Exports current OpenSCAD STL content to a downloaded file.
 */
export function exportStl(stlContent: string, filename = 'cadai_model.stl') {
  if (!stlContent) {
    throw new Error('No STL content available to export.');
  }
  downloadFile(filename, stlContent, 'application/sla');
}
