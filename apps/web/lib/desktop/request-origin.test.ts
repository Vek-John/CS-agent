import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_APP_ORIGIN_HEADER,
  sameOriginRequest,
  validatedDesktopAppOrigin,
} from "./request-origin";

afterEach(() => vi.unstubAllEnvs());

describe("trusted desktop request origin", () => {
  it("accepts only the exact IPv4 loopback app origin", () => {
    expect(validatedDesktopAppOrigin("http://127.0.0.1:43123")).toBe("http://127.0.0.1:43123");
    for (const value of [
      "http://localhost:43123",
      "http://[::1]:43123",
      "https://127.0.0.1:43123",
      "http://127.0.0.1:43123/path",
      "http://127.0.0.1:0",
    ]) expect(validatedDesktopAppOrigin(value)).toBeUndefined();
  });

  it("requires the host-injected origin in desktop production", () => {
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const origin = "http://127.0.0.1:43123";
    const trusted = new Request("http://127.0.0.1:0/api/memory/consent", {
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
        [DESKTOP_APP_ORIGIN_HEADER]: origin,
      },
    });
    expect(sameOriginRequest(trusted)).toBe(true);
    expect(sameOriginRequest(new Request(trusted.url, { headers: { origin } }))).toBe(false);
    expect(sameOriginRequest(new Request(trusted.url, { headers: {
      origin: "http://127.0.0.1:9999",
      [DESKTOP_APP_ORIGIN_HEADER]: origin,
    } }))).toBe(false);
  });

  it("keeps the ordinary request URL boundary outside desktop", () => {
    expect(sameOriginRequest(new Request("https://coach.example/api", {
      headers: { origin: "https://coach.example", "sec-fetch-site": "same-origin" },
    }))).toBe(true);
    expect(sameOriginRequest(new Request("https://coach.example/api", {
      headers: { origin: "https://evil.example" },
    }))).toBe(false);
  });
});
