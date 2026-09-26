// Synthetic network handles and frame times; no measured Demo or decoder coverage.
use std::collections::HashMap;
#[derive(Clone)] struct Class(&'static str);
impl Class { fn name(&self) -> &str { self.0 } }
#[derive(Clone)] enum FieldValue { Unsigned32(u32), Unsigned16(u16), Signed32(i32), Boolean(bool) }
#[derive(Clone)] struct Entity { index: u32, serial: u32, class: Class, values: HashMap<&'static str, FieldValue> }
impl Entity {
    fn index(&self) -> u32 { self.index } fn serial(&self) -> u32 { self.serial } fn class(&self) -> &Class { &self.class }
    fn get_property_by_name(&self, key: &str) -> Result<&FieldValue, ()> { self.values.get(key).ok_or(()) }
}
#[derive(Debug)] enum EntityError { HandleNotFound(usize) }
struct Entities(Vec<Entity>);
impl Entities {
    fn get_by_index(&self, index: usize) -> Result<&Entity, EntityError> { self.0.iter().find(|e| e.index as usize == index).ok_or(EntityError::HandleNotFound(index)) }
    // SOURCE2_LOOKUP
}
struct Context(Entities); impl Context { fn entities(&self) -> &Entities { &self.0 } }
// WEAPON_CODE
const ACTIVE: &str = "m_pWeaponServices.m_hActiveWeapon";
const PACKED: u32 = (1 << 14) | 40;
fn fixture(class: &'static str) -> (Context, Entity) {
    let weapon = Entity { index: 40, serial: 1, class: Class(class), values: HashMap::new() };
    let pawn = Entity { index: 134, serial: 3, class: Class("CCSPlayerPawn"), values: HashMap::from([(ACTIVE, FieldValue::Unsigned32(PACKED))]) };
    (Context(Entities(vec![weapon])), pawn)
}
struct PlayerState { weapon: String }
struct RawFrame { tick: u32, identity_complete: bool, players: Vec<PlayerState> }
struct Collector { frames: Vec<RawFrame> }
struct Round { freeze_start_tick: u32, start_tick: u32, ct_name: String, t_name: String }
const DEMO_TICK_RATE: f64 = 64.0;
fn frame(tick: u32, ctx: &Context, pawn: &Entity) -> RawFrame {
    RawFrame { tick, identity_complete: true, players: vec![PlayerState { weapon: active_weapon_label(ctx, pawn) }] }
}
fn knife_round(c: &Collector) -> bool {
    // KNIFE_ROUND
}
fn knife_split(c: &Collector) -> Option<(u32,u32,String,String)> {
    let rounds = vec![Round { freeze_start_tick: 0, start_tick: 1000, ct_name: "CT".into(), t_name: "T".into() }];
    // KNIFE_SPLIT
}

#[test] fn valid_current_weapon_and_knife_labels_are_unchanged() {
    for (class, label) in [("CWeaponAK47", "AK-47"), ("CWeaponAWP", "AWP"), ("CKnife", "Faca"), ("CSmokeGrenade", "Smoke")] {
        let (ctx,pawn)=fixture(class); assert_eq!(active_weapon_label(&ctx,&pawn),label);
    }
}
#[test] fn stale_serial_does_not_read_the_replacement_weapon_class() {
    let (mut ctx,pawn)=fixture("CWeaponAWP"); ctx.0.0[0].serial=2;
    assert_eq!(active_weapon_label(&ctx,&pawn),"");
}
#[test] fn missing_wrong_type_and_invalid_handles_are_unknown() {
    for handle in [None, Some(FieldValue::Unsigned16(PACKED as u16)), Some(FieldValue::Signed32(PACKED as i32)),
        Some(FieldValue::Unsigned32(0)), Some(FieldValue::Unsigned32(u32::MAX)), Some(FieldValue::Unsigned32(0xffffff)),
        Some(FieldValue::Unsigned32(PACKED | (1<<24)))] {
        let (ctx,mut pawn)=fixture("CWeaponAK47"); pawn.values.remove(ACTIVE);
        if let Some(value)=handle {pawn.values.insert(ACTIVE,value);}
        assert_eq!(active_weapon_label(&ctx,&pawn),"");
    }
}
#[test] fn missing_entity_and_legitimate_unmapped_class_are_unknown() {
    let (mut ctx,pawn)=fixture("CUnmappedWeaponClass"); assert_eq!(active_weapon_label(&ctx,&pawn),"");
    ctx.0.0.clear(); assert_eq!(active_weapon_label(&ctx,&pawn),"");
}
#[test] fn same_index_rebind_uses_only_the_current_network_serial() {
    let (mut ctx,mut pawn)=fixture("CWeaponAK47"); assert_eq!(active_weapon_label(&ctx,&pawn),"AK-47");
    ctx.0.0[0].serial=2; ctx.0.0[0].class=Class("CWeaponAWP");
    assert_eq!(active_weapon_label(&ctx,&pawn),"");
    pawn.values.insert(ACTIVE,FieldValue::Unsigned32((2<<14)|40)); assert_eq!(active_weapon_label(&ctx,&pawn),"AWP");
}
#[test] fn high_entity_serial_bits_follow_the_network_low_ten_bit_contract() {
    let (mut ctx,pawn)=fixture("CWeaponAK47"); ctx.0.0[0].serial=1+1024;
    assert_eq!(active_weapon_label(&ctx,&pawn),"AK-47");
}
#[test] fn native_event_layout_is_not_an_active_weapon_network_handle() {
    let (ctx,mut pawn)=fixture("CWeaponAK47"); pawn.values.insert(ACTIVE,FieldValue::Unsigned32((1<<15)|40));
    assert_eq!(active_weapon_label(&ctx,&pawn),"");
}
#[test] fn usp_and_p2000_definition_index_disambiguation_is_preserved() {
    for (definition,label) in [(61,"USP-S"),(32,"P2000")] {
        let (mut ctx,pawn)=fixture("CWeaponHKP2000");
        ctx.0.0[0].values.insert("m_iItemDefinitionIndex",FieldValue::Unsigned16(definition));
        assert_eq!(active_weapon_label(&ctx,&pawn),label);
    }
    let (ctx,pawn)=fixture("CWeaponUSP_Silencer"); assert_eq!(active_weapon_label(&ctx,&pawn),"USP-S");
}
#[test] fn unknown_label_cannot_classify_an_all_knife_round() {
    let (ctx,mut pawn)=fixture("CKnife");
    let known=frame(100,&ctx,&pawn); assert!(knife_round(&Collector{frames:vec![known]}));
    pawn.values.remove(ACTIVE);
    let unknown=frame(100,&ctx,&pawn); assert!(unknown.players[0].weapon.is_empty());
    assert!(!knife_round(&Collector{frames:vec![unknown]}));
    let mut mixed=frame(100,&ctx,&pawn); mixed.players.push(PlayerState{weapon:"Faca".into()});
    assert!(!knife_round(&Collector{frames:vec![mixed]}));
}
#[test] fn unknown_weapon_window_cannot_create_a_knife_split() {
    for unknown in [false,true] {
        let (mut ctx,mut pawn)=fixture("CKnife"); if unknown {pawn.values.remove(ACTIVE);}
        let first=frame(100,&ctx,&pawn); let second=frame(500,&ctx,&pawn);
        pawn.values.insert(ACTIVE,FieldValue::Unsigned32(PACKED)); ctx.0.0[0].class=Class("CWeaponAK47");
        let armed=frame(600,&ctx,&pawn);
        assert_eq!(knife_split(&Collector{frames:vec![first,second,armed]}).is_some(),!unknown);
    }
}
