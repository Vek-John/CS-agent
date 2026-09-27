import { expect, it } from "vitest";
import { buildCsNetFeatureBatch, buildWinProbabilityTimeline, sigmoidTemperature, type CsNetReplay } from "./index";

function fixture(): CsNetReplay {
  const players=Array.from({length:10},(_,i)=>({steamId:`synthetic-${i}`,startSide:i<5?"CT" as const:"T" as const}));
  return {map:"de_mirage",demoTickRate:64,frameRate:8,players,rounds:[0,1].map(index=>{
    const offset=index*1000;
    return {number:index+1,freezeStartTick:offset,startTick:offset+64,decidedTick:offset+300,endTick:offset+320,postEndTick:offset+400,winner:"CT" as const,scoreCt:index,scoreT:0,
      frames:[64,128,192].map(tick=>({tick:offset+tick,t:tick/64,players:players.map((p,i)=>{
        const side=index===0?p.startSide:p.startSide==="CT"?"T" as const:"CT" as const;
        return {...p,side,x:0,y:0,z:0,yaw:0,health:100,alive:true,weapon:side==="CT"?"M4A4":"Glock-18",primary:side==="CT"?"M4A4":"Glock-18",equipValue:side==="CT"?4500:1000,money:side==="CT"?4500:1000,armor:100,helmet:true,grenades:[]};
      })})),events:[{type:"kill" as const,tick:offset+192,t:3,attackerSteamId:"synthetic-5",victimSteamId:"synthetic-0",x:0,y:0,z:0}],};
  })};
}
function run(replay=fixture(),selectedPlayerId:string|undefined="synthetic-0") {
 const batch=buildCsNetFeatureBatch(replay),logits=batch.samples.map((_,i)=>i%3===2?1:-1);
 const timeline=buildWinProbabilityTimeline({replay,samples:batch.samples,logits,selectedPlayerId});
 return {timeline,batch,logits};
}
it("uses current round sides after a switch with unchanged model samples and probabilities",()=>{
 const replay=fixture(),before=JSON.stringify(replay),{timeline,batch,logits}=run(replay);
 expect(timeline.swings.map(s=>[s.victimSide,s.economy])).toEqual([["CT","FULL"],["T","PISTOL"]]);
 expect(timeline.rounds.flatMap(r=>r.samples).map(s=>s.probability)).toEqual(logits.map(l=>sigmoidTemperature(l)));
 expect(timeline.rounds.flatMap(r=>r.samples).map(s=>s.tick)).toEqual(batch.samples.map(s=>s.tick));
 expect(timeline.swings.map(s=>[s.id,s.cause,s.selectedPlayerDeath])).toEqual([["swing-1-192","PLAYER_DEATH",true],["swing-2-1192","PLAYER_DEATH",true]]);
 expect(JSON.stringify(replay)).toBe(before);
});

it("uses current sampled sides when player start metadata is absent or contradictory",()=>{
 const replay=fixture(),original=run(replay),without=run({...replay,players:[]});
 expect(without.timeline).toEqual(original.timeline);
 expect(without.batch.inputs).toEqual(original.batch.inputs);
 const contradictory=run({...replay,players:replay.players.map(p=>({...p,startSide:p.startSide==="CT"?"T" as const:"CT" as const}))});
 expect(contradictory.timeline).toEqual(original.timeline);
});

it("does not default missing or unspecified selected players to CT economy",()=>{
 const replay=fixture(),{batch,logits}=run(replay);
 for(const selectedPlayerId of [undefined,"not-present"]){
  const timeline=buildWinProbabilityTimeline({replay,samples:batch.samples,logits,selectedPlayerId});
  expect(timeline.swings.map(s=>s.economy)).toEqual(["UNKNOWN","UNKNOWN"]);
  expect(timeline.swings.map(s=>s.victimSide)).toEqual(["CT","T"]);
  expect(timeline.rounds.flatMap(r=>r.samples).map(s=>s.probability)).toEqual(logits.map(l=>sigmoidTemperature(l)));
 }
});

it.each(["missing","duplicate","duplicate-frame","invalid-side"])("does not backfill a victim from startSide or an older sample when latest is %s",mode=>{
 const replay=fixture(), round=replay.rounds[1], latest=round.frames[2];
 if(mode==="missing") latest.players=latest.players.filter(p=>p.steamId!=="synthetic-0");
 if(mode==="duplicate") latest.players=[...latest.players,latest.players[0]];
 if(mode==="duplicate-frame") round.frames=[...round.frames,{...latest}];
 if(mode==="invalid-side") Object.assign(latest.players[0],{side:"SPECTATOR"});
 const {timeline}=run(replay);
 expect(timeline.swings.find(s=>s.id==="swing-2-1192")?.victimSide).toBeUndefined();
 // Economy is the opening economic sample, not the later death sample.
 expect(timeline.swings.find(s=>s.id==="swing-2-1192")?.economy).toBe("PISTOL");
});

it("does not borrow future or previous-round player state for a victim",()=>{
 const replay=fixture(),round=replay.rounds[1];
 round.events=round.events.map(event=>({...event,tick:1191}));
 round.frames=round.frames.map(frame=>frame.tick<1192?{...frame,players:frame.players.filter(p=>p.steamId!=="synthetic-0")}:frame);
 const {timeline}=run(replay),swing=timeline.swings.find(s=>s.id==="swing-2-1192")!;
 expect(swing.cause).toBe("PLAYER_DEATH");expect(swing.selectedPlayerDeath).toBe(true);
 expect(swing.victimSide).toBeUndefined();expect(swing.economy).toBe("UNKNOWN");
});

it.each(["missing","duplicate"])("does not use later selected-player state when the economic sample is %s",mode=>{
 const replay=fixture(), first=replay.rounds[1].frames[0];
 first.players=mode==="missing"?first.players.filter(p=>p.steamId!=="synthetic-0"):[...first.players,first.players[0]];
 const swing=run(replay).timeline.swings.find(s=>s.id==="swing-2-1192")!;
 expect(swing.victimSide).toBe("T");expect(swing.economy).toBe("UNKNOWN");
});

it("does not read a round's later economic sample into an earlier swing",()=>{
 const source=fixture(),round=source.rounds[0];
 const replay={...source,rounds:[{...round,frames:round.frames.map((frame,i)=>({...frame,tick:i*32,t:i/2})),events:[]}]};
 const batch=buildCsNetFeatureBatch(replay),logits=[-1,1,1];
 const timeline=buildWinProbabilityTimeline({replay,samples:batch.samples,logits,selectedPlayerId:"synthetic-0"});
 expect(timeline.rounds[0].economy.ct).toBe("FULL");
 expect(timeline.swings[0]).toMatchObject({tick:32,economy:"UNKNOWN"});
 expect(timeline.rounds[0].terminal).toEqual({tick:400,probability:1,winner:"CT",source:"ROUND_WINNER"});
});
