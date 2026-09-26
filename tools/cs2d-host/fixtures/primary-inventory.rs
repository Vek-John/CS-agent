// Synthetic raw vector fields; no Demo decode or physical inventory-count claim.
#[derive(Clone)] struct Class(&'static str);
impl Class { fn name(&self) -> &str { self.0 } }
#[derive(Clone)] enum FieldValue { Unsigned32(u32), Unsigned16(u16), Signed32(i32), Boolean(bool) }
impl TryFrom<&FieldValue> for usize {
    type Error = ();
    fn try_from(value: &FieldValue) -> Result<Self, ()> { match value {
        FieldValue::Unsigned32(v) => Ok(*v as usize), FieldValue::Unsigned16(v) => Ok(*v as usize),
        FieldValue::Signed32(v) => usize::try_from(*v).map_err(|_| ()), _ => Err(()),
    } }
}
#[derive(Clone)] struct Entity {
    index: u32, serial: u32, class: Class, root: Option<FieldValue>,
    children: Option<Vec<Option<FieldValue>>>, item_definition: Option<FieldValue>,
}
impl Entity {
    fn index(&self) -> u32 { self.index } fn serial(&self) -> u32 { self.serial } fn class(&self) -> &Class { &self.class }
    fn get_property_by_name(&self, name: &str) -> Result<&FieldValue, ()> {
        match name { "m_pWeaponServices.m_hMyWeapons" => self.root.as_ref().ok_or(()),
            "m_iItemDefinitionIndex" => self.item_definition.as_ref().ok_or(()), _ => panic!("unexpected property") }
    }
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
fn handle(index: u32) -> Option<FieldValue> { Some(FieldValue::Unsigned32((1<<14)|index)) }
fn fixture(length: u32, children: Vec<Option<FieldValue>>) -> (Context, Entity) {
    let entities = [(40,"CWeaponAK47"),(41,"CWeaponAWP"),(42,"CWeaponGlock"),(43,"CWeaponHKP2000"),
        (44,"CKnife"),(45,"CSmokeGrenade"),(46,"CC4"),(47,"CWeaponTaser"),(48,"CUnmappedClass")]
        .into_iter().map(|(index,class)| Entity { index, serial:1, class:Class(class), root:None, children:None,
            item_definition:Some(FieldValue::Unsigned16(32)) }).collect();
    let pawn = Entity { index:134, serial:3, class:Class("CCSPlayerPawn"), root:Some(FieldValue::Unsigned32(length)), children:Some(children), item_definition:None };
    (Context(Entities(entities)),pawn)
}

#[test] fn first_primary_wins_over_first_pistol_and_later_primary() {
    let (ctx,pawn)=fixture(4,vec![handle(42),handle(44),handle(40),handle(41)]);
    assert_eq!(primary_weapon(&ctx,&pawn),"AK-47");
    let (ctx,pawn)=fixture(2,vec![handle(41),handle(40)]); assert_eq!(primary_weapon(&ctx,&pawn),"AWP");
}
#[test] fn first_pistol_and_usp_definition_disambiguation_are_preserved() {
    let (ctx,pawn)=fixture(2,vec![handle(42),handle(43)]); assert_eq!(primary_weapon(&ctx,&pawn),"Glock-18");
    let (mut ctx,pawn)=fixture(1,vec![handle(43)]); assert_eq!(primary_weapon(&ctx,&pawn),"P2000");
    ctx.0.0[3].item_definition=Some(FieldValue::Unsigned16(61)); assert_eq!(primary_weapon(&ctx,&pawn),"USP-S");
    ctx.0.0[3].item_definition=Some(FieldValue::Unsigned32(32)); assert_eq!(primary_weapon(&ctx,&pawn),"P2000");
}
#[test] fn only_current_slots_choose_weapon_after_shrink() {
    let (ctx,mut pawn)=fixture(2,vec![handle(42),handle(40)]); assert_eq!(primary_weapon(&ctx,&pawn),"AK-47");
    pawn.root=Some(FieldValue::Unsigned32(1)); assert_eq!(primary_weapon(&ctx,&pawn),"Glock-18");
    pawn.children.as_mut().unwrap().push(None); assert_eq!(primary_weapon(&ctx,&pawn),"Glock-18");
}
#[test] fn zero_current_length_ignores_historical_primary() {
    let (ctx,mut pawn)=fixture(0,vec![handle(40)]); assert_eq!(primary_weapon(&ctx,&pawn),"");
    pawn.children=None; assert_eq!(primary_weapon(&ctx,&pawn),"");
}
#[test] fn knife_grenades_c4_and_zeus_do_not_become_primary() {
    let (ctx,pawn)=fixture(4,vec![handle(44),handle(45),handle(46),handle(47)]); assert_eq!(primary_weapon(&ctx,&pawn),"");
}
#[test] fn root_must_be_present_strict_and_bounded() {
    for root in [None,Some(FieldValue::Signed32(1)),Some(FieldValue::Unsigned16(1)),Some(FieldValue::Boolean(true)),Some(FieldValue::Unsigned32(65))] {
        let (ctx,mut pawn)=fixture(1,vec![handle(40)]); pawn.root=root; assert_eq!(primary_weapon(&ctx,&pawn),"");
    }
}
#[test] fn short_or_missing_current_vector_does_not_confirm_an_early_primary() {
    let (ctx,mut pawn)=fixture(2,vec![handle(40)]); assert_eq!(primary_weapon(&ctx,&pawn),"");
    pawn.children=None; assert_eq!(primary_weapon(&ctx,&pawn),"");
}
#[test] fn unknown_slot_before_or_after_valid_primary_invalidates_selection() {
    for slot in [None,Some(FieldValue::Boolean(true)),Some(FieldValue::Unsigned16(((1<<14)|41) as u16)),Some(FieldValue::Signed32(((1<<14)|41) as i32))] {
        for slots in [vec![slot.clone(),handle(40)],vec![handle(40),slot.clone()]] {
            let (ctx,pawn)=fixture(2,slots); assert_eq!(primary_weapon(&ctx,&pawn),"");
        }
    }
}
#[test] fn invalid_missing_and_unmapped_current_entity_invalidate_even_after_primary() {
    for h in [0,u32::MAX,0xffffff,((1<<14)|41)|(1<<24),(1<<14)|999,(1<<14)|48] {
        let (ctx,pawn)=fixture(2,vec![handle(40),Some(FieldValue::Unsigned32(h))]); assert_eq!(primary_weapon(&ctx,&pawn),"");
    }
}
#[test] fn stale_replacement_does_not_supply_primary_or_get_skipped() {
    let (mut ctx,pawn)=fixture(1,vec![handle(40)]); ctx.0.0[0].serial=2; assert_eq!(primary_weapon(&ctx,&pawn),"");
    let (mut ctx,pawn)=fixture(2,vec![handle(40),handle(41)]); ctx.0.0[1].serial=2; assert_eq!(primary_weapon(&ctx,&pawn),"");
}
#[test] fn current_rebind_and_visible_serial_bits_choose_current_weapon() {
    let (mut ctx,mut pawn)=fixture(1,vec![handle(40)]); ctx.0.0[0].serial=2; ctx.0.0[0].class=Class("CWeaponAWP");
    assert_eq!(primary_weapon(&ctx,&pawn),"");
    pawn.children=Some(vec![Some(FieldValue::Unsigned32((2<<14)|40))]); assert_eq!(primary_weapon(&ctx,&pawn),"AWP");
    ctx.0.0[0].serial+=1024; assert_eq!(primary_weapon(&ctx,&pawn),"AWP");
}
#[test] fn maximum_bounded_vector_is_checked_completely() {
    let (ctx,mut pawn)=fixture(64,(0..64).map(|_|handle(40)).collect()); assert_eq!(primary_weapon(&ctx,&pawn),"AK-47");
    pawn.children.as_mut().unwrap()[63]=None; assert_eq!(primary_weapon(&ctx,&pawn),"");
}
