import {
  TeachingDiagnosisInputSchema,
  TeachingDiagnosisOutputSchema,
  UserReflectionSchema,
  diagnoseTeachingCue,
  reviseTeachingDiagnosis,
  type TeachingDiagnosisInput,
  type TeachingDiagnosisOutput,
} from "@cs-coach/coach-agent";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 64 * 1024;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return origin === new URL(request.url).origin; } catch { return false; }
}

function fallback(reason: string): Response {
  return json({ status: "FALLBACK", reason: reason.slice(0, 200) });
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return fallback("CROSS_ORIGIN");
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return fallback("UNSUPPORTED_MEDIA_TYPE");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0 || length > MAX_REQUEST_BYTES) return fallback("REQUEST_TOO_LARGE");
  }
  let value: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) return fallback("REQUEST_TOO_LARGE");
    value = JSON.parse(raw);
  } catch { return fallback("INVALID_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback("INVALID_REQUEST");
  const envelope = value as Record<string, unknown>;
  // The HTTP boundary must repeat the decision-before-outcome contract.  Do
  // not allow a caller to invoke adaptive diagnosis until the Host has
  // completed the Outcome Gate, even if the input packet itself is valid.
  if (envelope.outcomeGateStatus !== "COMPLETE") return fallback("DIAGNOSIS_GATE_LOCKED");
  const mode = envelope.mode === "REVISE" ? "REVISE" : envelope.mode === "START" ? "START" : undefined;
  if (!mode || !envelope.input || typeof envelope.input !== "object" || Array.isArray(envelope.input)) return fallback("INVALID_REQUEST");
  try {
    // Rich PlayerState contains canonical ticks and player identity.  It
    // stays in the local Host; the remote API accepts only the bounded,
    // identity-free decisionResources projection.
    if (Object.prototype.hasOwnProperty.call(envelope.input, "decisionState")) {
      return fallback("RICH_DECISION_STATE_NOT_ALLOWED");
    }
    const input = TeachingDiagnosisInputSchema.parse(envelope.input) as TeachingDiagnosisInput;
    let output: TeachingDiagnosisOutput;
    if (mode === "REVISE") {
      if (!envelope.previous || !envelope.disagreement) return fallback("REVISION_INPUT_MISSING");
      output = reviseTeachingDiagnosis({
        previous: TeachingDiagnosisOutputSchema.parse(envelope.previous),
        input,
        disagreement: UserReflectionSchema.parse(envelope.disagreement),
      });
    } else {
      output = diagnoseTeachingCue(input);
    }
    return json({ status: "SUCCEEDED", ...TeachingDiagnosisOutputSchema.parse(output) });
  } catch (error) {
    return fallback(error instanceof Error ? error.message : "DIAGNOSTIC_FAILED");
  }
}

export function GET(): Response { return json({ status: "FALLBACK", reason: "METHOD_NOT_ALLOWED" }, 405); }
