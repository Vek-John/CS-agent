import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { diagnoseTeachingCue } from "@cs-coach/coach-agent/client";
import { TeachingDiagnosisPanel, type TeachingDiagnosisPanelProps } from "./teaching-diagnosis-panel";

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children as ReactNode)];
}
function button(tree: ReactNode, label: string) { return nodes(tree).find(node => node.type === "button" && node.props.children === label); }
function props(): TeachingDiagnosisPanelProps & { onReplay: () => void } {
  const output = diagnoseTeachingCue({cueId:"cue-test",reflection:{cueId:"cue-test",rawText:"等队友同步",selectedGoal:"OTHER",response:"ANSWERED",source:"USER",limitations:[]},decisionFacts:[],playerActionFacts:[],outcomeFacts:[]});
  return {cue:{id:"cue-test",title:"当前处理",question:"当时想做什么？"},decisionFacts:[],cueCase:output.cueCase,learningThread:output.learningThread,hasTrustedDecisionContext:true,
    onSubmit:vi.fn(),onSkip:vi.fn(),onConfirm:vi.fn(),onDisagree:vi.fn(),onReplay:vi.fn()};
}
/** SSR supplies real React hooks; capture the rendered element's actual callback, without a DOM/browser claim. */
function capture(input: TeachingDiagnosisPanelProps, edit?: (tree: ReactNode) => void) {
  let tree: ReactNode;
  function Capture() { tree = TeachingDiagnosisPanel(input); edit?.(tree); return tree; }
  const html=renderToStaticMarkup(createElement(Capture));
  return {tree,html};
}

it("offers the real result-panel replay callback without submitting or confirming again",()=>{
  const input=props();const view=capture(input);const replay=button(view.tree,"再看一遍");
  expect(replay).toBeDefined();
  (replay!.props.onClick as ()=>void)();
  expect(input.onReplay).toHaveBeenCalledOnce();expect(input.onSubmit).not.toHaveBeenCalled();expect(input.onConfirm).not.toHaveBeenCalled();expect(input.onDisagree).not.toHaveBeenCalled();
});

it.each(["pending", "legacy", "no-handler"])("has no replay entrance for %s",kind=>{
  const input=props();
  if(kind==="pending")input.cueCase={...input.cueCase!,status:"REFLECTION_PENDING"};
  if(kind==="legacy")input.hasTrustedDecisionContext=false;
  if(kind==="no-handler")delete (input as TeachingDiagnosisPanelProps).onReplay;
  expect(button(capture(input).tree,"再看一遍")).toBeUndefined();
});

it.each(["diagnosis", "tool"])("uses a disabled semantic button while %s is busy",kind=>{
  const input={...props(),busy:kind==="diagnosis",replayDisabled:kind==="tool"};
  const rendered=capture(input);expect(button(rendered.tree,"再看一遍")?.props.disabled).toBe(true);
  expect(rendered.html).toContain("disabled");
});

it("does not expose replay while an unsubmitted reflection is being edited",()=>{
  const input={...props(),cueCase:undefined};let step=0;
  const view=capture(input,tree=>{
    if(step++===0){const field=nodes(tree).find(node=>node.type==="textarea")!;(field.props.onChange as (e:unknown)=>void)({target:{value:"还没提交的思路"}});}
  });
  expect(view.html).toContain("还没提交的思路");expect(button(view.tree,"再看一遍")).toBeUndefined();expect(input.onSubmit).not.toHaveBeenCalled();
});

it("retains an unsubmitted disagreement after closing its editor and never exposes replay over that draft",()=>{
  const input=props();let step=0;
  const view=capture(input,tree=>{
    if(step===0){step++;(button(tree,"我不同意这个结论")!.props.onClick as ()=>void)();}
    else if(step===1){step++;expect(button(tree,"再看一遍")).toBeUndefined();const field=nodes(tree).find(node=>node.type==="textarea")!;(field.props.onChange as (e:unknown)=>void)({target:{value:"队友刚刚报过点"}});}
    else if(step===2){step++;(button(tree,"先不补充")!.props.onClick as ()=>void)();}
    else if(step===3){step++;expect(button(tree,"再看一遍")).toBeUndefined();(button(tree,"我不同意这个结论")!.props.onClick as ()=>void)();}
  });
  expect(view.html).toContain("队友刚刚报过点");expect(button(view.tree,"再看一遍")).toBeUndefined();expect(input.onDisagree).not.toHaveBeenCalled();
});

it("restores replay after closing an empty disagreement editor",()=>{
  const input=props();let step=0;
  const view=capture(input,tree=>{
    if(step===0){step++;(button(tree,"我不同意这个结论")!.props.onClick as ()=>void)();}
    else if(step===1){step++;(button(tree,"先不补充")!.props.onClick as ()=>void)();}
  });
  expect(button(view.tree,"再看一遍")).toBeDefined();
});

it.each([false, true])("drives the real panel callback through Host replay and back to the same diagnosis, manual=%s",async(manual)=>{
  const {createSyntheticMirageTimeline}=await import("@cs-coach/demo-domain");
  const {createFixtureReviewPlan}=await import("@cs-coach/review-planner");
  const {createCoachingSession,reduceCoachingSession}=await import("@cs-coach/session");
  const {requestTeachingDiagnosisReplay,HostOutcomeReplayGuard,outcomeReplayInteractionKey}=await import("../../lib/coaching/diagnosis-replay");
  const {guidedPlaybackDirective,guidedTransitionKey}=await import("../../lib/coaching/cs2d-guided-session");
  const {HostPlaybackControl}=await import("../../lib/playback/cs2d-playback-host");
  const plan=createFixtureReviewPlan(createSyntheticMirageTimeline());const cue=plan.cues[0];
  let session=reduceCoachingSession(plan,createCoachingSession(plan),{type:"START"});
  for(let step=0;step<plan.segments.length*5&&session.phase!=="PAUSED_FOR_COACHING";step++){
    const segment=plan.segments[session.current_segment_index];
    session=reduceCoachingSession(plan,session,session.phase==="SKIPPING"?{type:"SKIP_SEGMENT"}:{type:"TICK",tick:segment.end_tick});
  }
  expect(session.current_cue_id).toBe(cue.id);expect(session.outcome_completion?.status).toBe("COMPLETE");
  const diagnose=vi.fn(diagnoseTeachingCue);
  const output=diagnose({cueId:cue.id,reflection:{cueId:cue.id,rawText:"等队友同步",selectedGoal:"OTHER",response:"ANSWERED",source:"USER",limitations:[]},decisionFacts:[],playerActionFacts:[],outcomeFacts:[]});
  session=reduceCoachingSession(plan,session,{type:"RECORD_TEACHING_CASE",cueCase:output.cueCase,learningThread:output.learningThread});
  if(manual){
    session=reduceCoachingSession(plan,session,{type:"BEGIN_MANUAL_CUE_VISIT",cueId:cue.id,visitId:"panel-manual"});
    session=reduceCoachingSession(plan,session,{type:"TICK",tick:cue.outcome_end_tick});
  }
  let takenOver=manual;const guard=new HostOutcomeReplayGuard();
  const before=structuredClone(session);const control=new HostPlaybackControl();control.pause();expect(control.holding).toBe(true);
  const interactions=new Map<string,unknown>();const transition=vi.fn((action:{type:"REPLAY_OUTCOME"})=>{
    if(!guard.begin({plan,session,action,busy:false,takenOver,control,notifyTransport(){},invalidateSeek(){},clearTakeover(){control.reset();takenOver=false;}}))return;
    const key=outcomeReplayInteractionKey(session,action);
    interactions.set(key,action);session=reduceCoachingSession(plan,session,action);
  });
  const input:TeachingDiagnosisPanelProps={cue,decisionFacts:[],cueCase:output.cueCase,learningThread:output.learningThread,hasTrustedDecisionContext:true,
    onSubmit:vi.fn(),onSkip:vi.fn(),onDisagree:vi.fn(),onConfirm:vi.fn(()=>{
      session=reduceCoachingSession(plan,session,{type:"CONFIRM_TEACHING_CASE",cueId:cue.id});
      session=reduceCoachingSession(plan,session,{type:"CUE_PRESENTED",cueId:cue.id,...(session.manual_cue_visit?{visitId:session.manual_cue_visit.visit_id}:{})});
      session=reduceCoachingSession(plan,session,manual?{type:"CANCEL_MANUAL_CUE_VISIT"}:{type:"ADVANCE_SEGMENT"});
    }),
    onReplay:()=>{requestTeachingDiagnosisReplay({sessionId:before.id,cueId:cue.id,...(before.manual_cue_visit?{visitId:before.manual_cue_visit.visit_id}:{})},()=>({plan,session,cueCase:output.cueCase,busy:false,takenOver}),transition);}};
  const first=capture(input);const replay=button(first.tree,"再看一遍")!;
  (replay.props.onClick as ()=>void)();(replay.props.onClick as ()=>void)();
  expect(transition).toHaveBeenCalledOnce();expect(interactions.size).toBe(1);expect(session.phase).toBe("REPLAYING");expect(control.holding).toBe(false);expect(takenOver).toBe(manual);
  const key=`${session.id}:${guidedTransitionKey(session)}`;expect(control.claimTransition(key)).toBe(true);expect(control.claimTransition(key)).toBe(false);
  const start=guidedPlaybackDirective(plan,session,64);expect(start.commands).toContainEqual({type:"play"});expect(start.commands.every(command=>control.allows(command))).toBe(true);
  expect(start.commands).toContainEqual({type:"seekCanonicalTick",canonicalTick:Math.max(plan.segments[session.current_segment_index].start_tick,cue.decision_tick-64)});
  control.pause();expect(control.canAdvance(session,false)).toBe(false);expect(control.observe(true).advance).toBe(false);control.observe(false);control.resume();
  expect(control.canAdvance(session,false)).toBe(true);
  session=reduceCoachingSession(plan,session,{type:"TICK",tick:cue.outcome_end_tick-1});expect(session.phase).toBe("REPLAYING");
  session=reduceCoachingSession(plan,session,{type:"TICK",tick:cue.outcome_end_tick});
  expect(session.phase).toBe("PAUSED_FOR_COACHING");expect(session.current_cue_id).toBe(cue.id);expect(session.current_tick).toBe(cue.decision_tick);
  expect(guidedPlaybackDirective(plan,session).commands).toContainEqual({type:"pause"});expect(guidedPlaybackDirective(plan,session).commands).toContainEqual({type:"seekCanonicalTick",canonicalTick:cue.decision_tick});
  expect(session.cue_cases).toEqual(before.cue_cases);expect(session.learning_threads).toEqual(before.learning_threads);expect(session.consumed_cue_ids).toEqual(before.consumed_cue_ids);expect(session.presented_cue_ids).toEqual(before.presented_cue_ids);
  expect(session.outcome_completion).toEqual(before.outcome_completion);
  expect(session.user_events.filter(e=>e.type==="REFLECTION_SUBMITTED"||e.type==="DIAGNOSTIC_COMPLETED")).toEqual(before.user_events.filter(e=>e.type==="REFLECTION_SUBMITTED"||e.type==="DIAGNOSTIC_COMPLETED"));
  expect(session.user_events.filter(e=>e.type==="OUTCOME_REPLAYED")).toHaveLength(before.user_events.filter(e=>e.type==="OUTCOME_REPLAYED").length+1);
  const restored=capture(input);expect(restored.html).toContain("等队友同步");expect(restored.html).toContain(output.cueCase.verdict!.explanation);
  expect(diagnose).toHaveBeenCalledOnce();expect(input.onSubmit).not.toHaveBeenCalled();expect(input.onSkip).not.toHaveBeenCalled();expect(input.onDisagree).not.toHaveBeenCalled();expect(input.onConfirm).not.toHaveBeenCalled();
  (button(restored.tree,"懂了，继续")!.props.onClick as ()=>void)();expect(input.onConfirm).toHaveBeenCalledOnce();if(manual){expect(session.manual_cue_visit).toBeUndefined();expect(session.default_route_cursor).toEqual(before.default_route_cursor);expect(session.consumed_cue_ids).toEqual(before.consumed_cue_ids);}
  else {expect(session.current_segment_index).toBeGreaterThan(before.current_segment_index);expect(session.default_route_cursor).toEqual(reduceCoachingSession(plan, before, {type:"ADVANCE_SEGMENT"}).default_route_cursor);expect(session.consumed_cue_ids.filter(id=>id===cue.id)).toHaveLength(1);}
});
