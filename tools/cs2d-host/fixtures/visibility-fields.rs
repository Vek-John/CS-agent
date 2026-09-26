// Read-only field availability probe. Spotted network flags are NOT LOS,
// player perception, radar visibility, or coaching evidence. No identities,
// coordinates, raw masks, or per-tick arrays leave this process.
use source2_demo::prelude::*;
use serde_json::json;
use std::{cell::RefCell, rc::Rc};

const PATHS: [&str; 6] = [
    "m_entitySpottedState.m_bSpotted",
    "m_entitySpottedState.m_bSpottedByMask.0000",
    "m_entitySpottedState.m_bSpottedByMask.0001",
    "m_bSpotted",
    "m_bSpottedByMask.0000",
    "m_bSpottedByMask.0001",
];
#[derive(Default, Clone)]
struct Count { zero: u64, nonzero: u64, missing: u64, wrong_type: u64 }
#[derive(Default)]
struct Probe { sampled_ticks: u64, pawns: u64, fields: [Count; 6] }
#[observer]
#[uses_all]
impl Probe {
    #[on_tick_end]
    fn tick(&mut self, ctx: &Context) -> ObserverResult {
        if ctx.tick() == u32::MAX || ctx.tick() % 8 != 0 { return Ok(()); }
        self.sampled_ticks += 1;
        for pawn in ctx.entities().iter().filter(|e| e.class().name() == "CCSPlayerPawn") {
            self.pawns += 1;
            for (index, path) in PATHS.iter().enumerate() {
                let count = &mut self.fields[index];
                #[allow(deprecated)]
                match pawn.get_property_by_name(path) {
                    Ok(FieldValue::Boolean(value)) if index % 3 == 0 => {
                        if *value { count.nonzero += 1; } else { count.zero += 1; }
                    }
                    Ok(FieldValue::Unsigned32(value)) if index % 3 != 0 => {
                        if *value != 0 { count.nonzero += 1; } else { count.zero += 1; }
                    }
                    Ok(_) => count.wrong_type += 1,
                    Err(_) => count.missing += 1,
                }
            }
        }
        Ok(())
    }
}
fn report(p: &Probe, phase: &str) {
    println!("{}", json!({"phase": phase, "sampleStrideTicks": 8, "sampledTicks": p.sampled_ticks,
        "pawnSamples": p.pawns, "fields": PATHS.iter().zip(p.fields.iter()).map(|(path,c)|
        json!({"path":path,"zero":c.zero,"nonzero":c.nonzero,"missing":c.missing,"wrongType":c.wrong_type})).collect::<Vec<_>>() }));
}
fn main() {
    let bytes = std::fs::read(std::env::args().nth(1).expect("Demo path required")).unwrap();
    let mut parser = Parser::from_slice(&bytes).unwrap();
    let probe: Rc<RefCell<Probe>> = parser.register_observer::<Probe>();
    parser.run_to_tick(1024).unwrap();
    report(&probe.borrow(), "smoke");
    if !probe.borrow().fields.iter().any(|c| c.zero + c.nonzero > 0) { return; }
    parser.run_to_end().unwrap();
    report(&probe.borrow(), "complete");
}
