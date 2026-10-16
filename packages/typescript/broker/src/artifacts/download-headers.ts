/** ASCII fallback plus RFC 8187 UTF-8 filename for non-ASCII downloads. */
export function attachmentContentDisposition(name: string): string {
  const cleaned = name.replace(/[\x00-\x1f\x7f"\\]/g, '_').trim() || 'download';
  const fallback = cleaned.replace(/[^\x20-\x7e]/g, '_');
  const attachment = `attachment; filename="${fallback}"`;
  if (cleaned === fallback) return attachment;
  const encoded = encodeURIComponent(cleaned).replace(/[!'()*]/g, char =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${attachment}; filename*=UTF-8''${encoded}`;
}
