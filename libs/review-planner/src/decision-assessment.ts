import {
  DECISION_ASSESSMENT_VERSIONS as V, parseUserTacticalContext,
  type CandidateMaterial, type TeachingCandidate, type TeachingAssessment,
  type DecisionAssessmentPacket, type DecisionAssessmentBinding, type DecisionAssessmentResult,
  type DecisionAssessmentCheckCode, type DecisionAssessmentAtom
} from "@cs-coach/contracts";
import { buildDecisionObservationSemantics, parseDecisionObservationSemantics } from "./decision-observation";
import { buildDecisionWitnessCatalog, validateDecisionWitnesses } from "./decision-witness";

const CHECKS: readonly DecisionAssessmentCheckCode[] = ["objectiveAllowsDelay", "tradeWindow", "safeReachableCover"];
const unique = (items: readonly string[]) => [...new Set(items)];
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const probability = (n: unknown): n is number => finite(n) && n >= 0 && n <= 1;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Content identity only. Not a security signature; every consumer revalidates the current packet. */
export function decisionAssessmentFingerprint(packet: DecisionAssessmentPacket): string {
  const text = JSON.stringify(packet);
  let a = 2166136261, b = 5381;
  for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `decision-v1-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}-${text.length}`;
}

/** The server calls this on the final incoming JSON before constructing a provider request. */
export function parseDecisionAssessmentPacket(value: unknown): DecisionAssessmentPacket {
  const fail = (): never => { throw new Error("INVALID_DECISION_ASSESSMENT_PACKET"); };
  const keys = (v: unknown, expected: readonly string[]): Record<string, unknown> => {
    if (!record(v) || Object.keys(v).length !== expected.length || Object.keys(v).some(k => !expected.includes(k))) return fail();
    return v;
  };
  const arr = (v: unknown, max: number): unknown[] => { if (!Array.isArray(v) || v.length > max) return fail(); return v; };
  const alias = (v: unknown): string => { if (typeof v !== "string" || !/^e[1-9][0-9]{0,2}$/.test(v)) return fail(); return v; };
  const refs = (v: unknown): string[] => { const xs = arr(v, 32).map(alias); if (new Set(xs).size !== xs.length) return fail(); return xs; };
  const integer = (v: unknown, min: number, max: number): number => { if (!finite(v) || !Number.isInteger(v) || v < min || v > max) return fail(); return v; };
  const number = (v: unknown, min: number, max: number): number => { if (!finite(v) || v < min || v > max) return fail(); return v; };
  const root = keys(value, ["projectionVersion", "questionVersion", "scenario", "map", "state", "action", "evidence"]);
  const semanticProjection = root.projectionVersion === V.projectionWithObservationSemantics;
  const returnAndFire = root.projectionVersion === V.projectionWithReturnAndFire || semanticProjection && record(root.action) && root.action.kind === "RETURN_AND_FIRE";
  if (![V.projection, V.projectionWithUserContext, V.projectionWithReturnAndFire, V.projectionWithObservationSemantics].includes(root.projectionVersion as typeof V.projection) || root.questionVersion !== (semanticProjection ? V.questionsWithWitnesses : returnAndFire ? V.questionsReturnAndFire : V.questions) || root.scenario !== (returnAndFire ? "RETURN_AND_FIRE_AFTER_ADVANTAGE" : "RECONTACT_AFTER_ADVANTAGE") || root.map !== "de_mirage") return fail();
  const state = keys(root.state, ["allies", "enemies", "advantage", "checks", "observations"]);
  const allies = integer(state.allies, 1, 5), enemies = integer(state.enemies, 1, 5), advantage = integer(state.advantage, 1, 4);
  if (allies - enemies !== advantage) return fail();
  const checks = arr(state.checks, 3).map(v => {
    const c = keys(v, ["code", "value", "refs"]);
    if (!CHECKS.includes(c.code as DecisionAssessmentCheckCode) || !["YES", "NO", "UNKNOWN"].includes(c.value as string)) return fail();
    const rs = refs(c.refs);
    if ((c.value === "UNKNOWN") !== (rs.length === 0)) return fail();
    return { code: c.code as DecisionAssessmentCheckCode, value: c.value as "YES" | "NO" | "UNKNOWN", refs: rs };
  });
  if (checks.length !== 3 || new Set(checks.map(c => c.code)).size !== 3) return fail();
  const kinds = ["PLAYER_POSITION", "PLAYER_PRESENCE", "SOUND_SOURCE", "DAMAGE_DIRECTION", "UTILITY_STATE", "BOMB_STATE", "LAST_KNOWN_POSITION", "TEAM_REPORT", "USER_CONTEXT"];
  const observations = arr(state.observations, 24).map(v => {
    const o = keys(v, ["alias", "kind", "source", "confidence", "ageSeconds", "shared", ...(record(v) && v.reportedContext !== undefined ? ["reportedContext"] : []), ...(semanticProjection ? ["semantic"] : [])]);
    if (o.reportedContext !== undefined && (o.source !== "USER_PROVIDED" || root.projectionVersion !== V.projectionWithUserContext && !returnAndFire && !semanticProjection)) return fail();
    if (!kinds.includes(o.kind as string) || !["DEMO_OBSERVER", "USER_PROVIDED"].includes(o.source as string) || typeof o.shared !== "boolean" || o.source === "USER_PROVIDED" && (o.kind !== "USER_CONTEXT" || o.shared)) return fail();
    const semantic = semanticProjection ? parseDecisionObservationSemantics(o.semantic) : undefined;
    if (semantic && ((semantic.modality === "USER_CONTEXT") !== (o.source === "USER_PROVIDED") || (semantic.sharingScope === "VERIFIED_TEAM_SHARED") !== o.shared || semantic.availableAgeSeconds > number(o.ageSeconds, 0, 10))) return fail();
    return { alias: alias(o.alias), kind: o.kind as DecisionAssessmentPacket["state"]["observations"][number]["kind"], source: o.source as "DEMO_OBSERVER" | "USER_PROVIDED", confidence: number(o.confidence, 0, 1), ageSeconds: number(o.ageSeconds, 0, 10), shared: o.shared, ...(o.reportedContext !== undefined ? { reportedContext: parseUserTacticalContext(o.reportedContext) } : {}), ...(semantic ? { semantic } : {}) };
  });
  const a = keys(root.action, returnAndFire ? ["kind", "durationSeconds", "sincePriorShotSeconds", "contactStatus", "refs"] : ["kind", "durationSeconds", "sincePriorContactSeconds", "refs"]);
  let action: DecisionAssessmentPacket["action"];
  if (returnAndFire) {
    if (a.kind !== "RETURN_AND_FIRE" || a.contactStatus !== "UNVERIFIED") return fail();
    action = { kind: "RETURN_AND_FIRE", durationSeconds: number(a.durationSeconds, 0, 2), sincePriorShotSeconds: number(a.sincePriorShotSeconds, 0, 10), contactStatus: "UNVERIFIED", refs: refs(a.refs) };
    if (action.sincePriorShotSeconds <= 0) return fail();
  } else {
    if (a.kind !== "RECONTACT" && a.kind !== "REPEEK") return fail();
    action = { kind: a.kind, durationSeconds: number(a.durationSeconds, 0, 2), sincePriorContactSeconds: number(a.sincePriorContactSeconds, 0, 11), refs: refs(a.refs) };
  }
  if (action.refs.length !== 1) return fail();
  const evidence = arr(root.evidence, 32).map(v => {
    const e = keys(v, ["alias", "role", "confidence"]);
    if (!["PUBLIC_COUNTS", "ACTION", "OBSERVATION", ...CHECKS].includes(e.role as string)) return fail();
    return { alias: alias(e.alias), role: e.role as DecisionAssessmentPacket["evidence"][number]["role"], confidence: number(e.confidence, 0, 1) };
  });
  const byAlias = new Map(evidence.map(e => [e.alias, e]));
  if (byAlias.size !== evidence.length || evidence.filter(e => e.role === "PUBLIC_COUNTS").length !== 1 || evidence.filter(e => e.role === "ACTION").length !== 1 || byAlias.get(action.refs[0]!)?.role !== "ACTION") return fail();
  for (const c of checks) if (c.refs.some(r => byAlias.get(r)?.role !== c.code)) return fail();
  for (const o of observations) if (byAlias.get(o.alias)?.role !== "OBSERVATION" || byAlias.get(o.alias)?.confidence !== o.confidence) return fail();
  if (new Set(observations.map(o => o.alias)).size !== observations.length) return fail();
  const used = new Set([...action.refs, ...checks.flatMap(c => c.refs), ...observations.map(o => o.alias)]);
  if (evidence.some(e => e.role !== "PUBLIC_COUNTS" && !used.has(e.alias))) return fail();
  return { projectionVersion: root.projectionVersion as DecisionAssessmentPacket["projectionVersion"], questionVersion: root.questionVersion as DecisionAssessmentPacket["questionVersion"], scenario: root.scenario as DecisionAssessmentPacket["scenario"], map: "de_mirage", state: { allies, enemies, advantage, checks, observations }, action, evidence };
}

export interface DecisionAssessmentBuildResult {
  packet?: DecisionAssessmentPacket;
  binding?: DecisionAssessmentBinding;
  rejectionReasons: string[];
}

/** Reconstruct the entire outgoing whitelist. Never spread trusted-domain objects into the request. */
export function buildDecisionAssessmentPacket(
  candidate: TeachingCandidate, material: CandidateMaterial,
  options: { mapName: string; tickRate: number; playerId: string; projectionVersion?: DecisionAssessmentPacket["projectionVersion"] | "LEGACY" }
): DecisionAssessmentBuildResult {
  const rejectionReasons: string[] = [];
  const reject = (reason: string): DecisionAssessmentBuildResult => ({ rejectionReasons: unique([...rejectionReasons, reason]) });
  if (options.mapName !== "de_mirage") return reject("UNSUPPORTED_MAP");
  if (!finite(options.tickRate) || options.tickRate <= 0 || options.tickRate > 1024) return reject("INVALID_TICK_RATE");
  if (candidate.candidateId !== material.candidateId) return reject("CROSS_CANDIDATE_MATERIAL");
  const snapshot = material.decisionSnapshot ?? candidate.decisionSnapshot;
  const context = material.observableContext ?? candidate.observableContext;
  if (!snapshot || !context) return reject("MISSING_OBSERVABLE_CONTEXT");
  if (snapshot.version !== "decision-snapshot.v1" || context.version !== "observable-decision-context.v1" || context.source !== "DEMO_OBSERVER_EVIDENCE") return reject("VERSION_MISMATCH");
  const t = candidate.decisionTick;
  if (!finite(t) || snapshot.decisionTick !== t || snapshot.sampledAtTick !== t || snapshot.selectedPlayerId !== options.playerId || snapshot.roundNumber !== candidate.roundNumber || context.snapshotId !== snapshot.snapshotId || context.boundary !== "OBSERVABLE" || context.state.observer_player_id !== options.playerId || context.state.at_tick !== t || context.freshness.sampledAtTick !== t || context.freshness.ageTicks !== 0) return reject("STALE_OR_WRONG_OBSERVER");
  const allowedFacts = new Set(material.decisionFacts.filter(f => candidate.factRefs.includes(f.id) && f.observed_by_player && f.availability === "DECISION" && finite(f.available_at_tick) && f.available_at_tick <= t).map(f => f.id));
  const claims = context.state.claims.filter(c => candidate.observableClaimRefs.includes(c.id));
  const boundClaimIds = new Set(claims.map(c => c.id));
  if (boundClaimIds.size !== claims.length || candidate.observableClaimRefs.some(ref => !boundClaimIds.has(ref))) return reject("MISSING_OR_DUPLICATE_OBSERVATION_CLAIM");
  for (const claim of claims) {
    if (claim.user_tactical_context !== undefined) {
      try { parseUserTacticalContext(claim.user_tactical_context); } catch { return reject("INVALID_USER_TACTICAL_CONTEXT"); }
      if (claim.source_type !== "USER_CONTEXT" || claim.knowledge_kind !== "USER_ASSERTED" || claim.sharing_scope !== "USER_CONTEXT_ONLY") return reject("USER_CONTEXT_PROVENANCE");
    }
    if (!finite(claim.evidence_tick) || !finite(claim.available_from_tick) || claim.evidence_tick > t || claim.available_from_tick > t || claim.available_from_tick < claim.evidence_tick || (claim.expires_at_tick !== undefined && (!finite(claim.expires_at_tick) || claim.expires_at_tick <= t)) || t - claim.evidence_tick > 10 * options.tickRate) return reject("STALE_OBSERVATION");
    if (!probability(claim.confidence)) return reject("INVALID_EVIDENCE_CONFIDENCE");
    if (!(claim.sharing_scope === "SELF" || claim.sharing_scope === "VERIFIED_TEAM_SHARED" || claim.sharing_scope === "USER_CONTEXT_ONLY" && claim.source_type === "USER_CONTEXT" && claim.knowledge_kind === "USER_ASSERTED")) return reject("UNVERIFIED_TEAM_KNOWLEDGE");
    if (claim.source_type === "TEAM_SHARED" && claim.sharing_scope !== "VERIFIED_TEAM_SHARED") return reject("UNVERIFIED_TEAM_KNOWLEDGE");
    if (claim.source_type === "USER_CONTEXT" && (claim.sharing_scope !== "USER_CONTEXT_ONLY" || claim.knowledge_kind !== "USER_ASSERTED")) return reject("USER_CONTEXT_PROVENANCE");
  }
  const claimRefs = new Set(claims.map(c => c.id));
  const allowed = new Set([...allowedFacts, ...claimRefs]);
  const legalRefs = (refs: readonly string[]) => refs.length > 0 && refs.every(r => allowed.has(r));
  if (snapshot.selectedPlayer.boundary !== "OBSERVABLE" || snapshot.selectedPlayer.value?.alive !== true || !legalRefs(snapshot.selectedPlayer.evidenceRefs)) return reject("MISSING_LIVE_PLAYER_CONTEXT");
  const counts = snapshot.aliveCounts;
  if (counts.boundary !== "OBSERVABLE" || !counts.value || !legalRefs(counts.evidenceRefs) || !counts.evidenceRefs.every(r => allowedFacts.has(r)) || !Number.isInteger(counts.value.allies) || !Number.isInteger(counts.value.enemies) || counts.value.allies < 1 || counts.value.allies > 5 || counts.value.enemies < 0 || counts.value.enemies > 5 || !counts.value.includesSelectedPlayer) return reject("MISSING_PUBLIC_COUNTS");
  if (counts.value.enemies === 0 || counts.value.allies <= counts.value.enemies) return reject("UNSUPPORTED_SCENARIO");
  const actions = material.playerActionFacts.filter(f => !f.presentationOnly && candidate.actionRefs.includes(f.id) && f.actorPlayerId === options.playerId && f.decisionAction);
  if (actions.length !== 1) return reject("MISSING_OR_AMBIGUOUS_STRUCTURED_ACTION");
  const action = actions[0]!, detail = action.decisionAction!;
  const returnAndFire = detail.kind === "RETURN_AND_FIRE";
  const priorTick = returnAndFire ? detail.priorShotTick : detail.priorContactTick;
  const expectedKeys = ["version", "kind", "startTick", "endTick", returnAndFire ? "priorShotTick" : "priorContactTick", "source"];
  if (Object.keys(detail).length !== expectedKeys.length || Object.keys(detail).some(k => !expectedKeys.includes(k)) || detail.version !== "decision-action.v1" || !(returnAndFire ? detail.source === "SELF_MOVEMENT_FIRE_V1" : ["RECONTACT", "REPEEK"].includes(detail.kind) && ["REPLAY_GEOMETRY_V1", "SYNTHETIC_REGRESSION"].includes(detail.source)) || ![detail.startTick, detail.endTick, priorTick, action.availableAtTick].every(finite) || detail.startTick < t || detail.startTick > t + options.tickRate || detail.endTick < detail.startTick || detail.endTick > t + 2 * options.tickRate || priorTick > t || priorTick >= detail.startTick || priorTick < t - 10 * options.tickRate || returnAndFire && detail.startTick - priorTick > 10 * options.tickRate || action.availableAtTick < detail.endTick || action.availableAtTick > t + 2 * options.tickRate || action.source !== "DEMO") return reject("INVALID_ACTION_WINDOW");
  const aliases: Record<string, readonly string[]> = {};
  const evidence: DecisionAssessmentPacket["evidence"][number][] = [];
  const add = (role: DecisionAssessmentPacket["evidence"][number]["role"], refs: readonly string[], confidence = 1) => {
    const alias = `e${evidence.length + 1}`; aliases[alias] = unique(refs); evidence.push({ alias, role, confidence }); return alias;
  };
  add("PUBLIC_COUNTS", counts.evidenceRefs);
  const actionAlias = add("ACTION", [action.id]);
  const checks = [...snapshot.supportChecks, ...snapshot.pressureChecks, ...snapshot.spatialChecks];
  const projectedChecks = CHECKS.map(code => {
    const matches = checks.filter(c => c.code === code && c.boundary === "OBSERVABLE" && legalRefs(c.evidenceRefs) && c.missingFields.length === 0);
    const yes = matches.filter(c => c.status === "APPLICABLE"), no = matches.filter(c => c.status === "INAPPLICABLE");
    if (yes.length && no.length) rejectionReasons.push("CONTRADICTORY_CONTEXT");
    const match = yes[0] ?? no[0];
    // A hidden world-state veto can refuse an option, but cannot create player knowledge.
    const veto = checks.some(c => c.code === code && c.boundary !== "OUTCOME" && c.boundary !== "OBSERVABLE" && c.status === "INAPPLICABLE");
    if (!match || veto) return { code, value: "UNKNOWN" as const, refs: [] };
    const confidences = match.evidenceRefs.map(r => claims.find(c => c.id === r)?.confidence ?? 1);
    const confidence = Math.min(...confidences);
    if (confidence < 0.8 || match.evidenceRefs.some(r => claims.find(c => c.id === r)?.source_type === "USER_CONTEXT")) return { code, value: "UNKNOWN" as const, refs: [] };
    return { code, value: match.status === "APPLICABLE" ? "YES" as const : "NO" as const, refs: [add(code, match.evidenceRefs, confidence)] };
  });
  if (rejectionReasons.length) return { rejectionReasons: unique(rejectionReasons) };
  const legacyVersion = returnAndFire ? V.projectionWithReturnAndFire : claims.some(c => c.user_tactical_context) ? V.projectionWithUserContext : V.projection;
  const projectionVersion = options.projectionVersion === "LEGACY" ? legacyVersion : options.projectionVersion ?? V.projectionWithObservationSemantics;
  const semanticProjection = projectionVersion === V.projectionWithObservationSemantics;
  let semantics: ReturnType<typeof buildDecisionObservationSemantics> = [];
  if (semanticProjection) {
    try { semantics = buildDecisionObservationSemantics(claims, { playerId: options.playerId, decisionTick: t, tickRate: options.tickRate }); }
    catch { return reject("INVALID_OBSERVATION_SEMANTICS"); }
  }
  const observations = claims.map((c, index) => ({ alias: add("OBSERVATION", [c.id], c.confidence), kind: c.claim_type,
    source: c.source_type === "USER_CONTEXT" ? "USER_PROVIDED" as const : "DEMO_OBSERVER" as const,
    confidence: c.confidence, ageSeconds: (t - c.evidence_tick) / options.tickRate, shared: c.sharing_scope === "VERIFIED_TEAM_SHARED", ...(c.user_tactical_context ? { reportedContext: parseUserTacticalContext(c.user_tactical_context) } : {}), ...(semanticProjection ? { semantic: semantics[index]! } : {}) }));
  const packet: DecisionAssessmentPacket = {
    projectionVersion, questionVersion: semanticProjection ? V.questionsWithWitnesses : returnAndFire ? V.questionsReturnAndFire : V.questions, scenario: returnAndFire ? "RETURN_AND_FIRE_AFTER_ADVANTAGE" : "RECONTACT_AFTER_ADVANTAGE", map: "de_mirage",
    state: { allies: counts.value.allies, enemies: counts.value.enemies, advantage: counts.value.allies - counts.value.enemies, checks: projectedChecks, observations },
    action: returnAndFire ? { kind: "RETURN_AND_FIRE", durationSeconds: (detail.endTick - detail.startTick) / options.tickRate, sincePriorShotSeconds: (detail.startTick - priorTick) / options.tickRate, contactStatus: "UNVERIFIED", refs: [actionAlias] } : { kind: detail.kind, durationSeconds: (detail.endTick - detail.startTick) / options.tickRate, sincePriorContactSeconds: (detail.startTick - priorTick) / options.tickRate, refs: [actionAlias] }, evidence
  };
  try { parseDecisionAssessmentPacket(packet); } catch { return reject("INVALID_PROJECTION"); }
  return { packet, binding: { ...(semanticProjection ? { projectionVersion } : {}), candidateId: candidate.candidateId, playerId: options.playerId, mapName: options.mapName, tickRate: options.tickRate, packetFingerprint: decisionAssessmentFingerprint(packet), aliases, inputProvenance: detail.source }, rejectionReasons: [] };
}

const choices = {
  riskWarranted: ["WARRANTED", "UNWARRANTED", "UNKNOWN"],
  alternativePreferable: ["PREFERABLE", "NOT_ESTABLISHED", "UNKNOWN"],
  contextSufficient: ["SUFFICIENT", "INSUFFICIENT"]
} as const;

/** These conservative tactical principles are hypotheses pending coach validation, never gold labels. */
export function validateDecisionAssessmentResult(packet: DecisionAssessmentPacket, value: unknown, options: { allowedModel?: string } = {}): { valid: boolean; rejectionReasons: string[]; modelConfidence: number | null; evidenceConfidence: number } {
  const reasons: string[] = [];
  try { parseDecisionAssessmentPacket(packet); } catch { return { valid: false, rejectionReasons: ["INVALID_PACKET"], modelConfidence: null, evidenceConfidence: 0 }; }
  if (!record(value)) return { valid: false, rejectionReasons: ["INVALID_SCHEMA"], modelConfidence: null, evidenceConfidence: 0 };
  if (typeof value.model !== "string" || ![V.model, "RULE_BASELINE", ...(options.allowedModel ? [options.allowedModel] : [])].includes(value.model)) reasons.push("UNKNOWN_MODEL_VERSION");
  if (value.questionVersion !== packet.questionVersion) reasons.push("VERSION_MISMATCH");
  if (packet.action.kind === "RETURN_AND_FIRE" && (!record(value.riskWarranted) || value.riskWarranted.choice !== "UNKNOWN" || !record(value.alternativePreferable) || value.alternativePreferable.choice !== "UNKNOWN" || !record(value.contextSufficient) || value.contextSufficient.choice !== "INSUFFICIENT")) reasons.push("CONTACT_UNVERIFIED");
  const topKeys = ["model", "questionVersion", "riskWarranted", "alternativePreferable", "contextSufficient", "limitationCodes", ...(packet.questionVersion === V.questionsWithWitnesses ? ["witnesses"] : [])];
  if (Object.keys(value).length !== topKeys.length || Object.keys(value).some(k => !topKeys.includes(k))) reasons.push("INVALID_SCHEMA");
  if (packet.questionVersion === V.questionsWithWitnesses) reasons.push(...validateDecisionWitnesses(packet, value as unknown as DecisionAssessmentResult));
  const evidence = new Map(packet.evidence.map(e => [e.alias, e]));
  const selectedConfidence: number[] = [], citedConfidence: number[] = [];
  for (const key of Object.keys(choices) as (keyof typeof choices)[]) {
    const atom = value[key];
    if (!record(atom) || Object.keys(atom).some(k => !["choice", "confidence", "probabilities", "refs"].includes(k)) || !choices[key].some(c => c === atom.choice) || !probability(atom.confidence) || !record(atom.probabilities) || !Array.isArray(atom.refs) || atom.refs.some(r => typeof r !== "string")) { reasons.push("INVALID_SCHEMA"); continue; }
    const distribution = atom.probabilities;
    if (Object.keys(distribution).length !== choices[key].length || choices[key].some(c => !probability(distribution[c])) || Math.abs(Object.values(distribution).reduce<number>((sum, p) => sum + (finite(p) ? p : 0), 0) - 1) > 0.0001 || Object.values(distribution).some(p => finite(p) && p > (distribution[String(atom.choice)] as number))) reasons.push("INVALID_PROBABILITIES");
    selectedConfidence.push(atom.confidence);
    const refs = atom.refs as string[];
    if (new Set(refs).size !== refs.length || refs.some(r => !evidence.has(r))) reasons.push("ILLEGAL_EVIDENCE_ALIAS");
    const roles = refs.map(r => evidence.get(r)?.role);
    citedConfidence.push(...refs.map(r => evidence.get(r)?.confidence ?? 0));
    const uncertain = atom.choice === "UNKNOWN" || atom.choice === "INSUFFICIENT" || atom.choice === "NOT_ESTABLISHED";
    if (!uncertain && (!refs.length || roles.includes("OBSERVATION"))) reasons.push("UNSUPPORTED_CITATION");
    if (key === "riskWarranted" && !uncertain && (!roles.includes("ACTION") || !roles.includes("PUBLIC_COUNTS") || !roles.some(r => CHECKS.includes(r as DecisionAssessmentCheckCode)))) reasons.push("UNSUPPORTED_CITATION");
    if (key === "riskWarranted" && atom.choice === "UNWARRANTED" && CHECKS.some(c => !roles.includes(c))) reasons.push("UNSUPPORTED_CITATION");
    if (key === "riskWarranted" && atom.choice === "WARRANTED" && !packet.state.checks.some(c => roles.includes(c.code) && (c.code === "tradeWindow" && c.value === "YES" || c.code === "objectiveAllowsDelay" && c.value === "NO"))) reasons.push("UNSUPPORTED_CITATION");
    if (key === "alternativePreferable" && atom.choice === "PREFERABLE" && (!roles.includes("objectiveAllowsDelay") || !(roles.includes("safeReachableCover") || roles.includes("tradeWindow")))) reasons.push("UNSUPPORTED_CITATION");
    if (key === "contextSufficient" && atom.choice === "SUFFICIENT" && CHECKS.some(c => !roles.includes(c))) reasons.push("UNSUPPORTED_CITATION");
    if (key === "alternativePreferable" && roles.some(r => r === "ACTION" || r === "PUBLIC_COUNTS")) reasons.push("IRRELEVANT_CITATION");
    if (key === "contextSufficient" && roles.some(r => r === "ACTION" || r === "PUBLIC_COUNTS")) reasons.push("IRRELEVANT_CITATION");
  }
  const codes = ["MISSING_CONTEXT", "USER_CONTEXT_UNVERIFIED", "MULTIPLE_REASONABLE_ACTIONS", "PRINCIPLE_UNVALIDATED"];
  if (!Array.isArray(value.limitationCodes) || value.limitationCodes.some(c => !codes.includes(c))) reasons.push("INVALID_LIMITATION_CODE");
  if (record(value.contextSufficient) && value.contextSufficient.choice === "SUFFICIENT"
    && packet.state.observations.some(o => o.reportedContext?.enemyCount !== null && o.reportedContext?.enemyCount !== undefined && o.reportedContext.enemyCount > packet.state.enemies)) reasons.push("CONTRADICTORY_USER_CONTEXT");
  const checks = new Map(packet.state.checks.map(c => [c.code, c.value]));
  if (record(value.contextSufficient) && value.contextSufficient.choice === "SUFFICIENT" && CHECKS.some(c => checks.get(c) === "UNKNOWN")) reasons.push("INSUFFICIENT_CONTEXT");
  if (record(value.alternativePreferable) && value.alternativePreferable.choice === "PREFERABLE" && !(checks.get("objectiveAllowsDelay") === "YES" && (checks.get("safeReachableCover") === "YES" || checks.get("tradeWindow") === "YES"))) reasons.push("INAPPLICABLE_ALTERNATIVE");
  if (record(value.riskWarranted) && value.riskWarranted.choice === "UNWARRANTED" && !(checks.get("objectiveAllowsDelay") === "YES" && checks.get("safeReachableCover") === "YES" && checks.get("tradeWindow") === "NO")) reasons.push("UNSUPPORTED_RISK_JUDGMENT");
  if (record(value.riskWarranted) && value.riskWarranted.choice === "WARRANTED" && !(checks.get("tradeWindow") === "YES" || checks.get("objectiveAllowsDelay") === "NO")) reasons.push("UNSUPPORTED_RISK_JUDGMENT");
  const witnessConfidences = packet.questionVersion === V.questionsWithWitnesses && record(value.witnesses)
    ? Object.values(value.witnesses).map(w => record(w) && probability(w.confidence) ? w.confidence : 0) : [];
  return { valid: reasons.length === 0, rejectionReasons: unique(reasons), modelConfidence: selectedConfidence.length === 3 ? Math.min(...selectedConfidence, ...witnessConfidences) : null, evidenceConfidence: packet.action.kind === "RETURN_AND_FIRE" ? 0 : citedConfidence.length ? Math.min(...citedConfidence) : 0 };
}

function atom<C extends string>(all: readonly C[], choice: C, refs: readonly string[]): DecisionAssessmentAtom<C> {
  return { choice, confidence: 1, probabilities: Object.fromEntries(all.map(c => [c, c === choice ? 1 : 0])) as Record<C, number>, refs };
}
/** Proxy rule baseline, deliberately restricted. Its probability is deterministic output, not measured correctness. */
function legacyRuleDecisionAssessment(packet: DecisionAssessmentPacket): DecisionAssessmentResult {
  if (packet.action.kind === "RETURN_AND_FIRE") return {
    model: "RULE_BASELINE", questionVersion: packet.questionVersion,
    riskWarranted: atom(choices.riskWarranted, "UNKNOWN", []),
    alternativePreferable: atom(choices.alternativePreferable, "UNKNOWN", []),
    contextSufficient: atom(choices.contextSufficient, "INSUFFICIENT", []),
    limitationCodes: ["MISSING_CONTEXT", "PRINCIPLE_UNVALIDATED"]
  };
  const check = (code: DecisionAssessmentCheckCode) => packet.state.checks.find(c => c.code === code);
  const sufficient = CHECKS.every(c => check(c)?.value !== "UNKNOWN");
  const risk = !sufficient ? "UNKNOWN" : check("tradeWindow")?.value === "YES" || check("objectiveAllowsDelay")?.value === "NO" ? "WARRANTED" : check("safeReachableCover")?.value === "YES" ? "UNWARRANTED" : "UNKNOWN";
  const preferable = risk === "UNWARRANTED" && sufficient && check("objectiveAllowsDelay")?.value === "YES" && (check("safeReachableCover")?.value === "YES" || check("tradeWindow")?.value === "YES");
  const checkRefs = (codes: readonly DecisionAssessmentCheckCode[]) => codes.flatMap(c => check(c)?.refs ?? []);
  return { model: "RULE_BASELINE", questionVersion: V.questions,
    riskWarranted: atom(choices.riskWarranted, risk, risk === "UNKNOWN" ? [] : [...packet.evidence.filter(e => e.role === "PUBLIC_COUNTS" || e.role === "ACTION").map(e => e.alias), ...checkRefs(risk === "UNWARRANTED" ? CHECKS : [check("tradeWindow")?.value === "YES" ? "tradeWindow" : "objectiveAllowsDelay"])]),
    alternativePreferable: atom(choices.alternativePreferable, preferable ? "PREFERABLE" : "NOT_ESTABLISHED", preferable ? checkRefs(["objectiveAllowsDelay", check("safeReachableCover")?.value === "YES" ? "safeReachableCover" : "tradeWindow"]) : []),
    contextSufficient: atom(choices.contextSufficient, sufficient ? "SUFFICIENT" : "INSUFFICIENT", sufficient ? checkRefs(CHECKS) : []),
    limitationCodes: sufficient ? ["PRINCIPLE_UNVALIDATED", "MULTIPLE_REASONABLE_ACTIONS"] : ["PRINCIPLE_UNVALIDATED", "MISSING_CONTEXT"] };
}

/** This deterministic comparator is never supplied to either remote model as an answer. */
export function ruleDecisionAssessment(packet: DecisionAssessmentPacket): DecisionAssessmentResult {
  const result = legacyRuleDecisionAssessment(packet);
  if (packet.questionVersion !== V.questionsWithWitnesses) return result;
  result.questionVersion = packet.questionVersion;
  const catalog = buildDecisionWitnessCatalog(packet);
  const names = ["riskWarranted", "alternativePreferable", "contextSufficient"] as const;
  const witnesses = {} as NonNullable<DecisionAssessmentResult["witnesses"]>;
  for (const name of names) {
    const entries = Object.entries(catalog[name]);
    const found = entries.find(([, option]) => option.applicable && option.choice === result[name].choice);
    const fallbackKey = name === "contextSufficient" ? packet.action.kind === "RETURN_AND_FIRE" ? "UNVERIFIED_CONTACT" : "UNRESOLVED_CONTEXT" : "NONE";
    const [selected, option] = found ?? [fallbackKey, catalog[name][fallbackKey]!];
    // Only the proxy rule may derive its answer this way; live answers are never repaired.
    Object.assign(result[name], atom(choices[name], option.choice, option.refs));
    witnesses[name] = { choice: selected, confidence: 1, probabilities: Object.fromEntries(entries.map(([key]) => [key, key === selected ? 1 : 0])) };
  }
  if (result.contextSufficient.choice === "SUFFICIENT" && (result.riskWarranted.choice === "UNKNOWN" || result.alternativePreferable.choice === "UNKNOWN")) {
    result.contextSufficient = atom(choices.contextSufficient, "INSUFFICIENT", []);
    witnesses.contextSufficient = { choice: "UNRESOLVED_CONTEXT", confidence: 1, probabilities: Object.fromEntries(Object.keys(catalog.contextSufficient).map(key => [key, key === "UNRESOLVED_CONTEXT" ? 1 : 0])) };
  }
  // Missing context on the position/fire branch has an explicit, non-tactical reason.
  if (packet.action.kind === "RETURN_AND_FIRE") witnesses.contextSufficient = { choice: "UNVERIFIED_CONTACT", confidence: 1, probabilities: Object.fromEntries(Object.keys(catalog.contextSufficient).map(key => [key, key === "UNVERIFIED_CONTACT" ? 1 : 0])) };
  return { ...result, witnesses };
}

/** No model call and no mutation: safe during repeated consumption and legacy history reads. */
export function resolveDecisionAssessment(candidate: TeachingCandidate, material: CandidateMaterial): TeachingAssessment | undefined {
  const artifact = material.decisionAssessment ?? candidate.decisionAssessment;
  if (!artifact || !record(artifact.binding) || !record(artifact.result) || artifact.version !== V.artifact || artifact.mode !== "JEV_EXPERIMENT" || artifact.provider !== "JEV" || artifact.status !== "ACCEPTED" || artifact.acceptance !== "TEST_ONLY" || artifact.acceptancePolicyVersion !== V.acceptance || !artifact.result || artifact.result.model !== V.model || artifact.binding.candidateId !== candidate.candidateId) return undefined;
  const built = buildDecisionAssessmentPacket(candidate, material, { ...artifact.binding, projectionVersion: artifact.binding.projectionVersion ?? "LEGACY" });
  if (!built.packet || !built.binding || built.binding.packetFingerprint !== artifact.binding.packetFingerprint || JSON.stringify(built.binding.aliases) !== JSON.stringify(artifact.binding.aliases) || built.binding.inputProvenance !== artifact.binding.inputProvenance) return undefined;
  const validation = validateDecisionAssessmentResult(built.packet, artifact.result);
  if (!validation.valid || artifact.evidenceConfidence !== validation.evidenceConfidence || artifact.modelConfidence !== validation.modelConfidence) return undefined;
  const result = artifact.result;
  const insufficient = result.contextSufficient.choice !== "SUFFICIENT" || result.riskWarranted.choice === "UNKNOWN";
  if (!insufficient && validation.evidenceConfidence < 0.8) return undefined;
  const kind = insufficient ? "INSUFFICIENT_EVIDENCE" : result.riskWarranted.choice === "UNWARRANTED" && result.alternativePreferable.choice === "PREFERABLE" ? "DECISION_ERROR" : result.riskWarranted.choice === "WARRANTED" ? "POSITIVE_PROCESS" : "INSUFFICIENT_EVIDENCE";
  const refs = unique([...result.riskWarranted.refs, ...result.alternativePreferable.refs, ...result.contextSufficient.refs].flatMap(ref => built.binding!.aliases[ref] ?? []));
  return { kind, confidence: Math.min(validation.modelConfidence ?? 0, validation.evidenceConfidence), supportingEvidenceRefs: refs, counterEvidenceRefs: [], missingFields: insufficient ? ["decision_context"] : [], limitations: ["JEV_EXPERIMENT_TEST_ONLY", "TACTICAL_PRINCIPLES_NOT_COACH_VALIDATED", ...result.limitationCodes], explanation: kind === "DECISION_ERROR" ? "实验判断：人数优势下，已确认可安全回到掩体且允许等待，当前再次接触缺少已确认的补枪目的。" : kind === "POSITIVE_PROCESS" ? "实验判断：当时可知的补枪或目标时机支持主动接触，结果好坏不改变此判断。" : built.packet.action.kind === "RETURN_AND_FIRE" ? "记录只能确认位置返回后开枪，不能确认再次接敌、敌人暴露或视野，现有信息不足以判断战术合理性。" : "现有信息不足以判断这次再次接触是否合理。", hasEvaluableDecision: !insufficient };
}
