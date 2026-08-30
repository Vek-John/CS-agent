const REMOTE_FONT_LINK = /\s*<link\b(?=[^>]*\bhref=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com)[^>]*\/?\s*>/gisu;
const EMPTY_NOSCRIPT = /\s*<noscript>\s*<\/noscript>/gisu;
const REMOTE_FONT_ORIGIN = /https:\/\/fonts\.(?:googleapis|gstatic)\.com/iu;

/** Keep the bundled Viewer offline-only without weakening its CSP. */
export function sanitizeViewerHtml(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("viewer HTML is missing");
  }
  const sanitized = source
    .replace(REMOTE_FONT_LINK, "")
    .replace(EMPTY_NOSCRIPT, "");
  if (REMOTE_FONT_ORIGIN.test(sanitized)) {
    throw new Error("viewer HTML still references remote fonts");
  }
  return sanitized;
}
