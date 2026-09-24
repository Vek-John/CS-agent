import { parseDecisionAssessmentPacket } from "@cs-coach/review-planner";
import { assessWithJev } from "../../../../lib/coaching/jev-decision-assessment";
import { decisionProviderEnv } from "../../../../lib/desktop/provider";
import { sameOriginRequest } from "../../../../lib/desktop/request-origin";
export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function config() {
  const env = decisionProviderEnv();
  const mode = env.CS_DECISION_ASSESSMENT_MODE === "JEV_SHADOW" || env.CS_DECISION_ASSESSMENT_MODE === "JEV_EXPERIMENT" ? env.CS_DECISION_ASSESSMENT_MODE : "RULE_BASELINE";
  return { mode, acceptance: env.CS_DECISION_ASSESSMENT_ACCEPTANCE === "TEST_ONLY" ? "TEST_ONLY" : "DISABLED" };
}
export async function GET(request: Request): Promise<Response> {
  if (!sameOriginRequest(request)) return json({ mode: "RULE_BASELINE", acceptance: "DISABLED" }, 403);
  return json(config());
}
export async function POST(request: Request): Promise<Response> {
  if (!sameOriginRequest(request)) return json({ reason: "CROSS_ORIGIN" }, 403);
  if (config().mode === "RULE_BASELINE") return json({ status: "FALLBACK", reason: "DISABLED", latencyMs: 0, usage: { inputTokens: null, outputTokens: null, costUsd: null } });
  if (Number(request.headers.get("content-length") ?? 0) > 16384) return json({ reason: "REQUEST_TOO_LARGE" }, 413);
  try {
    // Bound streamed bodies too; missing Content-Length is not a size exemption.
    const reader = request.body?.getReader();
    if (!reader) return json({ reason: "INVALID_REQUEST" }, 400);
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 16384) { await reader.cancel(); return json({ reason: "REQUEST_TOO_LARGE" }, 413); } chunks.push(chunk.value); }
    const body = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const packet = parseDecisionAssessmentPacket(JSON.parse(new TextDecoder().decode(body)));
    return json(await assessWithJev(packet, decisionProviderEnv(), { signal: request.signal }));
  } catch { return json({ reason: "INVALID_REQUEST" }, 400); }
}
