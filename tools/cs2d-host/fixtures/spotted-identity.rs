// Offline research only. A mapped engine bit is NOT LOS, radar display,
// attention, or a coaching fact. No identities, positions or masks are printed.
use source2_demo::prelude::*;
use serde_json::json;
use std::{cell::RefCell, rc::Rc, collections::BTreeMap};

#[derive(Clone, Copy)]
struct Pawn { index: u32, serial: u32, player_class: bool, words: [Option<u32>; 2] }
#[derive(Clone, Copy, Debug, PartialEq)]
struct Binding { controller_entity_id: u32, packed: Option<u32>, steam: Option<u64> }

fn bit_for_controller(words: [Option<u32>; 2], controller_entity_id: u32) -> Option<bool> {
    let bit = controller_entity_id.checked_sub(1)?;
    if bit >= 64 { return None; }
    Some(words[(bit / 32) as usize]? & (1u32 << (bit % 32)) != 0)
}
fn pawn_packed(pawn: &Pawn) -> Option<u32> {
    if !pawn.player_class || pawn.index >= 0x4000 { return None; }
    let packed = pawn.index | ((pawn.serial & 0x3ff) << 14);
    (packed < 0xffffff).then_some(packed)
}
fn current_binding(id: u32, bindings: &[Binding], pawns: &[Pawn]) -> Option<Binding> {
    if !(1..=64).contains(&id) { return None; }
    let mut candidates = bindings.iter().filter(|b| b.controller_entity_id == id);
    let binding = *candidates.next()?;
    if candidates.next().is_some() { return None; }
    let packed = binding.packed?;
    let steam = binding.steam?;
    if packed >= 0xffffff || steam == 0 || steam == u64::MAX { return None; }
    if bindings.iter().filter(|b| b.packed == Some(packed)).count() != 1
        || bindings.iter().filter(|b| b.steam == Some(steam)).count() != 1 { return None; }
    let mut matches = pawns.iter().filter(|p| p.player_class && p.index == (packed & 0x3fff) && (p.serial & 0x3ff) == (packed >> 14));
    matches.next()?;
    if matches.next().is_some() { return None; }
    Some(binding)
}
#[allow(deprecated)]
fn u32_field(entity: &Entity, path: &str) -> Option<u32> {
    match entity.get_property_by_name(path) { Ok(FieldValue::Unsigned32(v)) => Some(*v), _ => None }
}
#[allow(deprecated)]
fn steam_field(entity: &Entity) -> Option<u64> {
    match entity.get_property_by_name("m_steamID") {
        Ok(FieldValue::Unsigned64(v)) => Some(*v), Ok(FieldValue::Unsigned32(v)) => Some(*v as u64), _ => None,
    }
}
#[derive(Default)]
struct Probe {
    ticks: u64, pawns: u64, controller_samples: u64, valid_bindings: u64, unknown_bindings: u64,
    missing_words: u64, set_bits: u64, resolved_pairs: u64, unknown_target: u64, unknown_observer: u64,
    self_pairs: u64, sampled_rebindings: u64, previous: BTreeMap<u32, (u32,u64)>,
}
#[observer]
#[uses_all]
impl Probe {
    #[on_tick_end]
    fn tick(&mut self, ctx: &Context) -> ObserverResult {
        if ctx.tick() == u32::MAX || ctx.tick() % 8 != 0 { return Ok(()); }
        self.ticks += 1;
        let pawns: Vec<_> = ctx.entities().iter().filter(|e| e.class().name() == "CCSPlayerPawn")
            .map(|e| Pawn { index: e.index(), serial: e.serial(), player_class: true,
                words: [u32_field(e,"m_bSpottedByMask.0000"), u32_field(e,"m_bSpottedByMask.0001")] }).collect();
        let bindings: Vec<_> = ctx.entities().iter().filter(|e| e.class().name() == "CCSPlayerController")
            .map(|e| Binding { controller_entity_id: e.index(), packed: u32_field(e,"m_hPlayerPawn"), steam: steam_field(e) }).collect();
        self.pawns += pawns.len() as u64;
        self.controller_samples += bindings.len() as u64;
        let valid: Vec<_> = bindings.iter().filter_map(|b| current_binding(b.controller_entity_id,&bindings,&pawns)).collect();
        self.valid_bindings += valid.len() as u64;
        self.unknown_bindings += (bindings.len()-valid.len()) as u64;
        let current: BTreeMap<_,_> = valid.iter().map(|b| (b.controller_entity_id,(b.packed.unwrap(),b.steam.unwrap()))).collect();
        for (id, key) in &current {
            if self.previous.get(id).is_some_and(|old| old != key) { self.sampled_rebindings += 1; }
        }
        self.previous = current; // telemetry only; never resolve a missing current binding with it
        for pawn in &pawns {
            self.missing_words += pawn.words.iter().filter(|w| w.is_none()).count() as u64;
            let target = pawn_packed(pawn).and_then(|packed| valid.iter().find(|b| b.packed == Some(packed)));
            for id in 1..=64 {
                if bit_for_controller(pawn.words,id) != Some(true) { continue; }
                self.set_bits += 1;
                let Some(target) = target else { self.unknown_target += 1; continue; };
                let Some(observer) = valid.iter().find(|b| b.controller_entity_id == id) else { self.unknown_observer += 1; continue; };
                self.resolved_pairs += 1;
                if target.steam == observer.steam { self.self_pairs += 1; }
            }
        }
        Ok(())
    }
}
fn report(p: &Probe, phase: &str) {
    println!("{}",json!({"phase":phase,"sampleStrideTicks":8,"sampledTicks":p.ticks,"pawnSamples":p.pawns,
        "controllerSamples":p.controller_samples,"validCurrentBindings":p.valid_bindings,"unknownCurrentBindings":p.unknown_bindings,
        "missingMaskWords":p.missing_words,"setBitSamples":p.set_bits,"resolvedPairSamples":p.resolved_pairs,
        "unknownTargetSamples":p.unknown_target,"unknownObserverSamples":p.unknown_observer,
        "selfPairSamples":p.self_pairs,"successiveSampleRebindings":p.sampled_rebindings}));
}
fn main() {
    let bytes=std::fs::read(std::env::args().nth(1).expect("Demo path required")).unwrap();
    let mut parser=Parser::from_slice(&bytes).unwrap();
    let probe:Rc<RefCell<Probe>>=parser.register_observer::<Probe>();
    parser.run_to_tick(1024).unwrap(); report(&probe.borrow(),"smoke");
    if probe.borrow().valid_bindings == 0 { return; }
    parser.run_to_end().unwrap(); report(&probe.borrow(),"complete");
}
#[cfg(test)]
mod tests {
    use super::*;
    fn pawn(serial:u32)->Pawn { Pawn{index:130,serial,player_class:true,words:[None,None]} }
    fn binding(id:u32, serial:u32)->Binding { Binding{controller_entity_id:id,packed:Some(130|(serial<<14)),steam:Some(101)} }
    #[test] fn word_edges_and_unknown_are_distinct() {
        for id in [1,32,33,64] { let mut words=[Some(0),Some(0)]; words[((id-1)/32) as usize]=Some(1<<((id-1)%32));
            assert_eq!(bit_for_controller(words,id),Some(true)); }
        assert_eq!(bit_for_controller([Some(0),None],1),Some(false));
        assert_eq!(bit_for_controller([Some(1),None],1),Some(true));
        assert_eq!(bit_for_controller([Some(1),None],33),None);
        for id in [0,65,u32::MAX] { assert_eq!(bit_for_controller([Some(u32::MAX);2],id),None); }
    }
    #[test] fn rebind_and_missing_use_only_current_sample() {
        let old=binding(1,3); let new=binding(1,4);
        assert_eq!(current_binding(1,&[old],&[pawn(3)]),Some(old));
        assert_eq!(current_binding(1,&[old],&[pawn(4)]),None);
        assert_eq!(current_binding(1,&[new],&[pawn(4)]),Some(new));
        assert_eq!(current_binding(1,&[],&[pawn(4)]),None);
    }
    #[test] fn wrong_class_conflicts_and_invalid_fields_stay_unknown() {
        let b=binding(1,3); let mut wrong=pawn(3); wrong.player_class=false;
        assert_eq!(current_binding(1,&[b],&[wrong]),None);
        assert_eq!(current_binding(1,&[b,binding(2,3)],&[pawn(3)]),None);
        let mut high=pawn(3); high.index += 0x4000;
        assert_eq!(pawn_packed(&high),None);
        assert_eq!(pawn_packed(&wrong),None);
        let mut other=pawn(3); other.index=131;
        assert_eq!(current_binding(1,&[b,Binding{controller_entity_id:2,packed:Some(131|(3<<14)),steam:Some(101)}],&[pawn(3),other]),None);
        for packed in [None,Some(u32::MAX),Some(0xffffff),Some(130|(1024<<14))] {
            assert_eq!(current_binding(1,&[Binding{packed,..b}],&[pawn(3)]),None);
        }
        for steam in [None,Some(0),Some(u64::MAX)] { assert_eq!(current_binding(1,&[Binding{steam,..b}],&[pawn(3)]),None); }
    }
}
