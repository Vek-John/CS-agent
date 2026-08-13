import type { CoachCue, MatchTimeline, ReviewPlan } from "@cs-coach/contracts";

export class ReviewPlanValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`ReviewPlan validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ReviewPlanValidationError";
    this.issues = issues;
  }
}

function validateCue(cue: CoachCue, plan: ReviewPlan, issues: string[]): void {
  const segment = plan.segments.find((candidate) => candidate.id === cue.segment_id);
  if (!segment) {
    issues.push(`Cue ${cue.id} references missing segment ${cue.segment_id}.`);
    return;
  }

  if (!segment.cue_ids.includes(cue.id)) {
    issues.push(`Segment ${segment.id} does not reference its cue ${cue.id}.`);
  }

  if (cue.decision_tick < segment.start_tick || cue.decision_tick >= segment.end_tick) {
    issues.push(`Cue ${cue.id} decision_tick is outside segment ${segment.id}.`);
  }
  if (cue.outcome_start_tick < cue.decision_tick) {
    issues.push(`Cue ${cue.id} outcome playback starts before the decision tick.`);
  }
  if (cue.reveal_tick <= cue.decision_tick) {
    issues.push(`Cue ${cue.id} must reveal strictly after its decision tick.`);
  }
  if (cue.reveal_tick > cue.outcome_end_tick) {
    issues.push(`Cue ${cue.id} reveals after its outcome range ends.`);
  }
  if (
    cue.outcome_end_tick <= cue.outcome_start_tick ||
    cue.outcome_end_tick > segment.end_tick ||
    cue.outcome_start_tick >= cue.reveal_tick
  ) {
    issues.push(`Cue ${cue.id} has an invalid outcome range.`);
  }

  if (cue.observable_state_id !== undefined && !cue.observable_state_id.trim()) {
    issues.push(`Cue ${cue.id} has an empty observable_state_id.`);
  }

  const factById = new Map(cue.facts.map((fact) => [fact.id, fact]));
  if (factById.size !== cue.facts.length) {
    issues.push(`Cue ${cue.id} contains duplicate fact IDs.`);
  }

  for (const factRef of cue.observable_fact_refs) {
    const fact = factById.get(factRef);
    if (!fact) {
      issues.push(`Cue ${cue.id} observable fact ${factRef} is missing.`);
      continue;
    }
    if (
      fact.availability !== "DECISION" ||
      fact.available_at_tick > cue.decision_tick ||
      !fact.observed_by_player
    ) {
      issues.push(`Cue ${cue.id} exposes future or unobserved fact ${factRef} before reveal.`);
    }
  }

  const observableRefs = new Set(cue.observable_fact_refs);
  for (const inference of cue.inferences) {
    if (inference.confidence < 0 || inference.confidence > 1) {
      issues.push(`Inference ${inference.id} confidence is outside [0, 1].`);
    }
    for (const factRef of inference.fact_refs) {
      if (!observableRefs.has(factRef)) {
        issues.push(`Inference ${inference.id} uses non-observable fact ${factRef}.`);
      }
    }
  }

  for (const advice of cue.advice) {
    for (const factRef of advice.fact_refs) {
      if (!observableRefs.has(factRef)) {
        issues.push(`Advice ${advice.id} uses non-observable fact ${factRef}.`);
      }
    }
  }
}

function isInterRoundGapSegment(
  segment: ReviewPlan["segments"][number],
  timeline: MatchTimeline
): boolean {
  if (segment.round_number !== 0) return false;
  return timeline.rounds.some((round, index) => {
    const previous = timeline.rounds[index - 1];
    const gapStart = previous?.end_tick ?? timeline.start_tick;
    const gapEnd = round.start_tick;
    return (
      gapEnd > gapStart &&
      segment.start_tick >= gapStart &&
      segment.end_tick <= gapEnd
    );
  });
}

export function collectReviewPlanIssues(timeline: MatchTimeline, plan: ReviewPlan): string[] {
  const issues: string[] = [];

  if (plan.demo_id !== timeline.demo_id) {
    issues.push(`Plan demo ${plan.demo_id} does not match timeline demo ${timeline.demo_id}.`);
  }
  if (plan.player_id !== timeline.selected_player_id) {
    issues.push(`Plan player ${plan.player_id} does not match selected player.`);
  }
  if (plan.match_timeline_version !== timeline.timeline_version) {
    issues.push("Plan and timeline versions do not match.");
  }
  if (plan.segments.length === 0) {
    issues.push("Plan has no segments.");
    return issues;
  }

  const sorted = [...plan.segments].sort((a, b) => a.start_tick - b.start_tick);
  if (sorted[0].start_tick !== timeline.start_tick) {
    issues.push(`Coverage starts at ${sorted[0].start_tick}, expected ${timeline.start_tick}.`);
  }
  if (sorted[sorted.length - 1].end_tick !== timeline.end_tick) {
    issues.push(
      `Coverage ends at ${sorted[sorted.length - 1].end_tick}, expected ${timeline.end_tick}.`
    );
  }

  const roundNumbers = new Set<number>();
  const segmentIds = new Set<string>();
  for (let index = 0; index < sorted.length; index += 1) {
    const segment = sorted[index];
    if (segmentIds.has(segment.id)) {
      issues.push(`Duplicate segment ID ${segment.id}.`);
    }
    segmentIds.add(segment.id);
    if (segment.round_number > 0) {
      roundNumbers.add(segment.round_number);
    }

    if (segment.start_tick >= segment.end_tick) {
      issues.push(`Segment ${segment.id} is empty or reversed.`);
    }
    if (index > 0 && sorted[index - 1].end_tick !== segment.start_tick) {
      issues.push(
        `Segments ${sorted[index - 1].id} and ${segment.id} have a gap or overlap at tick ${segment.start_tick}.`
      );
    }

    if (segment.round_number === 0) {
      if (!isInterRoundGapSegment(segment, timeline)) {
        issues.push(`Segment ${segment.id} is not contained in an inter-round gap.`);
      }
    } else {
      const round = timeline.rounds.find(
        (candidate) => candidate.round_number === segment.round_number
      );
      if (!round) {
        issues.push(`Segment ${segment.id} references missing round ${segment.round_number}.`);
      } else if (segment.start_tick < round.start_tick || segment.end_tick > round.end_tick) {
        issues.push(`Segment ${segment.id} crosses round ${segment.round_number} boundaries.`);
      }
    }

    if ((segment.mode === "DEEP_DIVE" || segment.mode === "HABIT_CHECK") && segment.cue_ids.length === 0) {
      issues.push(`Teaching segment ${segment.id} has no cue.`);
    }
    if (segment.mode === "SKIP" && !segment.display_reason.trim()) {
      issues.push(`Skip segment ${segment.id} has no visible reason.`);
    }
  }

  for (const round of timeline.rounds) {
    if (!roundNumbers.has(round.round_number)) {
      issues.push(`Round ${round.round_number} is absent from the review path.`);
    }
  }

  const cueIds = new Set(plan.cues.map((cue) => cue.id));
  if (cueIds.size !== plan.cues.length) {
    issues.push("Plan contains duplicate cue IDs.");
  }
  for (const segment of plan.segments) {
    for (const cueId of segment.cue_ids) {
      if (!cueIds.has(cueId)) {
        issues.push(`Segment ${segment.id} references missing cue ${cueId}.`);
      }
    }
  }
  for (const cue of plan.cues) {
    validateCue(cue, plan, issues);
  }

  if (plan.status === "COMPLETE" && (!plan.full_match_index_ready || !plan.global_aggregation_ready)) {
    issues.push("A COMPLETE plan must have full-match indexing and global aggregation ready.");
  }

  return issues;
}

export function assertValidReviewPlan(timeline: MatchTimeline, plan: ReviewPlan): ReviewPlan {
  const issues = collectReviewPlanIssues(timeline, plan);
  if (issues.length > 0) {
    throw new ReviewPlanValidationError(issues);
  }
  return plan;
}

export function createFixtureReviewPlan(timeline: MatchTimeline): ReviewPlan {
  const plan: ReviewPlan = {
    id: "plan-fixture-mirage-v1",
    demo_id: timeline.demo_id,
    player_id: timeline.selected_player_id,
    status: "COMPLETE",
    match_timeline_version: timeline.timeline_version,
    observation_version: "fixture-observation/1.0.0",
    signal_version: "fixture-signals/1.0.0",
    planner_version: "fixture-planner/1.0.0",
    estimated_duration_seconds: 210,
    available_until_round: 4,
    full_match_index_ready: true,
    global_aggregation_ready: true,
    segments: [
      {
        id: "seg-r1-freeze",
        round_number: 1,
        start_tick: 0,
        end_tick: 256,
        mode: "SKIP",
        reason_code: "FREEZE_TIME",
        display_reason: "跳过 4 秒冻结时间：没有产生与决策相关的新信息。",
        playback_speed: 8,
        cue_ids: [],
        expandable: true
      },
      {
        id: "seg-r1-brief",
        round_number: 1,
        start_tick: 256,
        end_tick: 1600,
        mode: "BRIEF",
        reason_code: "CONTEXT_ONLY",
        display_reason: "普通执行回合：快速带过，用来建立默认站位和推进节奏。",
        playback_speed: 4,
        cue_ids: [],
        expandable: true
      },
      {
        id: "seg-r2-freeze",
        round_number: 2,
        start_tick: 1600,
        end_tick: 1856,
        mode: "SKIP",
        reason_code: "FREEZE_TIME",
        display_reason: "跳过 4 秒冻结时间：装备与出生信息已记录在回合上下文。",
        playback_speed: 8,
        cue_ids: [],
        expandable: true
      },
      {
        id: "seg-r2-deep",
        round_number: 2,
        start_tick: 1856,
        end_tick: 3200,
        mode: "DEEP_DIVE",
        reason_code: "ADVANTAGE_OVERPEEK",
        display_reason: "人数领先后的二次前压：在真实选择发生前暂停，直接说明判断与理由。",
        playback_speed: 1,
        cue_ids: ["cue-r2-overpeek"],
        expandable: true
      },
      {
        id: "seg-r3-freeze",
        round_number: 3,
        start_tick: 3200,
        end_tick: 3456,
        mode: "SKIP",
        reason_code: "FREEZE_TIME",
        display_reason: "跳过 4 秒冻结时间：没有教学增量。",
        playback_speed: 8,
        cue_ids: [],
        expandable: true
      },
      {
        id: "seg-r3-habit",
        round_number: 3,
        start_tick: 3456,
        end_tick: 4800,
        mode: "HABIT_CHECK",
        reason_code: "RECHECK_ADVANTAGE_OVERPEEK",
        display_reason: "相同风险再次出现：直接复盘判断与理由，再揭示真实结果。",
        playback_speed: 1,
        cue_ids: ["cue-r3-habit"],
        expandable: true
      },
      {
        id: "seg-r4-freeze",
        round_number: 4,
        start_tick: 4800,
        end_tick: 5056,
        mode: "SKIP",
        reason_code: "FREEZE_TIME",
        display_reason: "跳过 4 秒冻结时间：显式保留在完整时间轴中。",
        playback_speed: 8,
        cue_ids: [],
        expandable: true
      },
      {
        id: "seg-r4-observe",
        round_number: 4,
        start_tick: 5056,
        end_tick: 5800,
        mode: "OBSERVE",
        reason_code: "GOOD_TRADE_SPACING",
        display_reason: "观察点：这次你保持了可补枪距离，没有抢在队友之前暴露。",
        playback_speed: 2,
        cue_ids: [],
        expandable: true
      },
      {
        id: "seg-r4-brief",
        round_number: 4,
        start_tick: 5800,
        end_tick: 6400,
        mode: "BRIEF",
        reason_code: "ROUND_CLOSE",
        display_reason: "普通收尾：快速播放到比赛结束，再进入全场总结。",
        playback_speed: 4,
        cue_ids: [],
        expandable: true
      }
    ],
    cues: [
      {
        id: "cue-r2-overpeek",
        segment_id: "seg-r2-deep",
        cue_type: "DECISION",
        title: "领先后，先把优势留在队友能补枪的位置",
        question: "教练先停在这里：当前是 4 打 3，但最近队友还不能立刻覆盖拐角后的交火。继续前压会把团队优势变成缺少补枪保障的单挑；先留在队友能补枪的位置，等队友贴近或有新信息再拿空间。",
        decision_tick: 2350,
        reveal_tick: 2460,
        outcome_start_tick: 2350,
        outcome_end_tick: 2700,
        facts: [
          {
            id: "fact-r2-4v3",
            text: "你方在当前可知局面中是 4 打 3。",
            availability: "DECISION",
            available_at_tick: 2320,
            source: "DEMO",
            observed_by_player: true
          },
          {
            id: "fact-r2-spacing",
            text: "最近的队友仍在你身后，无法立刻覆盖拐角后的交火。",
            availability: "DECISION",
            available_at_tick: 2340,
            source: "DEMO",
            observed_by_player: true
          },
          {
            id: "fact-r2-outcome",
            text: "你越过拐角后先被击杀，人数优势被立刻交换掉。",
            availability: "OUTCOME",
            available_at_tick: 2580,
            source: "DEMO",
            observed_by_player: true
          }
        ],
        inferences: [
          {
            id: "inference-r2-isolated",
            text: "继续前压会把一个团队优势变成一次缺少补枪保障的单挑。",
            confidence: 0.88,
            fact_refs: ["fact-r2-4v3", "fact-r2-spacing"]
          }
        ],
        advice: [
          {
            id: "advice-r2-reset",
            text: "先停在队友可补枪的位置；只有队友贴近或新信息迫使你抢空间时，再越过拐角。",
            trigger: "拿到人数领先且最近队友无法在约 2 秒内补枪",
            fact_refs: ["fact-r2-4v3", "fact-r2-spacing"]
          }
        ],
        evidence: [
          {
            id: "rule-advantage-reset",
            source: "RULE",
            label: "人数优势后的风险重置规则",
            fact_refs: ["fact-r2-4v3", "fact-r2-spacing"]
          }
        ],
        observable_fact_refs: ["fact-r2-4v3", "fact-r2-spacing"],
        annotations: [
          { id: "ann-r2-risk", type: "AREA", coordinate_space: "RADAR_PERCENT", center: { x: 66, y: 36 }, radius: 8, label: "孤立交火区" },
          { id: "ann-r2-link", type: "LINE", coordinate_space: "RADAR_PERCENT", from: { x: 58, y: 43 }, to: { x: 46, y: 50 }, label: "补枪距离" }
        ],
        confidence: 0.88,
        limitations: ["合成夹具没有队内语音；如果队友明确要求同步前压，建议需要条件化调整。"]
      },
      {
        id: "cue-r3-habit",
        segment_id: "seg-r3-habit",
        cue_type: "HABIT_RECHECK",
        title: "同类风险再次出现，先重置而不是单独接触",
        question: "教练直接复盘这里：上一回合讲过的风险又出现了——你方仍有人数优势，但队友还不能同步接触。此刻先停、换位或后撤，能保住补枪关系；不要让一次单独过角抹掉团队优势。",
        decision_tick: 3910,
        reveal_tick: 4020,
        outcome_start_tick: 3910,
        outcome_end_tick: 4250,
        facts: [
          {
            id: "fact-r3-advantage",
            text: "当前局面再次拥有一人优势。",
            availability: "DECISION",
            available_at_tick: 3890,
            source: "DEMO",
            observed_by_player: true
          },
          {
            id: "fact-r3-teammate-gap",
            text: "队友与入口之间仍有明显距离，不能同步接触。",
            availability: "DECISION",
            available_at_tick: 3900,
            source: "DEMO",
            observed_by_player: true
          },
          {
            id: "fact-r3-outcome",
            text: "你再次先于队友接触并阵亡，之前的人数优势消失。",
            availability: "OUTCOME",
            available_at_tick: 4160,
            source: "DEMO",
            observed_by_player: true
          }
        ],
        inferences: [
          {
            id: "inference-r3-repeat",
            text: "这与上一回合属于相同的优势后孤立接触模式。",
            confidence: 0.84,
            fact_refs: ["fact-r3-advantage", "fact-r3-teammate-gap"]
          }
        ],
        advice: [
          {
            id: "advice-r3-checklist",
            text: "把“最近队友能否补枪”设成过角前检查项；答案是否定时，优先停、换位或后撤。",
            trigger: "准备越过不可回撤的拐角之前",
            fact_refs: ["fact-r3-advantage", "fact-r3-teammate-gap"]
          }
        ],
        evidence: [
          {
            id: "rule-habit-repeat",
            source: "RULE",
            label: "同场习惯复查规则",
            fact_refs: ["fact-r3-advantage", "fact-r3-teammate-gap"]
          }
        ],
        observable_fact_refs: ["fact-r3-advantage", "fact-r3-teammate-gap"],
        annotations: [
          { id: "ann-r3-risk", type: "AREA", coordinate_space: "RADAR_PERCENT", center: { x: 25, y: 43 }, radius: 7, label: "再次孤立" },
          { id: "ann-r3-gap", type: "LINE", coordinate_space: "RADAR_PERCENT", from: { x: 29, y: 52 }, to: { x: 36, y: 62 }, label: "队友未到位" }
        ],
        confidence: 0.84,
        limitations: ["合成夹具不包含语音与战术约定，只能确认空间和时间关系。"]
      }
    ],
    habit_clusters: [
      {
        id: "habit-advantage-overpeek",
        title: "人数领先后先于队友重复接触",
        taxonomy_id: "advantage.overpeek.untradeable",
        cue_ids: ["cue-r2-overpeek", "cue-r3-habit"],
        occurrence_count: 2,
        opportunity_count: 2
      }
    ],
    generation_manifest: {
      fixture_id: "mirage-coaching-v1",
      parser_version: "fixture-parser/1.0.0",
      observation_version: "fixture-observation/1.0.0",
      signal_version: "fixture-signals/1.0.0",
      planner_version: "fixture-planner/1.0.0"
    }
  };

  return assertValidReviewPlan(timeline, plan);
}
