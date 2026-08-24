import {
  SessionSummaryInputSchema,
  SessionSummaryThemeSchema,
  type SessionSummaryInput,
} from "./types";
import { z } from "zod";

export const SESSION_WRAP_UP_SCHEMA_VERSION = "coach-agent-session-wrap-up.v1" as const;
export const MAX_SESSION_WRAP_UP_THEMES = 3;
export const MAX_SESSION_WRAP_UP_REQUEST_BYTES = 32 * 1024;

const Id = z.string().min(1).max(160);
const Ref = z.string().min(1).max(160);
const LimitedText = z.string().trim().min(1).max(800);
const Limitations = z.array(z.string().trim().min(1).max(200)).max(4);

/** A PRESENTABLE cue projection supplied by the caller, not provider prose. */
export const SessionWrapUpCueFieldSchema = z
  .object({
    text: LimitedText,
    refs: z.array(Ref).min(1).max(8),
    limitations: Limitations,
  })
  .strict();
export type SessionWrapUpCueField = z.infer<typeof SessionWrapUpCueFieldSchema>;

export const SessionWrapUpAdviceSchema = z
  .object({
    id: Ref,
    text: LimitedText,
    refs: z.array(Ref).max(8),
  })
  .strict();
export type SessionWrapUpAdvice = z.infer<typeof SessionWrapUpAdviceSchema>;

/** SessionSummaryTheme projection safe for a provider packet; round ordering is omitted. */
export const SessionWrapUpThemeInputSchema = z
  .object({
    focus: Id,
    cueRefs: z.array(Ref).max(16),
    evidenceRefs: z.array(Ref).max(16),
    occurrence: z.number().int().positive().max(64),
    economyContext: z.enum(["PISTOL", "ECO", "FORCE", "FULL", "UNKNOWN"]),
    repeated: z.literal(true),
    conflictEvidence: z.boolean(),
    adviceRefs: z.array(Ref).max(8),
    limitations: z.array(z.string().trim().min(1).max(200)).max(4),
  })
  .strict();
export type SessionWrapUpThemeInput = z.infer<typeof SessionWrapUpThemeInputSchema>;

/**
 * The only cue material the wrap-up module may read. It is intentionally
 * smaller than a NarrationBundle and has no route, tick, identity, or replay.
 */
export const PresentableSessionWrapUpCueSchema = z
  .object({
    cueId: Id,
    focus: Id,
    coreIssue: SessionWrapUpCueFieldSchema,
    betterPlay: SessionWrapUpCueFieldSchema,
    advice: z.array(SessionWrapUpAdviceSchema).max(8),
  })
  .strict();
export type PresentableSessionWrapUpCue = z.infer<typeof PresentableSessionWrapUpCueSchema>;

export interface SessionWrapUpBuildInput {
  summary: SessionSummaryInput;
  presentableCues: Readonly<Record<string, PresentableSessionWrapUpCue>>;
}

export const SessionWrapUpRequestCueSchema = z
  .object({
    cueId: Id,
    focus: Id,
    coreIssue: SessionWrapUpCueFieldSchema,
    betterPlay: SessionWrapUpCueFieldSchema,
    advice: z.array(SessionWrapUpAdviceSchema).min(1).max(8),
  })
  .strict();
export type SessionWrapUpRequestCue = z.infer<typeof SessionWrapUpRequestCueSchema>;

export const SessionWrapUpRequestSchema = z
  .object({
    schemaVersion: z.literal(SESSION_WRAP_UP_SCHEMA_VERSION),
    themes: z.array(SessionWrapUpThemeInputSchema).max(MAX_SESSION_WRAP_UP_THEMES),
    completedCues: z.array(SessionWrapUpRequestCueSchema).max(MAX_SESSION_WRAP_UP_THEMES),
    limitations: z.array(z.string().trim().min(1).max(200)).max(8),
  })
  .strict();
export type SessionWrapUpRequest = z.infer<typeof SessionWrapUpRequestSchema>;

export const SessionWrapUpOutputFieldSchema = z
  .object({
    text: LimitedText,
    refs: z.array(Ref).min(1).max(8),
  })
  .strict();
export type SessionWrapUpOutputField = z.infer<typeof SessionWrapUpOutputFieldSchema>;

export const SessionWrapUpThemeSchema = z
  .object({
    focus: Id,
    summary: SessionWrapUpOutputFieldSchema,
    trainingAdvice: SessionWrapUpOutputFieldSchema,
  })
  .strict();
export type SessionWrapUpTheme = z.infer<typeof SessionWrapUpThemeSchema>;

export const SessionWrapUpBundleSchema = z
  .object({
    schemaVersion: z.literal(SESSION_WRAP_UP_SCHEMA_VERSION),
    themes: z.array(SessionWrapUpThemeSchema).max(MAX_SESSION_WRAP_UP_THEMES),
    limitations: z.array(z.string().trim().min(1).max(200)).max(8),
  })
  .strict();
export type SessionWrapUpBundle = z.infer<typeof SessionWrapUpBundleSchema>;

export const SessionWrapUpManifestSchema = z
  .object({
    status: z.enum(["SUCCEEDED", "FALLBACK", "DISABLED"]),
    provider: z.enum(["DETERMINISTIC", "DEEPSEEK"]),
    model: z.string().min(1).max(120).optional(),
    reason: z.string().min(1).max(160).optional(),
    limitations: z.array(z.string().trim().min(1).max(200)).max(8),
  })
  .strict();
export type SessionWrapUpManifest = z.infer<typeof SessionWrapUpManifestSchema>;

export const SessionWrapUpResultSchema = z
  .object({
    status: z.enum(["SUCCEEDED", "FALLBACK", "DISABLED"]),
    bundle: SessionWrapUpBundleSchema,
    manifest: SessionWrapUpManifestSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status !== result.manifest.status) {
      context.addIssue({ code: "custom", path: ["manifest", "status"], message: "Wrap-up status and manifest status must match." });
    }
    if ((result.status === "SUCCEEDED" && result.manifest.provider !== "DEEPSEEK") || (result.status !== "SUCCEEDED" && result.manifest.provider !== "DETERMINISTIC")) {
      context.addIssue({ code: "custom", path: ["manifest", "provider"], message: "Wrap-up provider must match result status." });
    }
  });
export type SessionWrapUpResult = z.infer<typeof SessionWrapUpResultSchema>;

export class SessionWrapUpValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionWrapUpValidationError";
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function fail(message: string): never {
  throw new SessionWrapUpValidationError(message);
}

function assertSubset(values: readonly string[], allowed: ReadonlySet<string>, name: string): void {
  if (values.some((value) => !allowed.has(value))) fail(`${name} contains an unknown ref.`);
}

function normalizedCueField(field: PresentableSessionWrapUpCue["coreIssue"]): SessionWrapUpCueField {
  return SessionWrapUpCueFieldSchema.parse({
    text: field.text,
    refs: [...field.refs],
    limitations: [...field.limitations],
  });
}

/**
 * Builds the provider-neutral request and performs all cross-theme/cue/ref
 * checks once. Callers do not need to understand the provider packet shape.
 */
export function buildSessionWrapUpRequest(input: SessionWrapUpBuildInput): SessionWrapUpRequest {
  let summary: SessionSummaryInput;
  try {
    summary = SessionSummaryInputSchema.parse(input.summary);
  } catch {
    fail("SessionSummaryInput is invalid or contains a singleton theme.");
  }

  const themes = summary.themes.map((theme) => SessionSummaryThemeSchema.parse(theme));
  if (new Set(themes.map((theme) => theme.focus)).size !== themes.length) {
    fail("SessionSummaryInput contains duplicate theme focuses.");
  }

  const completedCues = summary.completedCues;
  if (new Set(completedCues.map((cue) => cue.cueId)).size !== completedCues.length) {
    fail("SessionSummaryInput contains duplicate completed cues.");
  }

  const sources = new Map<string, PresentableSessionWrapUpCue>();
  for (const [key, rawSource] of Object.entries(input.presentableCues)) {
    let source: PresentableSessionWrapUpCue;
    try {
      source = PresentableSessionWrapUpCueSchema.parse(rawSource);
    } catch {
      fail(`PRESENTABLE cue source ${key} is invalid.`);
    }
    if (key !== source.cueId) fail(`PRESENTABLE cue source key ${key} does not match cueId.`);
    sources.set(key, source);
  }

  const completedCueIds = new Set(completedCues.map((cue) => cue.cueId));
  if (sources.size !== completedCueIds.size || [...sources.keys()].some((cueId) => !completedCueIds.has(cueId))) {
    fail("PRESENTABLE cue sources must exactly match completed cue IDs.");
  }

  const themeByFocus = new Map(themes.map((theme) => [theme.focus, theme]));
  const requestCues: SessionWrapUpRequestCue[] = [];
  for (const completedCue of completedCues) {
    const theme = themeByFocus.get(completedCue.focus);
    if (!theme || !theme.cueRefs.includes(completedCue.cueId)) {
      fail(`Completed cue ${completedCue.cueId} is not owned by its input theme.`);
    }
    assertSubset(completedCue.evidenceRefs, new Set(theme.evidenceRefs), `completed cue ${completedCue.cueId} evidence`);
    assertSubset(completedCue.adviceRefs, new Set(theme.adviceRefs), `completed cue ${completedCue.cueId} advice`);

    const source = sources.get(completedCue.cueId);
    if (!source) fail(`Missing PRESENTABLE source for cue ${completedCue.cueId}.`);
    if (source.focus !== completedCue.focus) fail(`PRESENTABLE cue ${completedCue.cueId} focus does not match SessionSummaryInput.`);

    const adviceIds = new Set(completedCue.adviceRefs);
    const advice = source.advice.filter((item) => adviceIds.has(item.id));
    if (advice.length === 0) fail(`Cue ${completedCue.cueId} has no legal advice text.`);
    if (new Set(advice.map((item) => item.id)).size !== advice.length) fail(`Cue ${completedCue.cueId} has duplicate advice IDs.`);

    requestCues.push(SessionWrapUpRequestCueSchema.parse({
      cueId: completedCue.cueId,
      focus: completedCue.focus,
      coreIssue: normalizedCueField(source.coreIssue),
      betterPlay: normalizedCueField(source.betterPlay),
      advice,
    }));
  }

  for (const theme of themes) {
    const themeCueIds = new Set(theme.cueRefs);
    const representative = completedCues.find((cue) => themeCueIds.has(cue.cueId));
    if (!representative) fail(`Theme ${theme.focus} has no completed representative cue.`);
    if (!representative.adviceRefs.some((ref) => theme.adviceRefs.includes(ref))) {
      fail(`Theme ${theme.focus} has no representative advice ref.`);
    }
  }

  const request = SessionWrapUpRequestSchema.parse({
    schemaVersion: SESSION_WRAP_UP_SCHEMA_VERSION,
    themes: themes.map(({ roundRefs: _roundRefs, ...theme }) => SessionWrapUpThemeInputSchema.parse(theme)),
    completedCues: requestCues.map((cue) => SessionWrapUpRequestCueSchema.parse(cue)),
    limitations: unique(summary.limitations),
  });
  const byteLength = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  if (byteLength > MAX_SESSION_WRAP_UP_REQUEST_BYTES) fail("Session wrap-up request is too large.");
  return request;
}

/** Validates a provider bundle against the exact input theme/ref namespaces. */
export function assertValidSessionWrapUpBundle(
  rawBundle: unknown,
  request: SessionWrapUpRequest,
): SessionWrapUpBundle {
  const bundle = SessionWrapUpBundleSchema.parse(rawBundle);
  if (bundle.themes.length !== request.themes.length) fail("Wrap-up provider changed the theme count.");
  const inputThemes = new Map(request.themes.map((theme) => [theme.focus, theme]));
  const seen = new Set<string>();
  for (const outputTheme of bundle.themes) {
    if (seen.has(outputTheme.focus)) fail("Wrap-up provider returned a duplicate theme.");
    seen.add(outputTheme.focus);
    const inputTheme = inputThemes.get(outputTheme.focus);
    if (!inputTheme) fail("Wrap-up provider introduced or changed a theme focus.");
    const summaryRefs = new Set([...inputTheme.cueRefs, ...inputTheme.evidenceRefs]);
    assertSubset(outputTheme.summary.refs, summaryRefs, `Wrap-up ${outputTheme.focus} summary`);
    if (!outputTheme.summary.refs.some((ref) => inputTheme.cueRefs.includes(ref) || inputTheme.evidenceRefs.includes(ref))) {
      fail(`Wrap-up ${outputTheme.focus} summary has no legal cue/evidence ref.`);
    }
    assertSubset(outputTheme.trainingAdvice.refs, new Set(inputTheme.adviceRefs), `Wrap-up ${outputTheme.focus} advice`);
    if (!outputTheme.trainingAdvice.refs.some((ref) => inputTheme.adviceRefs.includes(ref))) {
      fail(`Wrap-up ${outputTheme.focus} training advice has no legal advice ref.`);
    }
  }
  if (seen.size !== inputThemes.size) fail("Wrap-up provider omitted an input theme.");
  return bundle;
}

function representativeCue(request: SessionWrapUpRequest, theme: SessionWrapUpRequest["themes"][number]): SessionWrapUpRequestCue {
  const cueIds = new Set(theme.cueRefs);
  const cue = request.completedCues.find((candidate) => cueIds.has(candidate.cueId));
  if (!cue) fail(`Theme ${theme.focus} has no completed cue.`);
  return cue;
}

/** Deterministic fallback only reuses source coreIssue/betterPlay/advice text. */
export function deterministicSessionWrapUpBundle(request: SessionWrapUpRequest): SessionWrapUpBundle {
  const themes = request.themes.map((theme) => {
    const cue = representativeCue(request, theme);
    const advice = cue.advice.find((item) => theme.adviceRefs.includes(item.id));
    if (!advice) fail(`Theme ${theme.focus} has no source advice for fallback.`);
    return {
      focus: theme.focus,
      summary: {
        text: cue.coreIssue.text,
        refs: [theme.cueRefs[0] ?? theme.evidenceRefs[0]],
      },
      trainingAdvice: {
        text: advice.text,
        refs: [advice.id],
      },
    };
  });
  return SessionWrapUpBundleSchema.parse({
    schemaVersion: SESSION_WRAP_UP_SCHEMA_VERSION,
    themes,
    limitations: request.themes.length === 0 ? ["NO_REPEATED_THEME"] : request.limitations,
  });
}

export function deterministicSessionWrapUpResult(
  request: SessionWrapUpRequest,
  reason: string,
): SessionWrapUpResult {
  const status = request.themes.length === 0 ? "DISABLED" : "FALLBACK";
  return SessionWrapUpResultSchema.parse({
    status,
    bundle: deterministicSessionWrapUpBundle(request),
    manifest: {
      status,
      provider: "DETERMINISTIC",
      reason,
      limitations: [reason],
    },
  });
}
