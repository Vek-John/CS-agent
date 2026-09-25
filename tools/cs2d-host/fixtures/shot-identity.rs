// Synthetic entity lifecycle; no integers here are measured Demo ticks.
// The harness injects the actual production weapon_fire body and identity helpers.
use std::collections::HashMap;
#[derive(Clone)] struct Class(&'static str);
impl Class { fn name(&self) -> &str { self.0 } }
#[derive(Clone)] enum FieldValue { Unsigned32(u32) }
#[derive(Clone)] struct Entity { index: u32, serial: u32, class: Class, handle: FieldValue, steam: u64, x: f64 }
impl Entity {
 fn index(&self)->u32 {self.index} fn serial(&self)->u32 {self.serial} fn class(&self)->&Class {&self.class}
 fn get_property_by_name(&self,_:&str)->Result<&FieldValue,()> {Ok(&self.handle)}
}
#[derive(Debug)] enum EntityError { HandleNotFound(usize) }
struct Entities(Vec<Entity>);
impl Entities {
 fn get_by_index(&self,index:usize)->Result<&Entity,EntityError> {self.0.iter().find(|e|e.index as usize==index).ok_or(EntityError::HandleNotFound(index))}
 fn iter(&self)->impl Iterator<Item=&Entity> {self.0.iter()}
 // SOURCE2_LOOKUP
}
struct Context(Entities); impl Context {fn entities(&self)->&Entities {&self.0}}
#[derive(Default)] struct Collector {pawn_to_steam:HashMap<u32,String>,shots:Vec<(u32,f64,f64,f64,Option<String>)>}
struct GameEvent { handle:Option<i32> }
fn ev_i32(ge:&GameEvent,_:&str)->Option<i32>{ge.handle}
fn ev_str<'a>(_:&'a GameEvent,_:&str)->Option<&'a str>{Some("ak47")}
fn prop_u64(e:&Entity,_:&str)->u64 {e.steam}
fn world_coord(e:&Entity,_:&str,_:&str)->f64 {e.x}
fn pawn_yaw(e:&Entity)->f64 {e.x}
fn round1(x:f64)->f64{x}
// IDENTITY_HELPERS
impl Collector {
 fn fire(&mut self,ctx:&Context,ge:&GameEvent)->Result<(),()> {let tick=100;
 // WEAPON_FIRE
 Ok(()) }
}
fn fixture(serial:u32,class:&'static str,bindings:&[(u32,u64)])->(Collector,Context) {
 let mut c=Collector::default();c.pawn_to_steam.insert(134,"111".into());
 let mut entities=vec![Entity{index:134,serial,class:Class(class),handle:FieldValue::Unsigned32(0),steam:0,x:42.0}];
 for (i,(handle,steam)) in bindings.iter().enumerate(){entities.push(Entity{index:9+i as u32,serial:1,class:Class("CCSPlayerController"),handle:FieldValue::Unsigned32(*handle),steam:*steam,x:99.0});}
 (c,Context(Entities(entities)))
}
const NATIVE:i32=(3<<15)|134; const PACKED:u32=(3<<14)|134;
fn fire(c:&mut Collector,ctx:&Context,handle:Option<i32>){c.fire(ctx,&GameEvent{handle}).unwrap();}
#[test] fn valid_shot_uses_same_pawn_geometry(){let(mut c,ctx)=fixture(3,"CCSPlayerPawn",&[(PACKED,111)]);fire(&mut c,&ctx,Some(NATIVE));assert_eq!(c.shots,vec![(100,42.0,42.0,42.0,Some("111".into()))]);}
#[test] fn rejects_recycled_index_and_its_geometry(){let(mut c,ctx)=fixture(4,"CCSPlayerPawn",&[((4<<14)|134,222)]);fire(&mut c,&ctx,Some(NATIVE));assert!(c.shots.is_empty(),"stale event must not draw replacement pawn or use cached owner: {:?}",c.shots);}
#[test] fn current_owner_replaces_tick_start_owner(){let(mut c,ctx)=fixture(3,"CCSPlayerPawn",&[(PACKED,222)]);fire(&mut c,&ctx,Some(NATIVE));assert_eq!(c.shots[0].4.as_deref(),Some("222"));assert_eq!(c.shots[0].1,42.0);}
#[test] fn unbound_owner_keeps_valid_geometry_but_no_cached_actor(){let(mut c,ctx)=fixture(3,"CCSPlayerPawn",&[]);fire(&mut c,&ctx,Some(NATIVE));assert_eq!(c.shots,vec![(100,42.0,42.0,42.0,None)]);}
#[test] fn conflicting_or_invalid_owner_is_unknown(){for bindings in [vec![(PACKED,111),(PACKED,222)],vec![(PACKED,111),(PACKED,111)],vec![(PACKED,0)],vec![(PACKED,u64::MAX)],vec![(PACKED+16384,222)]]{let(mut c,ctx)=fixture(3,"CCSPlayerPawn",&bindings);fire(&mut c,&ctx,Some(NATIVE));assert_eq!(c.shots,vec![(100,42.0,42.0,42.0,None)]);}}
#[test] fn non_pawn_never_emits_geometry(){let(mut c,ctx)=fixture(3,"CCSObserverPawn",&[(PACKED,111)]);fire(&mut c,&ctx,Some(NATIVE));assert!(c.shots.is_empty());}
#[test] fn invalid_or_missing_native_handle_never_emits_geometry(){for handle in [None,Some(-1),Some(0x4000|134),Some(0x7fff)]{let(mut c,ctx)=fixture(3,"CCSPlayerPawn",&[(PACKED,111)]);fire(&mut c,&ctx,handle);assert!(c.shots.is_empty());}}

#[test] fn successive_events_observe_rebind_and_unbind_without_cache_refresh(){
 let(mut c,mut ctx)=fixture(3,"CCSPlayerPawn",&[(PACKED,111)]);fire(&mut c,&ctx,Some(NATIVE));
 ctx.0.0[1].steam=222;ctx.0.0[0].x=77.0;fire(&mut c,&ctx,Some(NATIVE));
 ctx.0.0.pop();fire(&mut c,&ctx,Some(NATIVE));
 assert_eq!(c.shots,vec![(100,42.0,42.0,42.0,Some("111".into())),(100,77.0,77.0,77.0,Some("222".into())),(100,77.0,77.0,77.0,None)]);
}
#[test] fn signed_native_and_only_network_serial_bits_are_validated(){
 let packed=16089222;let(mut c,ctx)=fixture(982+1024,"CCSPlayerPawn",&[(packed,222)]);
 fire(&mut c,&ctx,Some(-269811578));assert_eq!(c.shots[0].4.as_deref(),Some("222"));
}
