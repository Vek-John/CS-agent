import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryPrincipalCookie,
  issueTestMemoryPrincipalCookie,
  hmacSha256Base64Url,
  resolveMemoryPrincipal,
  signMemoryPrincipalCookie,
  verifyHmacSha256Base64Url,
} from "./principal";

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
});
