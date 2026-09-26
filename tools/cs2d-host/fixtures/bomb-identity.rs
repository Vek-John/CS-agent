// Synthetic entity lifecycle. Numbers are fixture time, never measured Demo ticks.
// Production Bomb body, BombKind, identity helpers and vendor lookup are injected.
use std::collections::HashMap;

#[derive(Clone)] struct Class(&'static str);
impl Class { fn name(&self) -> &str { self.0 } }
#[derive(Clone)] enum FieldValue { Unsigned32(u32) }
#[derive(Clone)] struct Entity {
    index: u32, serial: u32, class: Class, handle: FieldValue, steam: u64, x: f64,
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
#[derive(Clone, Copy, Debug, PartialEq)]
// BOMB_KIND
#[derive(Debug, PartialEq)]
enum RawEvent {
    Bomb { tick: u32, kind: BombKind, player: Option<String>, x: Option<f64>, y: Option<f64>, z: Option<f64> },
}
#[derive(Default)] struct Collector {
    pawn_to_steam: HashMap<u32, String>, events: Vec<RawEvent>, defuse_ends: Vec<(u32, bool)>,
}
struct GameEvent { handle: Option<i32> }
fn ev_i32(ge: &GameEvent, _: &str) -> Option<i32> { ge.handle }
fn prop_u64(e: &Entity, _: &str) -> u64 { e.steam }
fn world_coord(e: &Entity, _: &str, _: &str) -> f64 { e.x }
fn round1(x: f64) -> f64 { x }
// IDENTITY_HELPERS
impl Collector {
    fn bomb(&mut self, ctx: &Context, ge: &GameEvent, name: &str, tick: u32) {
        // BOMB_EVENT
    }
}
const NATIVE: i32 = (3 << 15) | 134;
const PACKED: u32 = (3 << 14) | 134;
const EVENTS: [(&str, BombKind); 3] = [
    ("bomb_planted", BombKind::Planted), ("bomb_defused", BombKind::Defused), ("bomb_exploded", BombKind::Exploded),
];
fn fixture(serial: u32, class: &'static str, bindings: &[(u32, u64)]) -> (Collector, Context) {
    let mut c = Collector::default();
    c.pawn_to_steam.insert(134, "111".into()); // Deliberately stale tick-start owner.
    let mut entities = vec![Entity { index: 134, serial, class: Class(class), handle: FieldValue::Unsigned32(0), steam: 0, x: 42.0 }];
    for (i, (handle, steam)) in bindings.iter().enumerate() {
        entities.push(Entity { index: 9 + i as u32, serial: 1, class: Class("CCSPlayerController"),
            handle: FieldValue::Unsigned32(*handle), steam: *steam, x: 99.0 });
    }
    (c, Context(Entities(entities)))
}
fn expected(kind: BombKind, player: Option<&str>, coordinate: Option<f64>) -> RawEvent {
    RawEvent::Bomb { tick: 100, kind, player: player.map(str::to_owned), x: coordinate, y: coordinate, z: coordinate }
}
fn emit(c: &mut Collector, ctx: &Context, name: &str, handle: Option<i32>) {
    c.bomb(ctx, &GameEvent { handle }, name, 100);
}
fn assert_unknown_events(c: &mut Collector, ctx: &Context, handle: Option<i32>) {
    for (name, kind) in EVENTS {
        emit(c, ctx, name, handle);
        assert_eq!(c.events.last(), Some(&expected(kind, None, None)), "public event survives, stale actor/geometry must not");
    }
    assert_eq!(c.events.len(), 3);
    assert_eq!(c.defuse_ends, vec![(100, true)]);
}

#[test] fn valid_plant_preserves_owner_and_geometry() {
    let (mut c, ctx) = fixture(3, "CCSPlayerPawn", &[(PACKED, 111)]);
    emit(&mut c, &ctx, "bomb_planted", Some(NATIVE));
    assert_eq!(c.events, vec![expected(BombKind::Planted, Some("111"), Some(42.0))]);
    assert!(c.defuse_ends.is_empty());
}
#[test] fn recycled_serial_preserves_public_events_without_replacement_geometry() {
    let (mut c, ctx) = fixture(4, "CCSPlayerPawn", &[((4 << 14) | 134, 222)]);
    assert_unknown_events(&mut c, &ctx, Some(NATIVE));
}
#[test] fn wrong_entity_class_preserves_public_events_without_geometry() {
    let (mut c, ctx) = fixture(3, "CCSObserverPawn", &[(PACKED, 111)]);
    assert_unknown_events(&mut c, &ctx, Some(NATIVE));
}
#[test] fn invalid_or_missing_native_preserves_public_events_and_defuse_end() {
    for handle in [None, Some(-1), Some(0x4000 | 134), Some(0x7fff), Some(0xffffff)] {
        let (mut c, ctx) = fixture(3, "CCSPlayerPawn", &[(PACKED, 111)]);
        assert_unknown_events(&mut c, &ctx, handle);
    }
}
#[test] fn current_owner_replaces_tick_start_cached_owner() {
    let (mut c, ctx) = fixture(3, "CCSPlayerPawn", &[(PACKED, 222)]);
    emit(&mut c, &ctx, "bomb_planted", Some(NATIVE));
    assert_eq!(c.events, vec![expected(BombKind::Planted, Some("222"), Some(42.0))]);
}
#[test] fn valid_unbound_pawn_keeps_plant_geometry_only() {
    for bindings in [vec![], vec![(PACKED, 0)], vec![(PACKED, u64::MAX)], vec![(PACKED, 111), (PACKED, 222)],
        vec![(PACKED, 111), (PACKED, 111)], vec![(PACKED + 16384, 222)]] {
        let (mut c, ctx) = fixture(3, "CCSPlayerPawn", &bindings);
        emit(&mut c, &ctx, "bomb_planted", Some(NATIVE));
        assert_eq!(c.events, vec![expected(BombKind::Planted, None, Some(42.0))]);
    }
}
#[test] fn defuse_and_explosion_never_emit_coordinates() {
    let (mut c, ctx) = fixture(3, "CCSPlayerPawn", &[(PACKED, 222)]);
    for (name, kind) in &EVENTS[1..] {
        emit(&mut c, &ctx, name, Some(NATIVE));
        assert_eq!(c.events.last(), Some(&expected(*kind, Some("222"), None)));
    }
    assert_eq!(c.defuse_ends, vec![(100, true)]);
}
#[test] fn same_tick_events_observe_rebind_unbind_and_current_geometry() {
    let (mut c, mut ctx) = fixture(3, "CCSPlayerPawn", &[(PACKED, 111)]);
    emit(&mut c, &ctx, "bomb_planted", Some(NATIVE));
    ctx.0.0[1].steam = 222; ctx.0.0[0].x = 77.0;
    emit(&mut c, &ctx, "bomb_planted", Some(NATIVE));
    ctx.0.0.pop();
    emit(&mut c, &ctx, "bomb_defused", Some(NATIVE));
    emit(&mut c, &ctx, "bomb_planted", Some(NATIVE));
    assert_eq!(c.events, vec![expected(BombKind::Planted, Some("111"), Some(42.0)),
        expected(BombKind::Planted, Some("222"), Some(77.0)), expected(BombKind::Defused, None, None),
        expected(BombKind::Planted, None, Some(77.0))]);
    assert_eq!(c.defuse_ends, vec![(100, true)]);
}
#[test] fn signed_native_matches_only_serial_bits_carried_on_wire() {
    let (mut c, ctx) = fixture(982 + 1024, "CCSPlayerPawn", &[(16089222, 222)]);
    emit(&mut c, &ctx, "bomb_planted", Some(-269811578));
    assert_eq!(c.events, vec![expected(BombKind::Planted, Some("222"), Some(42.0))]);
}
#[test] fn missing_current_pawn_does_not_remove_public_events() {
    let (mut c, mut ctx) = fixture(3, "CCSPlayerPawn", &[(PACKED, 111)]);
    ctx.0.0.remove(0);
    assert_unknown_events(&mut c, &ctx, Some(NATIVE));
}
