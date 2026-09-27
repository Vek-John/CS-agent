// Read-only diagnostic example. Copy into the controlled parser examples directory to compile.
// Uses actual current-pawn verification; output is anonymous aggregate coverage, not coaching conclusions.
#[allow(dead_code)]
#[path = "../src/props.rs"] mod props;
use source2_demo::prelude::*;
use source2_demo::proto::CSvcMsgServerInfo;
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc, collections::BTreeMap};
#[derive(Clone, Copy, Debug, PartialEq)] enum Reading { Missing, WrongType, Value(u32) }
fn strict(value: Option<&FieldValue>) -> Reading { match value { None=>Reading::Missing, Some(FieldValue::Unsigned32(v))=>Reading::Value(*v), _=>Reading::WrongType } }
fn read(entity: &Entity, key: &str)->Reading { strict(entity.get_property_by_name(key).ok()) }
fn flag(v: Reading)-> &'static str { match v { Reading::Missing=>"MISSING", Reading::WrongType=>"WRONG_TYPE", Reading::Value(n) if n&1==1=>"FLAG_SET", Reading::Value(_)=>"FLAG_UNSET" } }
fn handle_kind(v: Reading)-> &'static str { match v { Reading::Missing=>"MISSING",Reading::WrongType=>"WRONG_TYPE",Reading::Value(0xffffff)=>"INVALID_SENTINEL", Reading::Value(n) if n<0xffffff=>"PACKED", _=>"MALFORMED" } }
fn relation(f: Reading, h: &str)-> &'static str { match (flag(f),h) { ("FLAG_SET","BOUND_CURRENT")|("FLAG_UNSET","INVALID_SENTINEL")=>"AGREEMENT", ("FLAG_UNSET","BOUND_CURRENT")|("FLAG_SET","INVALID_SENTINEL")=>"CONFLICT", _=>"UNKNOWN" } }
fn bump(counts: &mut BTreeMap<String,u64>, key: &str) { *counts.entry(key.into()).or_default()+=1; }
#[derive(Default)] struct Stats { counts: BTreeMap<String,u64>, flags: BTreeMap<String,u64>, ground: BTreeMap<String,u64>, relation: BTreeMap<String,u64>, alive_relation: BTreeMap<String,u64>, alive_flags: BTreeMap<String,u64>, alive_ground: BTreeMap<String,u64> }
impl Stats { fn json(&self)->Value {json!({"samples":self.counts,"flags":self.flags,"groundHandle":self.ground,"relation":self.relation,"aliveRelation":self.alive_relation,"aliveFlags":self.alive_flags,"aliveGroundHandle":self.alive_ground})} }
#[derive(Clone,PartialEq)] struct Sample { owner:u64,index:u32,serial:u32, flags:Reading,ground:Reading, alive:bool }
#[derive(Default)] struct Probe { target_name:String,target:Option<u64>,ambiguous:bool,last_cap:u32,sample_tick:Option<u32>,start_sample:Option<Sample>, start:Stats,end:Stats,pairs:BTreeMap<String,u64>,tick_interval:Option<f32> }
impl Probe {
 fn capture(&mut self,ctx:&Context,end:bool)->Option<Sample> {
  let stats=if end {&mut self.end} else {&mut self.start}; bump(&mut stats.counts,"scheduled");
  if self.target.is_none() {
   let ids:Vec<_>=ctx.entities().iter().filter(|e|e.class().name()=="CCSPlayerController" && props::ev_name(e)==self.target_name).map(|e|props::prop_u64(e,"m_steamID")).filter(|x|*x!=0 && *x!=u64::MAX).collect();
   if ids.len()>1 { self.ambiguous=true; }
   if ids.len()==1 && !self.ambiguous { self.target=Some(ids[0]); }
  }
  let target=self.target?;
  if self.ambiguous {return None;}
  let ctrls:Vec<_>=ctx.entities().iter().filter(|e|e.class().name()=="CCSPlayerController" && props::prop_u64(e,"m_steamID")==target).collect();
  if ctrls.len()!=1 { bump(&mut stats.counts,"controllerMissingOrAmbiguous");return None; }
  let ctrl=ctrls[0];
  if props::side_of(props::prop_i32(ctrl,"m_iTeamNum")).is_none() {bump(&mut stats.counts,"nonPlayingController");return None;}
  let Some(pawn)=props::verified_controller_pawn(ctx,ctrl) else {bump(&mut stats.counts,"invalidPawnBinding");return None;};
  if props::side_of(props::prop_i32(pawn,"m_iTeamNum")).is_none() {bump(&mut stats.counts,"nonPlayingPawn");return None;}
  bump(&mut stats.counts,"eligibleVerifiedPawn");
  let f=read(pawn,"m_fFlags");let h=read(pawn,"m_hGroundEntity");
  let hk=if let Reading::Value(n)=h {if n<0xffffff {match ctx.entities().get_by_index((n&0x3fff) as usize) { Ok(e) if e.index()==(n&0x3fff) && (e.serial()&0x3ff)==(n>>14)=>"BOUND_CURRENT", _=>"UNRESOLVED" }} else {handle_kind(h)}} else {handle_kind(h)};
  let positive_health=matches!(pawn.get_property_by_name("m_iHealth"),Ok(FieldValue::Signed32(n)) if *n>0);
  let life_alive=match pawn.get_property_by_name("m_lifeState") { Ok(FieldValue::Unsigned32(v))=>Some(*v==0), Ok(FieldValue::Unsigned8(v))=>Some(*v==0), Ok(FieldValue::Signed32(v))=>Some(*v==0), _=>None };
  let alive=positive_health && life_alive==Some(true);
  if life_alive.is_none() { bump(&mut stats.counts,"lifeStateUnknown"); }
  bump(&mut stats.flags,flag(f));bump(&mut stats.ground,hk);bump(&mut stats.relation,relation(f,hk));
  if alive {bump(&mut stats.counts,"aliveEligible");bump(&mut stats.alive_relation,relation(f,hk));bump(&mut stats.alive_flags,flag(f));bump(&mut stats.alive_ground,hk);}
  Some(Sample{owner:target,index:pawn.index(),serial:pawn.serial(),flags:f,ground:h,alive})
 }
}
#[observer]
#[uses_all]
impl Probe {
 #[on_message] fn server_info(&mut self,_ctx:&Context,msg:CSvcMsgServerInfo)->ObserverResult {self.tick_interval=msg.tick_interval;Ok(())}
 #[on_tick_start] fn start(&mut self,ctx:&Context)->ObserverResult {
  let t=ctx.tick();if t==u32::MAX || (t.wrapping_sub(self.last_cap)<8 && self.last_cap!=0) {return Ok(());}
  self.last_cap=t;self.sample_tick=Some(t);self.start_sample=self.capture(ctx,false);Ok(())
 }
 #[on_tick_end] fn end(&mut self,ctx:&Context)->ObserverResult {
  if self.sample_tick!=Some(ctx.tick()) {return Ok(());}
  let end=self.capture(ctx,true);
  match (&self.start_sample,end) {
   (Some(a),Some(b)) if (a.owner,a.index,a.serial)==(b.owner,b.index,b.serial)=>{bump(&mut self.pairs,"sameVerifiedPawn");if a.flags!=b.flags {bump(&mut self.pairs,"flagsValueChanged");}if flag(a.flags)!=flag(b.flags){bump(&mut self.pairs,"flagProjectionChanged");}if a.ground!=b.ground {bump(&mut self.pairs,"groundValueChanged");}if a.alive && b.alive && flag(a.flags)!=flag(b.flags) {bump(&mut self.pairs,"aliveFlagProjectionChanged");}},
   (Some(_),Some(_))=>bump(&mut self.pairs,"differentPawn"),_=>bump(&mut self.pairs,"missingOnePhase")
  };self.sample_tick=None;Ok(())
 }
}
fn smoke(){
 assert_eq!(flag(strict(None)),"MISSING");assert_eq!(flag(strict(Some(&FieldValue::Float(0.0)))),"WRONG_TYPE");
 assert_eq!(flag(strict(Some(&FieldValue::Unsigned32(0)))),"FLAG_UNSET");assert_eq!(flag(Reading::Value(1)),"FLAG_SET");assert_eq!(flag(Reading::Value(4)),"FLAG_UNSET");assert_eq!(flag(Reading::Value(5)),"FLAG_SET");
 assert_eq!(handle_kind(Reading::Value(0xffffff)),"INVALID_SENTINEL");assert_eq!(handle_kind(Reading::Value(u32::MAX)),"MALFORMED");assert_eq!(handle_kind(Reading::Value(0)),"PACKED");
 assert_eq!(relation(Reading::Value(1),"INVALID_SENTINEL"),"CONFLICT");assert_eq!(relation(Reading::Value(0),"BOUND_CURRENT"),"CONFLICT");assert_eq!(relation(Reading::Missing,"BOUND_CURRENT"),"UNKNOWN");assert_eq!(relation(Reading::Value(0),"UNRESOLVED"),"UNKNOWN");
 println!("{}",json!({"smokeAssertions":13,"passed":true,"demoReads":0}));
}
fn run()->Result<(),()> {
 let args:Vec<_>=std::env::args().collect();if args.get(1).map(String::as_str)==Some("--smoke") {smoke();return Ok(());}
 let path=args.get(1).ok_or(())?;let target=args.get(2).ok_or(())?;
 let len=std::fs::metadata(path).map_err(|_|())?.len();if len>128*1024*1024{return Err(());}
 let bytes=std::fs::read(path).map_err(|_|())?;let mut parser=Parser::from_slice(&bytes).map_err(|_|())?;
 let probe:Rc<RefCell<Probe>>=parser.register_observer::<Probe>();probe.borrow_mut().target_name=target.clone();
 parser.run_to_end().map_err(|_|())?;let p=probe.borrow();
 println!("{}",json!({"schemaVersion":"sampled-ground-coverage.v1","scope":"selected-controller-only","targetFound":p.target.is_some(),"targetAmbiguous":p.ambiguous,"demoBytes":len,"demoReads":1,"parses":1,"strideTicks":8,"tickInterval":p.tick_interval,"tickStart":p.start.json(),"tickEnd":p.end.json(),"phasePairs":p.pairs}));Ok(())
}
fn main(){std::panic::set_hook(Box::new(|_|{}));if run().is_err(){eprintln!("GROUND_PROBE_FAILED");std::process::exit(1);}}
