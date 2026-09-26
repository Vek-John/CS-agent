// Synthetic entity resources and times; no measured Demo ticks or decoding claim.
use std::collections::{HashMap, HashSet};
#[derive(Clone)] struct Class(&'static str);
impl Class { fn name(&self) -> &str { self.0 } }
#[derive(Clone)] enum FieldValue { Unsigned32(u32), Unsigned64(u64), Unsigned16(u16), Unsigned8(u8), Signed32(i32), Signed16(i16), Signed8(i8), Boolean(bool) }
#[derive(Clone)] struct Entity { index: u32, serial: u32, class: Class, values: HashMap<&'static str, FieldValue>, coordinate: f64, weapon: &'static str }
impl Entity {
    fn index(&self) -> u32 { self.index } fn serial(&self) -> u32 { self.serial } fn class(&self) -> &Class { &self.class }
    fn get_property_by_name(&self, key: &str) -> Result<&FieldValue, ()> { self.values.get(key).ok_or(()) }
}
#[derive(Debug)] enum EntityError { HandleNotFound(usize) }
struct Entities(Vec<Entity>);
impl Entities {
    fn get_by_index(&self, index: usize) -> Result<&Entity, EntityError> { self.0.iter().find(|e| e.index as usize == index).ok_or(EntityError::HandleNotFound(index)) }
    fn iter(&self) -> impl Iterator<Item=&Entity> { self.0.iter() }
    // SOURCE2_LOOKUP
}
struct Context(Entities); impl Context { fn entities(&self) -> &Entities { &self.0 } }
type RoundClockSample = ();
// RAW_FRAME
// STATE_TYPES
mod weapon_ammo {
    use super::*;
    pub struct WeaponAmmo;
    pub struct Identity;
    impl Identity { pub fn handle(&self) -> u32 { 1 } }
    pub fn frame_weapon_identity(_: &Context, _: &Entity, _: &str) -> Option<Identity> { None }
}
#[derive(Default)] struct AmmoCache;
impl AmmoCache { fn for_frame(&self, _: u32, _: &str, _: Option<&weapon_ammo::Identity>) -> Option<weapon_ammo::WeaponAmmo> { None } }
#[derive(Default)] struct Collector { frames: Vec<RawFrame>, meta: HashMap<String, PlayerMeta>, meta_order: Vec<String>, last_cap: u32, ammo_cache: AmmoCache }
fn active_weapon_label(_: &Context, pawn: &Entity) -> String { pawn.weapon.into() }
fn primary_weapon(_: &Context, _: &Entity) -> String { "AK-47".into() }
fn grenade_inventory(_: &Context, _: &Entity) -> Vec<String> { vec![] }
fn world_coord(pawn: &Entity, _: &str, _: &str) -> f64 { pawn.coordinate }
fn pawn_yaw(_: &Entity) -> f64 { 0.0 }
fn round1(value: f64) -> f64 { value }
fn ev_name(ctrl: &Entity) -> String { format!("player-{}", ctrl.index) }
fn prop_bool(_: &Entity, _: &str) -> bool { false }
fn prop_string(_: &Entity, _: &str) -> String { "fixture".into() }
// IDENTITY_HELPERS
impl Collector {
    fn sample(&mut self, ctx: &Context, tick: u32) -> Result<(), ()> {
        // FRAME_SAMPLE
        Ok(())
    }
}
fn respawn(c: &Collector, lo: u32, hi: u32) -> Option<u32> {
    c.frames.iter().find(|f| {
        // RESPAWN_PREDICATE
    }).map(|f| f.tick)
}
fn knife_round(c: &Collector) -> bool {
    // KNIFE_ROUND
}
const DEMO_TICK_RATE: f64 = 64.0;
struct Round { freeze_start_tick: u32, start_tick: u32, ct_name: String, t_name: String }
fn knife_split(c: &Collector) -> Option<(u32,u32,String,String)> {
    let rounds = vec![Round { freeze_start_tick: 0, start_tick: 1000, ct_name: "CT".into(), t_name: "T".into() }];
    // KNIFE_SPLIT
}
fn packed(index: u32, serial: u32) -> u32 { index | (serial << 14) }
fn fixture() -> (Collector, Context) {
    let mut entities = Vec::new();
    for i in 0..2u32 {
        let mut values = HashMap::from([("m_iTeamNum", FieldValue::Signed32(2)), ("m_iHealth", FieldValue::Signed32(100)), ("m_lifeState", FieldValue::Signed32(0)), ("m_ArmorValue", FieldValue::Signed32(20 + i as i32))]);
        entities.push(Entity { index: 134 + i, serial: 3 + i, class: Class("CCSPlayerPawn"), values: values.clone(), coordinate: 42.0 + i as f64 * 100.0, weapon: "Faca" });
        values.insert("m_hPlayerPawn", FieldValue::Unsigned32(packed(134 + i, 3 + i)));
        values.insert("m_steamID", FieldValue::Unsigned64(111 + i as u64));
        entities.push(Entity { index: 9 + i, serial: 1, class: Class("CCSPlayerController"), values, coordinate: 999.0, weapon: "Faca" });
    }
    (Collector::default(), Context(Entities(entities)))
}
fn sample(c: &mut Collector, ctx: &Context, tick: u32) { c.sample(ctx, tick).unwrap(); }
fn has(c: &Collector, id: &str) -> bool { c.frames.last().unwrap().players.iter().any(|p| p.steam_id == id) }

#[test] fn valid_network_handle_preserves_identity_geometry_and_resources() {
    let (mut c, ctx) = fixture(); sample(&mut c, &ctx, 100);
    let p = &c.frames[0].players[0]; assert_eq!((&p.steam_id, p.x, p.health, p.armor), (&"111".to_owned(), 42.0, 100, 20));
    assert_eq!(c.frames[0].players.len(), 2); assert_eq!(respawn(&c, 0, 200), Some(100));
}
#[test] fn stale_serial_and_wrong_class_never_attribute_replacement_fields() {
    for mode in 0..2 { let (mut c, mut ctx) = fixture();
        if mode == 0 { ctx.0.0[0].serial = 4; } else { ctx.0.0[0].class = Class("CCSObserverPawn"); }
        ctx.0.0[0].coordinate = 888.0; sample(&mut c, &ctx, 100);
        assert!(!has(&c, "111")); assert!(has(&c, "112")); assert_eq!(c.frames[0].tick, 100);
    }
}
#[test] fn missing_wrong_type_and_invalid_network_handles_do_not_sample() {
    for handle in [None, Some(FieldValue::Signed32(packed(134,3) as i32)), Some(FieldValue::Unsigned32(0)), Some(FieldValue::Unsigned32(0xffffff)), Some(FieldValue::Unsigned32(u32::MAX)), Some(FieldValue::Unsigned32(packed(134,3) | (1<<24)))] {
        let (mut c, mut ctx) = fixture(); ctx.0.0[1].values.remove("m_hPlayerPawn");
        if let Some(value) = handle { ctx.0.0[1].values.insert("m_hPlayerPawn", value); }
        sample(&mut c, &ctx, 100); assert!(!has(&c, "111"));
    }
    let (mut c, mut ctx) = fixture(); ctx.0.0.remove(0); sample(&mut c, &ctx, 100); assert!(!has(&c, "111"));
}
#[test] fn ambiguous_current_controller_binding_is_unknown() {
    for same_owner in [true, false] { let (mut c, mut ctx) = fixture();
        let mut duplicate = ctx.0.0[1].clone(); duplicate.index = 12;
        if !same_owner { duplicate.values.insert("m_steamID", FieldValue::Unsigned64(333)); }
        ctx.0.0.push(duplicate); sample(&mut c, &ctx, 100);
        assert!(!has(&c, "111")); assert!(!has(&c, "333")); assert!(has(&c, "112"));
    }
}
#[test] fn invalid_owner_is_not_a_player_identity() {
    for steam in [0, u64::MAX] { let (mut c, mut ctx) = fixture(); ctx.0.0[1].values.insert("m_steamID", FieldValue::Unsigned64(steam));
        sample(&mut c, &ctx, 100); assert_eq!(c.frames[0].players.len(), 1);
    }
}
#[test] fn dead_but_current_pawn_remains_a_player_sample() {
    let (mut c, mut ctx) = fixture(); ctx.0.0[0].values.insert("m_lifeState", FieldValue::Signed32(1)); ctx.0.0[0].values.insert("m_iHealth", FieldValue::Signed32(0));
    sample(&mut c, &ctx, 100); assert!(has(&c, "111")); assert!(!c.frames[0].players[0].alive); assert_eq!(respawn(&c,0,200),None);
}
#[test] fn same_tick_rebind_samples_current_binding_without_cached_owner() {
    let (mut c, mut ctx) = fixture(); sample(&mut c, &ctx, 100);
    ctx.0.0[0].serial = 4; ctx.0.0[0].coordinate = 77.0;
    ctx.0.0[1].values.insert("m_hPlayerPawn", FieldValue::Unsigned32(packed(134,4))); ctx.0.0[1].values.insert("m_steamID", FieldValue::Unsigned64(444));
    sample(&mut c, &ctx, 100); assert!(has(&c,"444")); assert!(!has(&c,"111")); assert_eq!(c.frames[1].players[0].x,77.0);
    ctx.0.0[1].values.insert("m_hPlayerPawn", FieldValue::Unsigned32(packed(134,3))); sample(&mut c,&ctx,100); assert!(!has(&c,"444"));
}
#[test] fn incomplete_frame_cannot_advance_respawn_freeze_boundary() {
    let (mut c, mut ctx) = fixture(); ctx.0.0[0].serial = 4; sample(&mut c,&ctx,100);
    ctx.0.0[1].values.insert("m_hPlayerPawn", FieldValue::Unsigned32(packed(134,4))); sample(&mut c,&ctx,200);
    assert_eq!(respawn(&c,0,300),Some(200));
}
#[test] fn incomplete_frame_cannot_classify_an_all_knife_round() {
    let (mut c, mut ctx) = fixture(); ctx.0.0[0].serial = 4; sample(&mut c,&ctx,100); assert!(!knife_round(&c));
    let (mut complete, ctx) = fixture(); sample(&mut complete,&ctx,100); assert!(knife_round(&complete));
}
#[test] fn incomplete_knife_window_cannot_split_a_round() {
    for incomplete in [false,true] { let (mut c, mut ctx) = fixture();
        if incomplete { ctx.0.0[0].serial=4; }
        sample(&mut c,&ctx,100); sample(&mut c,&ctx,500);
        let serial = ctx.0.0[0].serial;
        ctx.0.0[1].values.insert("m_hPlayerPawn",FieldValue::Unsigned32(packed(134,serial)));
        ctx.0.0[0].weapon="AK-47"; sample(&mut c,&ctx,600);
        assert_eq!(knife_split(&c).is_some(),!incomplete);
    }
}
