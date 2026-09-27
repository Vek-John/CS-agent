//! Event-only synthetic/real coverage; no Replay/frame collection and no identity output.
use source2_demo::prelude::*;
use source2_demo::proto::{self, Message, CSvcMsgGameEventList, CSvcMsgGameEvent, EBaseGameEvents, CDemoFileInfo, CDemoPacket, EDemoCommands};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read};
// CURRENT_EVENT_CONTROLLER_OWNER
const FIELDS: [&str; 3] = ["userid", "attacker", "blind_duration"];
fn bump(map: &mut BTreeMap<String,u64>, key: impl Into<String>) { *map.entry(key.into()).or_default() += 1; }
fn type_name(kind: Option<i32>) -> String { match kind { None=>"MISSING".into(),Some(n) if (1..=9).contains(&n)=>format!("TYPE_{n}"),_=>"OTHER".into() } }
#[derive(Default)]
struct Probe {
    counts: BTreeMap<String,u64>, descriptors: BTreeMap<String,u64>, wires: BTreeMap<String,u64>, validated: BTreeMap<String,u64>,
    // Only fixed blind fields are retained, never raw event payloads or entity histories.
    blind_definitions: BTreeMap<i32,Vec<(String,usize)>>, target_name: Option<String>,
    target_owners: BTreeMap<String,(u64,u64)>, target_overflow: bool,
}
impl Observer for Probe {
    fn interests(&self)->Interests { Interests::all() }
    fn on_base_game_event(&mut self,_ctx:&Context,kind:EBaseGameEvents,bytes:&[u8])->ObserverResult {
        if kind==EBaseGameEvents::GeSource1LegacyGameEventList {
            bump(&mut self.counts,"descriptorMessages");
            let list=CSvcMsgGameEventList::decode(bytes)?;
            self.blind_definitions.clear();
            for descriptor in list.descriptors.iter().filter(|d|d.name.as_deref()==Some("player_blind")) {
                bump(&mut self.counts,"blindDescriptors");
                let mut fields=Vec::new();
                for name in FIELDS {
                    let matches:Vec<_>=descriptor.keys.iter().enumerate().filter(|(_,k)|k.name.as_deref()==Some(name)).collect();
                    if matches.len()!=1 {bump(&mut self.descriptors,format!("{name}:MISSING_OR_AMBIGUOUS"));continue;}
                    let (index,key)=matches[0];bump(&mut self.descriptors,format!("{name}:{}",type_name(key.r#type)));fields.push((name.into(),index));
                }
                if let Some(id)=descriptor.eventid { self.blind_definitions.insert(id,fields); }
            }
        } else if kind==EBaseGameEvents::GeSource1LegacyGameEvent {
            bump(&mut self.counts,"rawGameEventMessages");
            let event=CSvcMsgGameEvent::decode(bytes)?;
            if let Some(fields)=event.eventid.and_then(|id|self.blind_definitions.get(&id)) {
                bump(&mut self.counts,"rawBlindMessages");
                for (name,index) in fields {
                    let key=event.keys.get(*index);
                    bump(&mut self.wires,format!("{name}:{}",type_name(key.and_then(|k|k.r#type))));
                    let present=key.map(|k| if name=="blind_duration" {k.val_float.is_some()} else {k.val_short.is_some()}).unwrap_or(false);
                    if !present {bump(&mut self.counts,format!("{name}MissingPayload"));}
                }
            } else {bump(&mut self.counts,"rawMessagesNotMatchedToBlindDescriptor");}
        }
        Ok(())
    }
    fn on_game_event(&mut self,ctx:&Context,event:&GameEvent)->ObserverResult {
        bump(&mut self.counts,"namedEvents"); if event.name()!="player_blind" {return Ok(());}
        bump(&mut self.counts,"playerBlindEvents");
        for name in FIELDS {bump(&mut self.validated,format!("{name}:{}",type_name(event.validated_value_type(name))));}
        let duration_ok=event.validated_value_type("blind_duration")==Some(2) && matches!(event.get_value("blind_duration"),Ok(EventValue::Float(v)) if v.is_finite() && *v>0.0);
        if duration_ok {bump(&mut self.counts,"finitePositiveValidatedDuration");}
        if ctx.tick()!=u32::MAX {bump(&mut self.counts,"validEventTick");}
        let victim=event_controller_owner(ctx,event,"userid"); let attacker=event_controller_owner(ctx,event,"attacker");
        bump(&mut self.counts,if victim.is_some(){"victimCurrentOwnerResolved"}else{"victimCurrentOwnerUnknown"});
        bump(&mut self.counts,if attacker.is_some(){"attackerCurrentOwnerResolved"}else{"attackerCurrentOwnerUnknown"});
        if duration_ok && ctx.tick()!=u32::MAX && victim.is_some(){bump(&mut self.counts,"producerFieldEligibleBlindEvents");}
        if let Some(name)=&self.target_name {
            let candidates:Vec<_>=ctx.entities().iter().filter(|e|e.class().name()=="CCSPlayerController" && matches!(e.get_property_by_name("m_iszPlayerName"),Ok(FieldValue::String(value)) if value==name)).collect();
            let target=if candidates.len()==1 {match candidates[0].get_property_by_name("m_steamID"){Ok(FieldValue::Unsigned64(v)) if *v!=0 && *v!=u64::MAX=>Some(v.to_string()),_=>None}}else{None};
            if let Some(target)=target {
                bump(&mut self.counts,"selectedNameUniquelyResolvedAtBlindEvent");
                if self.target_owners.len()<2 || self.target_owners.contains_key(&target) {
                    let counters=self.target_owners.entry(target.clone()).or_default();
                    if victim.as_ref()==Some(&target) {counters.0+=1;if duration_ok && ctx.tick()!=u32::MAX {counters.1+=1;}}
                } else {self.target_overflow=true;}
            }
            else {bump(&mut self.counts,"selectedNameUnknownOrAmbiguousAtBlindEvent");}
        }
        Ok(())
    }
}
fn selected_summary(probe:&Probe)->Value {
    let status=if probe.target_name.is_none(){"NOT_REQUESTED"}else if !probe.counts.contains_key("playerBlindEvents"){"NO_BLIND_EVENTS_OBSERVED"}else if probe.target_overflow || probe.target_owners.len()>1 {"AMBIGUOUS_ACROSS_EVENTS"}else if probe.target_owners.is_empty(){"UNRESOLVED"}else{"ONE_OBSERVED_OWNER"};
    let counts=if status=="ONE_OBSERVED_OWNER"{let (events,eligible)=probe.target_owners.values().next().unwrap();json!({"victimEvents":events,"producerFieldEligibleEvents":eligible})}else{Value::Null};
    json!({"status":status,"counts":counts})
}
fn scan(bytes:&[u8],target:Option<String>)->Result<Value,()> {
    let mut parser=Parser::from_slice(bytes).map_err(|_|())?;
    let observer=parser.register_observer::<Probe>(); observer.borrow_mut().target_name=target;
    let complete=parser.run_to_end().is_ok(); let p=observer.borrow();
    Ok(json!({"complete":complete,"counts":p.counts,"descriptorTypes":p.descriptors,"wireTypes":p.wires,"validatedTypes":p.validated,"selected":selected_summary(&p),"scope":"global observed events, including any warmup; field eligibility is not round assembly or teaching eligibility"}))
}
// VENDOR_SYNTHETIC_WRITERS
fn smoke()->Result<Value,()> {
    use proto::{csvc_msg_game_event_list as list,csvc_msg_game_event as event,EDemoCommands};
    let descriptor=CSvcMsgGameEventList{descriptors:vec![list::DescriptorT{eventid:Some(12),name:Some("player_blind".into()),keys:FIELDS.iter().map(|name|list::KeyT{name:Some((*name).into()),r#type:Some(if *name=="blind_duration"{2}else{9})}).collect()}]}.encode_to_vec();
    let events:Vec<_>=(0..4).map(|n|CSvcMsgGameEvent{eventid:Some(12),keys:vec![
        event::KeyT{r#type:Some(if n==2{4}else{9}),val_short:if n==1{None}else{Some(257)},..Default::default()},
        event::KeyT{r#type:Some(9),val_short:Some(2),..Default::default()},
        event::KeyT{r#type:Some(2),val_float:if n==3{None}else{Some(0.04)},..Default::default()}],..Default::default()}.encode_to_vec()).collect();
    let mut messages=vec![(EBaseGameEvents::GeSource1LegacyGameEventList as i32,descriptor.as_slice())];
    for event in &events {messages.push((EBaseGameEvents::GeSource1LegacyGameEvent as i32,event.as_slice()));}
    let bytes=replay_with_playback_ticks(20,&[(EDemoCommands::DemSyncTick,0,sync_payload()),(EDemoCommands::DemPacket,5,demo_packet_payload(&messages))]);
    let result=scan(&bytes,Some("synthetic-not-present".into()))?;
    assert_eq!(result["complete"],true);assert_eq!(result["counts"]["namedEvents"],4);assert_eq!(result["counts"]["playerBlindEvents"],4);
    assert_eq!(result["counts"]["finitePositiveValidatedDuration"],3);assert_eq!(result["counts"]["victimCurrentOwnerUnknown"],4);
    assert_eq!(result["validatedTypes"]["userid:TYPE_9"],2);assert_eq!(result["validatedTypes"]["userid:MISSING"],2);
    assert_eq!(result["counts"]["useridMissingPayload"],1);assert_eq!(result["counts"]["blind_durationMissingPayload"],1);
    let zero=scan(&replay_with_playback_ticks(1,&[(EDemoCommands::DemSyncTick,0,sync_payload())]),None)?;
    assert_eq!(zero["complete"],true);assert!(zero["counts"].get("playerBlindEvents").is_none());
    let descriptor_only=scan(&replay_with_playback_ticks(20,&[(EDemoCommands::DemSyncTick,0,sync_payload()),(EDemoCommands::DemPacket,5,demo_packet_payload(&[(EBaseGameEvents::GeSource1LegacyGameEventList as i32,descriptor.as_slice())]))]),None)?;
    assert_eq!(descriptor_only["counts"]["blindDescriptors"],1);assert!(descriptor_only["counts"].get("playerBlindEvents").is_none());
    let mut identities=Probe::default();identities.target_name=Some("synthetic".into());bump(&mut identities.counts,"playerBlindEvents");
    identities.target_owners.insert("private-synthetic-a".into(),(1,1));assert_eq!(selected_summary(&identities)["counts"]["victimEvents"],1);
    identities.target_owners.insert("private-synthetic-b".into(),(1,1));assert_eq!(selected_summary(&identities)["status"],"AMBIGUOUS_ACROSS_EVENTS");assert!(selected_summary(&identities)["counts"].is_null());
    Ok(json!({"synthetic":true,"eventFixture":result,"zeroEventFixture":zero,"descriptorWithoutEventsFixture":descriptor_only,"assertionsPassed":true}))
}
fn main() {
    std::panic::set_hook(Box::new(|_|{}));
    let args:Vec<_>=std::env::args().collect();
    let result=if args.get(1).map(String::as_str)==Some("--smoke"){smoke()}else{( || {
        let file=std::fs::File::open(args.get(1).ok_or(())?).map_err(|_|())?;
        const CAP:u64=128*1024*1024;if file.metadata().map_err(|_|())?.len()>CAP{return Err(());}
        let mut bytes=Vec::new();file.take(CAP+1).read_to_end(&mut bytes).map_err(|_|())?;if bytes.len() as u64>CAP{return Err(());}
        scan(&bytes,args.get(2).cloned())
    })()};
    match result {Ok(value)=>println!("{}",value),Err(_)=>{eprintln!("BLIND_COVERAGE_FAILED");std::process::exit(1);}}
}
