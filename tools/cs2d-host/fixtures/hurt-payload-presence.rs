use source2_demo::prelude::*;
use source2_demo::proto::{self,Message,CSvcMsgGameEventList,CSvcMsgGameEvent,CDemoFileInfo,CDemoPacket,EDemoCommands,EBaseGameEvents};
use source2_demo::writer::{write_demo_message,BitstreamWriter,BitsWriter};
use serde_json::{json,Value};
// HELPERS
#[derive(Default)] struct Probe{ rows:Vec<Value> }
impl Observer for Probe {
 fn interests(&self)->Interests{Interests::BASE_GAME_EVENT}
 fn on_game_event(&mut self,_ctx:&Context,ge:&GameEvent)->ObserverResult{
  // COLLECTOR_REPORTS
  self.rows.push(json!({"reported":reports,"validatedTypes":(["health","armor","dmg_health","dmg_armor"].map(|name|ge.validated_value_type(name)))})); Ok(())
 }
}
fn main(){
 use proto::{csvc_msg_game_event as e,csvc_msg_game_event_list as l};
 let mut payloads=Vec::new();let mut labels=Vec::new();
 let cases=[("long-zero",3,3,Some(0),None),("long-positive",3,3,Some(40),None),("long-missing",3,3,None,None),
 ("short-zero",4,4,Some(0),None),("short-positive",4,4,Some(40),None),("short-missing",4,4,None,None),
 ("byte-zero",5,5,Some(0),None),("byte-positive",5,5,Some(40),None),("byte-missing",5,5,None,None),
 ("descriptor-mismatch",3,4,Some(0),None),("float-truncation",2,2,None,Some(0.5)),("controller-as-number",9,9,Some(0),None),
 ("wide-as-number",7,7,Some(40),None),("handle-as-number",8,8,Some(40),None),("byte-max",5,5,Some(255),None),("byte-overflow",5,5,Some(256),None),("byte-negative",5,5,Some(-256),None),("missing-keys",3,3,None,None)];
 for (index,(label,descriptor,wire,value,float)) in cases.into_iter().enumerate(){
  let id=100+index as i32;labels.push(label);
  payloads.push((EBaseGameEvents::GeSource1LegacyGameEventList as i32,CSvcMsgGameEventList{descriptors:vec![l::DescriptorT{eventid:Some(id),name:Some("player_hurt".into()),keys:["health","armor","dmg_health","dmg_armor"].map(|name|l::KeyT{name:Some(name.into()),r#type:Some(descriptor)}).into()}]}.encode_to_vec()));
  let key=e::KeyT{r#type:Some(wire),val_long:if wire==3||wire==8{value}else{None},val_short:if wire==4||wire==9{value}else{None},val_byte:if wire==5{value}else{None},val_float:float,val_uint64:if wire==7{value.map(|v|v as u64)}else{None},..Default::default()};
  payloads.push((EBaseGameEvents::GeSource1LegacyGameEvent as i32,CSvcMsgGameEvent{eventid:Some(id),keys:if label=="missing-keys"{vec![]}else{vec![key;4]},..Default::default()}.encode_to_vec()));
 }
 let refs:Vec<_>=payloads.iter().map(|(kind,data)|(*kind,data.as_slice())).collect();
 let bytes=replay_with_playback_ticks(20,&[(EDemoCommands::DemSyncTick,0,sync_payload()),(EDemoCommands::DemPacket,5,demo_packet_payload(&refs))]);
 let mut parser=Parser::from_slice(&bytes).unwrap();let observer=parser.register_observer::<Probe>();parser.run_to_end().unwrap();let rows=&observer.borrow().rows;
 assert_eq!(rows.len(),labels.len());
 for (label,row) in labels.iter().zip(rows) {
  let expected=match *label {"long-zero"|"short-zero"|"byte-zero"=>json!(0),"long-positive"|"short-positive"|"byte-positive"=>json!(40),"byte-max"=>json!(255),_=>Value::Null};
  for field in ["reported_health_after","reported_armor_after","reported_health_damage","reported_armor_damage"] {assert_eq!(row["reported"][field],expected,"{label}/{field}");}
 }
 println!("{}",json!({"synthetic":true,"inputBytes":bytes.len(),"actualDecodedCallbacks":rows.len(),"rows":labels.iter().zip(rows).map(|(label,value)|json!({"case":label,"result":value})).collect::<Vec<_>>()}));
}
