// Synthetic parent length and historical children. No Demo, network decode or
// grenade-stack quantity claim. Both old Vec and new Option keep their behavior.
#[derive(Clone)] struct Class(&'static str);
impl Class { fn name(&self) -> &str { self.0 } }
#[derive(Clone)] enum FieldValue { Unsigned32(u32), Unsigned16(u16), Signed32(i32), Boolean(bool) }
// Legacy get_iter consumer converts integers; model only the fixture variants.
impl TryFrom<&FieldValue> for usize {
    type Error = ();
    fn try_from(value: &FieldValue) -> Result<Self, ()> { match value {
        FieldValue::Unsigned32(v) => Ok(*v as usize), FieldValue::Unsigned16(v) => Ok(*v as usize),
        FieldValue::Signed32(v) => usize::try_from(*v).map_err(|_| ()), _ => Err(()),
    } }
}
#[derive(Clone)] struct Entity {
    index: u32, serial: u32, class: Class, root: Option<FieldValue>, children: Option<Vec<Option<FieldValue>>>,
}
impl Entity {
    fn index(&self) -> u32 { self.index } fn serial(&self) -> u32 { self.serial } fn class(&self) -> &Class { &self.class }
    fn get_property_by_name(&self, name: &str) -> Result<&FieldValue, ()> {
        assert_eq!(name, "m_pWeaponServices.m_hMyWeapons"); self.root.as_ref().ok_or(())
    }
    fn get_property(&self, name: &str) -> Result<&FieldValue, ()> { self.get_property_by_name(name) }
    fn get_iter(&self, name: &str) -> Result<impl Iterator<Item=Option<&FieldValue>>, ()> {
        assert_eq!(name, "m_pWeaponServices.m_hMyWeapons");
        Ok(self.children.as_ref().ok_or(())?.iter().map(Option::as_ref))
    }
}
#[derive(Debug)] enum EntityError { HandleNotFound(usize) }
struct Entities(Vec<Entity>);
impl Entities {
    fn get_by_index(&self, index: usize) -> Result<&Entity, EntityError> { self.0.iter().find(|e| e.index as usize == index).ok_or(EntityError::HandleNotFound(index)) }
    // SOURCE2_LOOKUP
}
struct Context(Entities); impl Context { fn entities(&self) -> &Entities { &self.0 } }
// WEAPON_CODE
trait InventoryResult { fn inventory_result(self) -> Option<Vec<String>>; }
impl InventoryResult for Vec<String> { fn inventory_result(self) -> Option<Vec<String>> { Some(self) } }
impl InventoryResult for Option<Vec<String>> { fn inventory_result(self) -> Option<Vec<String>> { self } }
fn read(ctx: &Context, pawn: &Entity) -> Option<Vec<String>> { grenade_inventory(ctx, pawn).inventory_result() }
fn handle(index: u32) -> Option<FieldValue> { Some(FieldValue::Unsigned32((1<<14)|index)) }
fn fixture(length: u32, children: Vec<Option<FieldValue>>) -> (Context, Entity) {
    let entities = [(40,"CSmokeGrenade"),(41,"CFlashbang"),(42,"CFlashbang"),(43,"CWeaponAK47"),(44,"CKnife"),(45,"CUnmappedClass")]
        .into_iter().map(|(index,class)| Entity { index, serial:1, class:Class(class), root:None, children:None }).collect();
    let pawn = Entity { index:134, serial:3, class:Class("CCSPlayerPawn"), root:Some(FieldValue::Unsigned32(length)), children:Some(children) };
    (Context(Entities(entities)),pawn)
}
fn labels(values: &[&str]) -> Option<Vec<String>> { Some(values.iter().map(|s|s.to_string()).collect()) }

#[test] fn complete_flash_smoke_inventory_is_a_deduplicated_type_list() {
    let (ctx,pawn)=fixture(3,vec![handle(40),handle(41),handle(42)]);
    assert_eq!(read(&ctx,&pawn),labels(&["Smoke","Flash"]));
}
#[test] fn root_shrink_ignores_valid_and_invalid_historical_tail() {
    let (ctx,mut pawn)=fixture(3,vec![handle(40),handle(41),handle(42)]);
    assert_eq!(read(&ctx,&pawn),labels(&["Smoke","Flash"]));
    pawn.root=Some(FieldValue::Unsigned32(1));
    assert_eq!(read(&ctx,&pawn),labels(&["Smoke"]));
    pawn.children.as_mut().unwrap().push(None);
    assert_eq!(read(&ctx,&pawn),labels(&["Smoke"]));
}
#[test] fn declared_zero_is_empty_even_with_old_children() {
    let (ctx,mut pawn)=fixture(0,vec![handle(41),None,Some(FieldValue::Boolean(true))]);
    assert_eq!(read(&ctx,&pawn),Some(vec![]));
    pawn.children=None; assert_eq!(read(&ctx,&pawn),Some(vec![]));
}
#[test] fn absent_wrong_type_or_overlimit_root_is_unknown() {
    for root in [None,Some(FieldValue::Signed32(1)),Some(FieldValue::Unsigned16(1)),Some(FieldValue::Boolean(true)),
        Some(FieldValue::Unsigned32(65)),Some(FieldValue::Unsigned32(u32::MAX))] {
        let (ctx,mut pawn)=fixture(1,vec![handle(40)]); pawn.root=root; assert_eq!(read(&ctx,&pawn),None);
    }
}
#[test] fn missing_or_short_current_children_are_unknown() {
    let (ctx,mut pawn)=fixture(2,vec![handle(40)]); assert_eq!(read(&ctx,&pawn),None);
    pawn.children=None; assert_eq!(read(&ctx,&pawn),None);
    pawn.children=Some(vec![]); assert_eq!(read(&ctx,&pawn),None);
}
#[test] fn partial_smoke_with_unknown_current_slot_never_becomes_complete_smoke() {
    for slot in [None,Some(FieldValue::Boolean(true)),Some(FieldValue::Unsigned16(((1<<14)|41) as u16)),
        Some(FieldValue::Signed32(((1<<14)|41) as i32))] {
        let (ctx,pawn)=fixture(2,vec![handle(40),slot]); assert_eq!(read(&ctx,&pawn),None);
    }
}
#[test] fn invalid_or_missing_entity_in_current_range_is_unknown_not_empty() {
    for h in [0,u32::MAX,0xffffff,((1<<14)|41)|(1<<24),(1<<14)|999] {
        let (ctx,pawn)=fixture(2,vec![handle(40),Some(FieldValue::Unsigned32(h))]); assert_eq!(read(&ctx,&pawn),None);
    }
}
#[test] fn stale_serial_and_unmapped_class_in_current_range_are_unknown() {
    let (mut ctx,pawn)=fixture(2,vec![handle(40),handle(41)]); ctx.0.0[1].serial=2;
    assert_eq!(read(&ctx,&pawn),None);
    let (ctx,pawn)=fixture(2,vec![handle(40),handle(45)]); assert_eq!(read(&ctx,&pawn),None);
}
#[test] fn valid_non_grenade_inventory_confirms_no_grenade_types() {
    let (ctx,pawn)=fixture(2,vec![handle(43),handle(44)]); assert_eq!(read(&ctx,&pawn),Some(vec![]));
}
#[test] fn current_rebind_and_low_ten_serial_bits_are_used() {
    let (mut ctx,mut pawn)=fixture(1,vec![handle(40)]); ctx.0.0[0].serial=2; ctx.0.0[0].class=Class("CFlashbang");
    assert_eq!(read(&ctx,&pawn),None);
    pawn.children=Some(vec![Some(FieldValue::Unsigned32((2<<14)|40))]); assert_eq!(read(&ctx,&pawn),labels(&["Flash"]));
    ctx.0.0[0].serial+=1024; assert_eq!(read(&ctx,&pawn),labels(&["Flash"]));
}
#[test] fn bounded_maximum_current_vector_remains_readable() {
    let (ctx,pawn)=fixture(64,(0..64).map(|_|handle(43)).collect()); assert_eq!(read(&ctx,&pawn),Some(vec![]));
}
