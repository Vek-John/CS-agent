// Diagnostic field availability only. No coordinates, IDs or event arrays leave the process.
use source2_demo::prelude::*;
use serde_json::json;
use std::{cell::RefCell, rc::Rc};
const PATHS: [&str; 6] = ["CBodyComponent.m_cellX", "CBodyComponent.m_vecX", "CBodyComponent.m_cellY", "CBodyComponent.m_vecY", "CBodyComponent.m_cellZ", "CBodyComponent.m_vecZ"];
#[derive(Default, Clone, Copy)] struct Counts { valid: u64, missing: u64, wrong_type: u64, nonfinite: u64, zero: u64 }
fn classify(value: Option<&FieldValue>, cell: bool) -> usize {
    match value {
        None => 1,
        Some(FieldValue::Unsigned16(_)) | Some(FieldValue::Unsigned8(_)) if cell => 0,
        Some(FieldValue::Float(v)) if !cell => if v.is_finite() { 0 } else { 3 },
        _ => 2,
    }
}
#[derive(Default)] struct Group { samples: u64, incomplete: u64, fields: [Counts; 6] }
impl Group {
    #[allow(deprecated)]
    fn add(&mut self, pawn: &Entity) {
        self.samples += 1; let mut incomplete = false;
        for (i, path) in PATHS.iter().enumerate() {
            let value = pawn.get_property_by_name(path).ok(); let c = &mut self.fields[i];
            match classify(value, i % 2 == 0) { 0 => c.valid += 1, 1 => {c.missing += 1; incomplete=true;}, 2 => {c.wrong_type += 1;incomplete=true;}, _ => {c.nonfinite += 1;incomplete=true;} }
            if matches!(value,Some(FieldValue::Unsigned16(0)) | Some(FieldValue::Unsigned8(0))) || matches!(value,Some(FieldValue::Float(v)) if *v==0.0) {c.zero+=1;}
        }
        self.incomplete += u64::from(incomplete);
    }
    fn summary(&self) -> serde_json::Value { json!({"samples":self.samples,"incomplete":self.incomplete,"fields":PATHS.iter().zip(self.fields.iter()).map(|(path,c)|json!({"path":path,"valid":c.valid,"missing":c.missing,"wrongType":c.wrong_type,"nonfinite":c.nonfinite,"zero":c.zero})).collect::<Vec<_>>()}) }
}
#[derive(Default)] struct Probe { ticks:u64, sampled:Group, death:Group, plant:Group, fire:Group, unresolved_events:u64 }
#[observer]
#[uses_all]
impl Probe {
    #[on_tick_start]
    fn tick(&mut self,ctx:&Context)->ObserverResult {
        if ctx.tick()==u32::MAX || ctx.tick()%8!=0 {return Ok(());} self.ticks+=1;
        for pawn in ctx.entities().iter().filter(|e| e.class().name()=="CCSPlayerPawn") {self.sampled.add(pawn);}
        Ok(())
    }
    #[on_game_event]
    fn event(&mut self,ctx:&Context,ge:&GameEvent)->ObserverResult {
        let group = match ge.name() {"player_death"=>&mut self.death,"bomb_planted"=>&mut self.plant,"weapon_fire"=>&mut self.fire,_=>return Ok(())};
        let handle:Option<i32>=ge.get_value("userid_pawn").ok().and_then(|v|v.try_into().ok());
        let Some(native)=handle.map(|v|v as u32) else {self.unresolved_events+=1;return Ok(());};
        let index=native&0x7fff;
        if native==u32::MAX || index>=0x4000 {self.unresolved_events+=1;return Ok(());}
        let Ok(pawn)=ctx.entities().get_by_index(index as usize) else {self.unresolved_events+=1;return Ok(());};
        if pawn.class().name()!="CCSPlayerPawn" || pawn.serial()&0x3ff != (native>>15)&0x3ff {self.unresolved_events+=1;return Ok(());}
        group.add(pawn); Ok(())
    }
}
fn report(p:&Probe,phase:&str) {println!("{}",json!({"phase":phase,"tickStartStride":8,"sampledTicks":p.ticks,"pawnSamples":p.sampled.summary(),"deathPawn":p.death.summary(),"plantPawn":p.plant.summary(),"firePawn":p.fire.summary(),"unresolvedEvents":p.unresolved_events}));}
fn main(){let bytes=std::fs::read(std::env::args().nth(1).expect("Demo path")).unwrap();let mut parser=Parser::from_slice(&bytes).unwrap();let probe:Rc<RefCell<Probe>>=parser.register_observer::<Probe>();parser.run_to_tick(1024).unwrap();report(&probe.borrow(),"smoke");if probe.borrow().sampled.samples==0{return;}parser.run_to_end().unwrap();report(&probe.borrow(),"complete");}
#[test] fn missing_zero_wrongtype_and_nonfinite_are_distinct(){assert_eq!(classify(None,true),1);assert_eq!(classify(Some(&FieldValue::Unsigned16(0)),true),0);assert_eq!(classify(Some(&FieldValue::Unsigned8(0)),true),0);assert_eq!(classify(Some(&FieldValue::Float(0.0)),false),0);assert_eq!(classify(Some(&FieldValue::Float(f32::NAN)),false),3);assert_eq!(classify(Some(&FieldValue::Float(f32::INFINITY)),false),3);assert_eq!(classify(Some(&FieldValue::Unsigned32(0)),true),2);assert_eq!(classify(Some(&FieldValue::Float(1.0)),true),2);}
