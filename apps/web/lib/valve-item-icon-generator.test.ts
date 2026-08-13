import { describe, expect, it } from "vitest";
// The generator is intentionally executable ESM outside the TypeScript app.
// @ts-expect-error the build utility has no separate declaration file
import { normalizeMonochromeSvg, svgDimensions } from "../../../tools/fetch_valve_item_icons.mjs";

describe("Valve HUD SVG asset generator", () => {
  it("normalizes fixed paint to a safe currentColor silhouette", () => {
    const source = Buffer.from(`<?xml version="1.0"?>
      <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "ignored.dtd">
      <svg width="88.5px" height="32px" viewBox="0 0 88.5 32" xmlns="http://www.w3.org/2000/svg">
        <path fill="#FFFFFF" stroke="rgb(1, 2, 3)" d="M0 0h1v1z"/>
        <path fill="none" d="M2 2h1v1z"/>
      </svg>`);

    const normalized = normalizeMonochromeSvg(source);
    const text = normalized.buffer.toString("utf8");

    expect(normalized).toMatchObject({ width: 89, height: 32 });
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(text).toContain('width="88.5px"');
    expect(text).toContain('height="32px"');
    expect(text).toContain('viewBox="0 0 88.5 32"');
    expect(text).toContain('color="#FFFFFF" fill="currentColor"');
    expect(text).toContain('fill="currentColor"');
    expect(text).toContain('stroke="currentColor"');
    expect(text).toContain('fill="none"');
    expect(text).not.toContain("DOCTYPE");
    expect(text).not.toContain("<script");
    expect(text).not.toMatch(/\b(?:href|xlink:href)\s*=/i);
    expect(text).not.toContain("#FFFFFF\" d=");
  });

  it("rejects active SVG content and reads width/height fallback", () => {
    expect(svgDimensions('<svg width="36" height="32"></svg>')).toEqual({ width: 36, height: 32 });
    expect(() => normalizeMonochromeSvg(Buffer.from(
      '<svg viewBox="0 0 24 24"><script>alert(1)</script></svg>'
    ))).toThrow("not a supported standalone SVG");
    expect(() => normalizeMonochromeSvg(Buffer.from(
      '<svg viewBox="0 0 24 24"><use href="https://example.test/icon.svg#x"/></svg>'
    ))).toThrow("active or external SVG reference");
  });
});
