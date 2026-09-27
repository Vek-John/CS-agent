//! Anonymous current-pawn equipment coverage. No Replay, frame history or player identity output.
#[allow(dead_code)]
#[path = "CURRENT_PROPS"] mod props;
use source2_demo::prelude::*;
use source2_demo::proto::{Message, CDemoFileInfo, CDemoPacket, EDemoCommands};
use source2_demo::writer::{write_demo_message, BitstreamWriter, BitsWriter};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read};
const HELMET: &str = "m_pItemServices.m_bHasHelmet";
const DEFUSER: &str = "m_pItemServices.m_bHasDefuser";
fn classify(value: Option<&FieldValue>) -> &'static str {
    match value { None=>"MISSING",Some(FieldValue::Boolean(true))=>"TRUE",Some(FieldValue::Boolean(false))=>"FALSE",_=>"WRONG_TYPE" }
}
fn bump(counts:&mut BTreeMap<String,u64>,key:&str){*counts.entry(key.into()).or_default()+=1;}
#[derive(Default)]
struct Probe { last_cap:u32, counts:BTreeMap<String,u64>, helmet:BTreeMap<String,u64>, defuser:BTreeMap<String,u64>, alive_helmet:BTreeMap<String,u64>, alive_defuser:BTreeMap<String,u64>, }
impl Observer for Probe {
    fn interests(&self)->Interests { Interests::ENTITY_STATE | Interests::TICK_START }
    fn on_tick_start(&mut self,ctx:&Context)->ObserverResult {
        bump(&mut self.counts,"tickStartCallbacks");
        let tick=ctx.tick();if tick==u32::MAX{return Ok(());}
        if tick.wrapping_sub(self.last_cap)<8 && self.last_cap!=0{return Ok(());}
        self.last_cap=tick;bump(&mut self.counts,"scheduledSamples");
        // Same eligibility/order as collector's sampled player loop; no alive-only filter.
        for ctrl in ctx.entities().iter() {
            if ctrl.class().name()!="CCSPlayerController" {continue;}
            bump(&mut self.counts,"controllerObservations");
            if props::side_of(props::prop_i32(ctrl,"m_iTeamNum")).is_none(){bump(&mut self.counts,"nonPlayingController");continue;}
            let steam=props::prop_u64(ctrl,"m_steamID");
            if steam==0 || steam==u64::MAX {bump(&mut self.counts,"invalidSteam");continue;}
            let Some(pawn)=props::verified_controller_pawn(ctx,ctrl) else {bump(&mut self.counts,"invalidPawnBinding");continue;};
            let Some(side)=props::side_of(props::prop_i32(pawn,"m_iTeamNum")) else {bump(&mut self.counts,"nonPlayingPawn");continue;};
            bump(&mut self.counts,"eligiblePlayerSamples");bump(&mut self.counts,if side=="CT"{"ctSamples"}else{"tSamples"});
            let alive=matches!(pawn.get_property_by_name("m_iHealth"),Ok(FieldValue::Signed32(v)) if *v>0)
                && matches!(pawn.get_property_by_name("m_lifeState"),Ok(FieldValue::Unsigned32(0)|FieldValue::Unsigned8(0)|FieldValue::Signed32(0)));
            if alive {bump(&mut self.counts,"strictAliveSamples");}
            for (name,stats,alive_stats) in [(HELMET,&mut self.helmet,&mut self.alive_helmet),(DEFUSER,&mut self.defuser,&mut self.alive_defuser)] {
                let classification=classify(pawn.get_property_by_name(name).ok());bump(stats,classification);
                if alive {bump(alive_stats,classification);}
                let expected=match classification {"TRUE"=>Some(true),"FALSE"=>Some(false),_=>None};
                if props::prop_optional_bool(pawn,name)!=expected {bump(&mut self.counts,"optionalReaderDisagreements");}
            }
        }
        Ok(())
    }
}
fn scan(bytes:&[u8])->Result<Value,()> {
    let mut parser=Parser::from_slice(bytes).map_err(|_|())?;
    let observer=parser.register_observer::<Probe>();let complete=parser.run_to_end().is_ok();let p=observer.borrow();
    let samples=p.counts.get("eligiblePlayerSamples").copied().unwrap_or(0);
    let alive=p.counts.get("strictAliveSamples").copied().unwrap_or(0);
    let consistent=p.helmet.values().sum::<u64>()==samples && p.defuser.values().sum::<u64>()==samples
        && p.alive_helmet.values().sum::<u64>()==alive && p.alive_defuser.values().sum::<u64>()==alive
        && p.counts.get("optionalReaderDisagreements").copied().unwrap_or(0)==0;
    Ok(json!({"complete":complete,"partitionAndReaderChecksPassed":consistent,"coverageStatus":if samples>0{"OBSERVED"}else{"NO_ELIGIBLE_PLAYER_SAMPLES"},
        "phase":"TICK_START","tickStride":8,"counts":p.counts,"helmet":p.helmet,"defuser":p.defuser,"strictAliveHelmet":p.alive_helmet,"strictAliveDefuser":p.alive_defuser,
        "scope":"All eligible sampled players, including any warmup/dead samples; not formal round assembly, teaching eligibility or current-tick network-update frequency"}))
}
// SYNTHETIC_WRITERS
fn smoke()->Result<Value,()> {
    assert_eq!(classify(None),"MISSING");assert_eq!(classify(Some(&FieldValue::Boolean(true))),"TRUE");
    assert_eq!(classify(Some(&FieldValue::Boolean(false))),"FALSE");assert_eq!(classify(Some(&FieldValue::Unsigned32(1))),"WRONG_TYPE");
    let missing=Entity::default();
    for path in [HELMET,DEFUSER] {assert!(missing.get_property_by_name(path).is_err());assert_eq!(props::prop_optional_bool(&missing,path),None);}
    let bytes=replay_with_playback_ticks(24,&[(EDemoCommands::DemSyncTick,0,sync_payload()),
        (EDemoCommands::DemPacket,8,demo_packet_payload(&[])),(EDemoCommands::DemPacket,16,demo_packet_payload(&[]))]);
    let scan=scan(&bytes)?;
    assert_eq!(scan["complete"],true);assert_eq!(scan["partitionAndReaderChecksPassed"],true);assert!(scan["counts"]["tickStartCallbacks"].as_u64().unwrap_or(0)>0);
    assert!(scan["counts"]["scheduledSamples"].as_u64().unwrap_or(0)>=2);assert_eq!(scan["coverageStatus"],"NO_ELIGIBLE_PLAYER_SAMPLES");
    Ok(json!({"synthetic":true,"assertionsPassed":true,"classificationAssertions":4,"realEntityMissingProperties":2,"inputBytes":bytes.len(),"observerScan":scan,"scope":"Valid synthetic Demo verifies callback attachment, intentionally has no entities; not real equipment coverage"}))
}
fn main(){
    std::panic::set_hook(Box::new(|_|{}));let args:Vec<_>=std::env::args().collect();
    let result=if args.get(1).map(String::as_str)==Some("--smoke"){smoke()}else{(||{
        const CAP:u64=128*1024*1024;let file=std::fs::File::open(args.get(1).ok_or(())?).map_err(|_|())?;
        if file.metadata().map_err(|_|())?.len()>CAP{return Err(());}
        let mut bytes=Vec::new();file.take(CAP+1).read_to_end(&mut bytes).map_err(|_|())?;
        if bytes.len() as u64>CAP{return Err(());}scan(&bytes)
    })()};
    match result {Ok(value)=>println!("{}",value),Err(_)=>{eprintln!("EQUIPMENT_COVERAGE_FAILED");std::process::exit(1);}}
}
