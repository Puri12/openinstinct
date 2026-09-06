/**
 * iMessage renders raw text. The model is told not to emit Markdown, but a
 * prompt is a request and this is a guarantee: strip the common syntax so
 * the owner never sees **bold**, `code`, or "- " bullets.
 */
export function toPlainText(text: string): string {
  let out = text.replace(/\r\n/g, "\n");
  // fenced code → indented block without the fence lines
  out = out.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body: string) => body.replace(/\n$/, ""));
  out = out.replace(/`([^`\n]+)`/g, "$1");
  out = out.replace(/^#{1,6}\s+/gm, "");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/__([^_\n]+)__/g, "$1");
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1$2").replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1$2");
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 $2");
  out = out.replace(/^\s*[-*+]\s+/gm, "• ");
  out = out.replace(/^\s*>\s?/gm, "");
  out = out.replace(/^\s*[-*_]{3,}\s*$/gm, "");
  out = out.replace(/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$\n?/gm, "");
  out = out.replace(/^\|(.+)\|$/gm, (_m, row: string) => row.split("|").map((c) => c.trim()).filter(Boolean).join("  "));
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
