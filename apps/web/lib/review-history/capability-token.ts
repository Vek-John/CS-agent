/** Converts DAL Authorization into the token-only Viewer bridge wire value. */
export function bridgeCapabilityToken(authorization: string): string | undefined {
  const token = authorization.replace(/^Bearer /u, "");
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : undefined;
}
