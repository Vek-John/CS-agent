import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryPrincipalCookie,
  issueTestMemoryPrincipalCookie,
  hmacSha256Base64Url,
  resolveMemoryPrincipal,
  signMemoryPrincipalCookie,
  verifyHmacSha256Base64Url,
} from "./principal";
import { DESKTOP_LOCAL_PRINCIPAL_ID, ensureRequestPrincipal } from "./api";
import { DESKTOP_APP_ORIGIN_HEADER } from "../desktop/request-origin";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("anonymous memory principal", () => {
  it("signs and verifies an opaque cookie without putting the ID in response data", async () => {
    const cookie = await issueTestMemoryPrincipalCookie("fixture-principal");
    const token = cookie.split(";")[0];
    const request = new Request("http://localhost/api/memory/status", { headers: { cookie: token } });
    const resolved = await resolveMemoryPrincipal(request);
    expect(resolved.principal?.type).toBe("ANONYMOUS");
    expect(resolved.principal?.id).toBe("fixture-principal");
    expect(JSON.stringify({ principalType: resolved.principal?.type })).not.toContain("fixture-principal");
  });

  it("rejects a modified signature and emits HttpOnly/Lax cookie attributes", async () => {
    const cookie = await issueTestMemoryPrincipalCookie("principal-a", { secure: false });
    const value = cookie.split(";")[0].slice("cs_coach_memory_principal=".length);
    const [encoded, signature] = value.split(".");
    const tampered = new Request("http://localhost/api/memory/status", { headers: { cookie: `cs_coach_memory_principal=${encoded}.${signature?.slice(0, -1)}x` } });
    expect((await resolveMemoryPrincipal(tampered)).principal).toBeUndefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("uses Secure only in production and clears state explicitly", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEMORY_PRINCIPAL_SECRET", "a stable test secret");
    const cookie = await signMemoryPrincipalCookie({ id: "prod-principal", type: "ANONYMOUS", consent: "GRANTED", consentVersion: 1, issuedAt: "2026-08-28T00:00:00.000Z" });
    expect(cookie).toContain("Secure");
    expect(clearMemoryPrincipalCookie()).toContain("Max-Age=0");
  });

  it("rejects non-canonical or truncated base64url HMAC signatures", async () => {
    const signature = await hmacSha256Base64Url("body", "internal-secret");
    expect(await verifyHmacSha256Base64Url("body", signature, "internal-secret")).toBe(true);
    expect(await verifyHmacSha256Base64Url("body", `${signature}=`, "internal-secret")).toBe(false);
    expect(await verifyHmacSha256Base64Url("body", signature.slice(0, -1), "internal-secret")).toBe(false);
  });

  it("uses the stable local principal only behind desktop loopback session-cookie protection", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOY_TARGET", "desktop");
    const cookie = `cs_agent_runtime=${"s".repeat(43)}`;
    const desktopOrigin = "http://127.0.0.1:43123";
    const desktop = await ensureRequestPrincipal(new Request(`${desktopOrigin}/api/memory/status`, {
      headers: { cookie, [DESKTOP_APP_ORIGIN_HEADER]: desktopOrigin },
    }));
    expect(desktop).toMatchObject({ persistent: true, principal: { id: DESKTOP_LOCAL_PRINCIPAL_ID, consent: "UNKNOWN" } });
    expect(desktop.setCookie).toBeUndefined();

    const missingSession = await ensureRequestPrincipal(new Request(`${desktopOrigin}/api/memory/status`, {
      headers: { [DESKTOP_APP_ORIGIN_HEADER]: desktopOrigin },
    }));
    expect(missingSession.principal.id).not.toBe(DESKTOP_LOCAL_PRINCIPAL_ID);
    const missingTrustedOrigin = await ensureRequestPrincipal(new Request(`${desktopOrigin}/api/memory/status`, { headers: { cookie } }));
    expect(missingTrustedOrigin.principal.id).not.toBe(DESKTOP_LOCAL_PRINCIPAL_ID);
  });

  it("cannot enable the desktop principal from a public deploy target", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEPLOY_TARGET", "cloudflare");
    vi.stubEnv("NEXT_PUBLIC_DEPLOY_TARGET", "desktop");
    const resolved = await ensureRequestPrincipal(new Request("http://127.0.0.1:43123/api/memory/status", {
      headers: {
        cookie: `cs_agent_runtime=${"s".repeat(43)}`,
        [DESKTOP_APP_ORIGIN_HEADER]: "http://127.0.0.1:43123",
      },
    }));
    expect(resolved.principal.id).not.toBe(DESKTOP_LOCAL_PRINCIPAL_ID);
  });
});
