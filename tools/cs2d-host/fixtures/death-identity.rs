// Synthetic lifecycle, not measured Demo ticks or a test of coordinate decoding.
// Actual player_death body, Kill shape, props helpers and vendor lookup are injected.
use std::collections::HashMap;

#[derive(Clone)] struct Class(&'static str);
impl Class { fn name(&self) -> &str { self.0 } }
#[derive(Clone)] enum FieldValue { Unsigned32(u32) }
#[derive(Clone)] struct Entity {
    index: u32, serial: u32, class: Class, handle: FieldValue, steam: u64, coords: [f64; 3], alive: bool,
}
impl Entity {
    fn index(&self) -> u32 { self.index }
    fn serial(&self) -> u32 { self.serial }
    fn class(&self) -> &Class { &self.class }
    fn get_property_by_name(&self, _: &str) -> Result<&FieldValue, ()> { Ok(&self.handle) }
}
#[derive(Debug)] enum EntityError { HandleNotFound(usize) }
struct Entities(Vec<Entity>);
impl Entities {
    fn get_by_index(&self, index: usize) -> Result<&Entity, EntityError> {
        self.0.iter().find(|e| e.index as usize == index).ok_or(EntityError::HandleNotFound(index))
    }
    fn iter(&self) -> impl Iterator<Item = &Entity> { self.0.iter() }
    // SOURCE2_LOOKUP
}
struct Context(Entities);
impl Context { fn entities(&self) -> &Entities { &self.0 } }
#[derive(Debug, PartialEq)] enum RawEvent {
    // KILL_VARIANT
}
#[derive(Default)] struct Collector { pawn_to_steam: HashMap<u32, String>, events: Vec<RawEvent> }
struct GameEvent { victim: Option<i32>, attacker: Option<i32>, assister: Option<i32>, headshot: bool, flash: bool }
fn ev_i32(ge: &GameEvent, field: &str) -> Option<i32> {
    match field { "userid_pawn" => ge.victim, "attacker_pawn" => ge.attacker, "assister_pawn" => ge.assister, _ => None }
}
fn ev_bool(ge: &GameEvent, field: &str) -> bool { match field { "headshot" => ge.headshot, "assistedflash" => ge.flash, _ => false } }
fn ev_str(_: &GameEvent, _: &str) -> Option<String> { Some("ak47".into()) }
fn prop_u64(e: &Entity, _: &str) -> u64 { e.steam }
fn world_coord(e: &Entity, _: &str, vec: &str) -> f64 {
    e.coords[match vec { "CBodyComponent.m_vecX" => 0, "CBodyComponent.m_vecY" => 1, "CBodyComponent.m_vecZ" => 2, _ => panic!("unexpected coordinate field") }]
}
fn round1(x: f64) -> f64 { x }
// IDENTITY_HELPERS
impl Collector {
    fn death(&mut self, ctx: &Context, ge: &GameEvent) -> Result<(), ()> {
        let tick = 100;
        // PLAYER_DEATH
        Ok(())
    }
}
fn packed(index: u32, serial: u32) -> u32 { index | (serial << 14) }
fn native(index: u32, serial: u32) -> i32 { (index | (serial << 15)) as i32 }
fn fixture() -> (Collector, Context, GameEvent) {
    let mut c = Collector::default(); let mut entities = Vec::new();
    for (i, steam) in [111, 222, 333].into_iter().enumerate() {
        let index = 134 + i as u32; let serial = 3 + i as u32;
        c.pawn_to_steam.insert(index, steam.to_string());
        let scale = 10f64.powi(i as i32 + 1);
        entities.push(Entity { index, serial, class: Class("CCSPlayerPawn"), handle: FieldValue::Unsigned32(0), steam: 0,
            coords: [scale, scale * 2.0, scale * 3.0], alive: i != 0 });
    }
    for (i, steam) in [111, 222, 333].into_iter().enumerate() {
        entities.push(Entity { index: 9 + i as u32, serial: 1, class: Class("CCSPlayerController"),
            handle: FieldValue::Unsigned32(packed(134 + i as u32, 3 + i as u32)), steam, coords: [999.0; 3], alive: true });
    }
    (c, Context(Entities(entities)), GameEvent { victim: Some(native(134, 3)), attacker: Some(native(135, 4)),
        assister: Some(native(136, 5)), headshot: true, flash: true })
}
fn expected(victim: &str, attacker: Option<&str>, assister: Option<&str>, coords: [f64; 3]) -> RawEvent {
    RawEvent::Kill { tick: 100, victim: victim.into(), attacker: attacker.map(str::to_owned), assister: assister.map(str::to_owned),
        weapon: "ak47".into(), headshot: true, assisted_flash: true, x: coords[0], y: coords[1], z: coords[2] }
}
fn emit(c: &mut Collector, ctx: &Context, ge: &GameEvent) { c.death(ctx, ge).unwrap(); }

#[test] fn valid_dead_victim_keeps_all_fields_and_its_own_geometry() {
    let (mut c, ctx, ge) = fixture(); assert!(!ctx.0.0[0].alive);
    emit(&mut c, &ctx, &ge);
    assert_eq!(c.events, vec![expected("111", Some("222"), Some("333"), [10.0, 20.0, 30.0])]);
}
#[test] fn recycled_or_wrong_class_victim_never_emits_a_kill() {
    for wrong_class in [false, true] {
        let (mut c, mut ctx, ge) = fixture();
        if wrong_class { ctx.0.0[0].class = Class("CCSObserverPawn"); }
        else { ctx.0.0[0].serial = 4; ctx.0.0[3].handle = FieldValue::Unsigned32(packed(134, 4)); }
        emit(&mut c, &ctx, &ge); assert!(c.events.is_empty());
    }
}
#[test] fn absent_or_invalid_victim_never_uses_cached_identity() {
    for handle in [None, Some(-1), Some(0x4000 | 134), Some(0x7fff), Some(0xffffff)] {
        let (mut c, ctx, mut ge) = fixture(); ge.victim = handle;
        emit(&mut c, &ctx, &ge); assert!(c.events.is_empty());
    }
    let (mut c, mut ctx, ge) = fixture(); ctx.0.0.remove(0);
    emit(&mut c, &ctx, &ge); assert!(c.events.is_empty());
}
#[test] fn unknown_or_duplicate_victim_owner_preserves_nonnullable_protocol_by_skipping() {
    for mode in 0..6 {
        let (mut c, mut ctx, ge) = fixture();
        match mode {
            0 => { ctx.0.0.remove(3); },
            1 => ctx.0.0[3].steam = 0,
            2 => ctx.0.0[3].steam = u64::MAX,
            3 | 4 => { let mut duplicate = ctx.0.0[3].clone(); duplicate.index = 12; if mode == 4 { duplicate.steam = 444; } ctx.0.0.push(duplicate); },
            _ => ctx.0.0[3].handle = FieldValue::Unsigned32(packed(134, 4)),
        }
        emit(&mut c, &ctx, &ge); assert!(c.events.is_empty(), "mode {mode}");
    }
}
#[test] fn stale_attacker_or_assister_is_null_without_losing_valid_victim() {
    for role in [1usize, 2] {
        let (mut c, mut ctx, ge) = fixture(); ctx.0.0[role].serial += 1;
        emit(&mut c, &ctx, &ge);
        assert_eq!(c.events, vec![expected("111", if role == 1 { None } else { Some("222") },
            if role == 2 { None } else { Some("333") }, [10.0, 20.0, 30.0])]);
    }
}
#[test] fn optional_roles_reject_wrong_class_missing_pawn_and_invalid_handle() {
    for role in [1usize, 2] {
        for mode in 0..4 {
            let (mut c, mut ctx, mut ge) = fixture();
            match mode {
                0 => ctx.0.0[role].class = Class("CCSObserverPawn"),
                1 => { ctx.0.0.remove(role); },
                2 => { if role == 1 { ge.attacker = Some(-1); } else { ge.assister = Some(-1); } },
                _ => { if role == 1 { ge.attacker = None; } else { ge.assister = None; } },
            }
            emit(&mut c, &ctx, &ge);
            assert_eq!(c.events, vec![expected("111", if role == 1 { None } else { Some("222") },
                if role == 2 { None } else { Some("333") }, [10.0, 20.0, 30.0])]);
        }
    }
}
#[test] fn unknown_and_duplicate_optional_owners_remain_null() {
    for role in [1usize, 2] {
        for mode in 0..4 {
            let (mut c, mut ctx, ge) = fixture(); let controller = role + 3;
            match mode {
                0 => { ctx.0.0.remove(controller); },
                1 => ctx.0.0[controller].steam = 0,
                2 => ctx.0.0[controller].steam = u64::MAX,
                _ => { let mut duplicate = ctx.0.0[controller].clone(); duplicate.index = 12; ctx.0.0.push(duplicate); },
            }
            emit(&mut c, &ctx, &ge);
            assert_eq!(c.events, vec![expected("111", if role == 1 { None } else { Some("222") },
                if role == 2 { None } else { Some("333") }, [10.0, 20.0, 30.0])]);
        }
    }
}
#[test] fn current_bindings_replace_all_three_cached_owners() {
    let (mut c, mut ctx, ge) = fixture();
    for (role, steam) in [444, 555, 666].into_iter().enumerate() { ctx.0.0[role + 3].steam = steam; }
    emit(&mut c, &ctx, &ge);
    assert_eq!(c.events, vec![expected("444", Some("555"), Some("666"), [10.0, 20.0, 30.0])]);
}
#[test] fn same_tick_rebind_unbind_and_recycled_victim_use_no_old_cache() {
    let (mut c, mut ctx, ge) = fixture(); emit(&mut c, &ctx, &ge);
    ctx.0.0[3].steam = 444; ctx.0.0[4].steam = 555; ctx.0.0[0].coords = [40.0, 50.0, 60.0];
    emit(&mut c, &ctx, &ge);
    ctx.0.0.pop(); emit(&mut c, &ctx, &ge); // Assister controller gone.
    ctx.0.0[0].serial += 1; emit(&mut c, &ctx, &ge); // Stale victim event must disappear.
    assert_eq!(c.events, vec![expected("111", Some("222"), Some("333"), [10.0, 20.0, 30.0]),
        expected("444", Some("555"), Some("333"), [40.0, 50.0, 60.0]),
        expected("444", Some("555"), None, [40.0, 50.0, 60.0])]);
}
#[test] fn signed_native_victim_uses_network_serial_bits() {
    let (mut c, mut ctx, mut ge) = fixture();
    ge.victim = Some(-269811578); ctx.0.0[0].serial = 982 + 1024;
    ctx.0.0[3].handle = FieldValue::Unsigned32(16089222); ctx.0.0[3].steam = 444;
    emit(&mut c, &ctx, &ge);
    assert_eq!(c.events, vec![expected("444", Some("222"), Some("333"), [10.0, 20.0, 30.0])]);
}
