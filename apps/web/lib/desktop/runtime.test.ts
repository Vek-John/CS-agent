import { describe, expect, it } from "vitest";
import {
  desktopViewerOriginFromHeaders,
  isDesktopRuntimeRequest,
  validatedDesktopViewerOrigin,
} from "./runtime";

describe("desktop runtime request seam", () => {
  it("accepts only the cookie-isolated localhost viewer authority", () => {
    expect(validatedDesktopViewerOrigin("http://localhost:43123")).toBe("http://localhost:43123");
    expect(validatedDesktopViewerOrigin("http://localhost:43123/")).toBe("http://localhost:43123");
    expect(validatedDesktopViewerOrigin("http://127.0.0.1:43123")).toBeUndefined();
    expect(validatedDesktopViewerOrigin("http://[::1]:43123")).toBeUndefined();
    expect(validatedDesktopViewerOrigin("https://localhost:43123")).toBeUndefined();
    expect(validatedDesktopViewerOrigin("http://localhost:43123/cs2d")).toBeUndefined();
    expect(validatedDesktopViewerOrigin("http://localhost:43123/?x=1")).toBeUndefined();
    expect(validatedDesktopViewerOrigin("http://localhost.:43123")).toBeUndefined();
  });

  it("reads only the runtime-owned request header", () => {
    const desktopHeaders = new Headers({ "x-cs-agent-viewer-origin": "http://localhost:51234" });
    expect(desktopViewerOriginFromHeaders(desktopHeaders))
      .toBe("http://localhost:51234");
    expect(desktopViewerOriginFromHeaders(new Headers())).toBeUndefined();
    expect(isDesktopRuntimeRequest(desktopHeaders)).toBe(true);
    expect(isDesktopRuntimeRequest(new Headers())).toBe(false);
  });
});
