import { describe, expect, it } from "vitest";
import { sanitizeViewerHtml } from "./sanitize-viewer-html.mjs";

describe("bundled viewer HTML sanitizer", () => {
  it("removes multiline Google font links and their empty noscript fallback", () => {
    const input = `<!doctype html><head>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        href="https://fonts.googleapis.com/css2?family=Inter"
        rel="stylesheet"
        onload="this.media='all'"
      />
      <noscript><link href="https://fonts.gstatic.com/font.css" rel="stylesheet" /></noscript>
      <script type="module" src="/cs2d/assets/app.js"></script>
    </head>`;
    const output = sanitizeViewerHtml(input);
    expect(output).not.toContain("fonts.googleapis.com");
    expect(output).not.toContain("fonts.gstatic.com");
    expect(output).not.toContain("<noscript>");
    expect(output).toContain('/cs2d/assets/app.js');
  });

  it("fails closed for missing HTML", () => {
    expect(() => sanitizeViewerHtml("")).toThrow(/viewer HTML is missing/u);
  });
});
