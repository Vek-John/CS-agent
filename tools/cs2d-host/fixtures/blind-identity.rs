// Synthetic event time and identity. Actual collector, props and assembly are injected.
// Descriptor/wire decoding is separately exercised by vendor wire_type_tests.
use std::collections::HashMap;
mod error {#[derive(Debug)]pub enum GameEventError {ConversionError(String,String)}}
mod vendor_value {include!("VENDOR_EVENT_VALUE");}
use vendor_value::EventValue;
struct GameEvent(HashMap<&'static str,(i32,i32,Option<EventValue>)>);
impl GameEvent {
 fn get_value(&self,k:&str)->Result<&EventValue,()>{self.0.get(k).and_then(|v|v.2.as_ref()).ok_or(())}
 fn validated_value_type(&self,k:&str)->Option<i32>{let(d,w,v)=self.0.get(k)?;if d==w&&v.is_some(){Some(*w)}else{None}}
}
struct Class(&'static str);impl Class{fn name(&self)->&str{self.0}}
enum FieldValue{Unsigned64(u64),Unsigned32(u32)}
struct Entity{index:usize,class:Class,steam:Option<FieldValue>}
impl Entity {fn class(&self)->&Class{&self.class}fn get_property_by_name(&self,_:&str)->Result<&FieldValue,()>{self.steam.as_ref().ok_or(())}}
struct Entities(Vec<Entity>);impl Entities{fn get_by_index(&self,index:usize)->Result<&Entity,()>{self.0.iter().find(|e|e.index==index).ok_or(())}}
struct Context(Entities);impl Context{fn entities(&self)->&Entities{&self.0}}
#[derive(Default)]struct Collector{
 // COLLECTOR_FIELD
 userid_to_steam:HashMap<i32,String>,
}
#[derive(Debug)]
// BLIND_STRUCT
struct Round{freeze_start_tick:u32,post_end_tick:u32,blinds:Vec<Blind>}
const DEMO_TICK_RATE:f64=64.;
// HELPERS
impl Collector {fn blind(&mut self,ctx:&Context,ge:&GameEvent,tick:u32){
 // BLIND_BODY
}}
fn assemble(c:&Collector)->Vec<Blind>{let mut rounds=vec![Round{freeze_start_tick:100,post_end_tick:200,blinds:vec![]}];
 // ROUND_OF
 // ASSEMBLE
 rounds.remove(0).blinds
}
fn ctx(steam:u64)->Context{Context(Entities(vec![Entity{index:2,class:Class("CCSPlayerController"),steam:Some(FieldValue::Unsigned64(steam))}]))}
fn event(raw:i32,duration:f32)->GameEvent{GameEvent(HashMap::from([("userid",(9,9,Some(EventValue::Int(raw)))),("attacker",(9,9,Some(EventValue::Int(raw)))),("blind_duration",(2,2,Some(EventValue::Float(duration))))]))}
#[test]fn freezes_current_recipient_and_attacker_without_using_stale_cache(){let mut c=Collector::default();c.userid_to_steam.insert(1,"stale".into());c.blind(&ctx(111),&event(1,2.),101);c.blind(&ctx(222),&event(1,2.),102);let b=assemble(&c);assert_eq!(b.len(),2);assert_eq!(b[0].steam_id,"111");assert_eq!(b[0].flasher_steam_id.as_deref(),Some("111"));assert_eq!(b[1].steam_id,"222");}
#[test]fn future_cache_cannot_backfill_an_unknown_victim(){let mut c=Collector::default();c.blind(&Context(Entities(vec![])),&event(1,2.),101);c.userid_to_steam.insert(1,"future".into());assert!(assemble(&c).is_empty());}
#[test]fn supported_high_byte_is_slot_metadata_not_pawn_serial(){let mut c=Collector::default();c.blind(&ctx(111),&event(0x101,2.),101);assert_eq!(assemble(&c)[0].steam_id,"111");}
#[test]fn rejects_unsupported_integer_ranges_and_noncontroller_types(){for raw in [-1,-65535,65535,65536,i32::MAX]{let mut c=Collector::default();c.blind(&ctx(111),&event(raw,2.),101);assert!(assemble(&c).is_empty());}for types in [(4,4),(8,8),(9,4),(4,9)]{let mut e=event(1,2.);e.0.insert("userid",(types.0,types.1,Some(EventValue::Int(1))));let mut c=Collector::default();c.blind(&ctx(111),&e,101);assert!(assemble(&c).is_empty());}}
#[test]fn rejects_wrong_class_missing_and_invalid_steam_without_requiring_pawn(){for mode in 0..5{let mut context=ctx(111);match mode{0=>context.0.0[0].class=Class("CCSPlayerPawn"),1=>context.0.0[0].steam=None,2=>context.0.0[0].steam=Some(FieldValue::Unsigned64(0)),3=>context.0.0[0].steam=Some(FieldValue::Unsigned64(u64::MAX)),_=>context.0.0[0].steam=Some(FieldValue::Unsigned32(111))}let mut c=Collector::default();c.blind(&context,&event(1,2.),101);assert!(assemble(&c).is_empty());}}
#[test]fn unknown_attacker_does_not_erase_known_recipient(){let mut e=event(1,2.);e.0.remove("attacker");let mut c=Collector::default();c.blind(&ctx(111),&e,101);let b=assemble(&c);assert_eq!(b[0].steam_id,"111");assert_eq!(b[0].flasher_steam_id,None);}
#[test]fn duration_and_tick_must_be_supported_finite_reports(){for duration in [0.,-1.,f32::NAN,f32::INFINITY]{let mut c=Collector::default();c.blind(&ctx(111),&event(1,duration),101);assert!(c.blinds_raw.is_empty());}for invalid in [None,Some(EventValue::Int(1))]{let mut e=event(1,2.);e.0.insert("blind_duration",(2,2,invalid));let mut c=Collector::default();c.blind(&ctx(111),&e,101);assert!(c.blinds_raw.is_empty());}let mut e=event(1,2.);e.0.get_mut("blind_duration").unwrap().0=3;let mut c=Collector::default();c.blind(&ctx(111),&e,101);assert!(c.blinds_raw.is_empty());c.blind(&ctx(111),&event(1,2.),u32::MAX);assert!(c.blinds_raw.is_empty());}
#[cfg(blind_v1)]#[test]fn preserves_exact_tick_short_report_and_unique_stable_ids_with_legacy_display(){let mut c=Collector::default();for _ in 0..2{c.blind(&ctx(111),&event(1,0.04),101);}let b=assemble(&c);assert_eq!(b[0].t,0.);assert_eq!(b[0].duration,0.);assert_eq!(b[0].reported_duration,0.04_f32 as f64);assert_eq!(b[0].tick,101);assert_eq!(b[0].blind_evidence_version,1);assert_eq!(b[0].id,"cs2d-blind-101-1");assert_eq!(b[1].id,"cs2d-blind-101-2");assert_eq!(assemble(&c)[0].id,b[0].id);}
