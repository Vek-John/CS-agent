// Read-only vector availability census. No identities, handles, labels or positions are printed.
use source2_demo::prelude::*;
use serde_json::json;
use std::{cell::RefCell,rc::Rc};
const ROOT:&str="m_pWeaponServices.m_hMyWeapons";
#[derive(Default)] struct Slots { total:u64,missing:u64,wrong_type:u64,invalid:u64,unresolved:u64,stale:u64,valid:u64 }
impl Slots {
 fn add(&mut self,ctx:&Context,value:Option<&FieldValue>)->bool {
  self.total+=1;
  let h=match value {None=>{self.missing+=1;return false},Some(FieldValue::Unsigned32(v))=>*v,_=>{self.wrong_type+=1;return false}};
  if h==0 || h>=0xffffff {self.invalid+=1;return false;}
  let Ok(e)=ctx.entities().get_by_index((h&0x3fff) as usize) else{self.unresolved+=1;return false;};
  if e.serial()&0x3ff != h>>14 {self.stale+=1;return false;} self.valid+=1;true
 }
 fn summary(&self)->serde_json::Value {json!({"slots":self.total,"missing":self.missing,"wrongType":self.wrong_type,"invalid":self.invalid,"unresolved":self.unresolved,"serialMismatch":self.stale,"valid":self.valid})}
}
#[derive(Default)] struct Probe {ticks:u64,pawns:u64,root_missing:u64,root_wrong_type:u64,zero_length:u64,length_over_bound:u64,list_missing:u64,too_short:u64,tail_lists:u64,tail_slots:u64,complete:u64,all:Slots,current:Slots}
#[observer]
#[uses_all]
impl Probe {
 #[on_tick_start]
 fn tick(&mut self,ctx:&Context)->ObserverResult {
  if ctx.tick()==u32::MAX || ctx.tick()%8!=0{return Ok(())} self.ticks+=1;
  for pawn in ctx.entities().iter().filter(|e|e.class().name()=="CCSPlayerPawn") {
   self.pawns+=1;
   #[allow(deprecated)]
   let length=match pawn.get_property_by_name(ROOT) {Ok(FieldValue::Unsigned32(n))=>Some(*n as usize),Ok(_)=>{self.root_wrong_type+=1;None},Err(_)=>{self.root_missing+=1;None}};
   if length==Some(0){self.zero_length+=1;} if length.is_some_and(|n|n>64){self.length_over_bound+=1;}
   let Ok(items)=pawn.get_iter(ROOT) else{self.list_missing+=1;continue;};
   let mut count=0;let mut complete=length.is_some_and(|n|n<=64);
   for item in items {self.all.add(ctx,item);if length.is_some_and(|n|count<n){complete &= self.current.add(ctx,item);}count+=1;}
   if let Some(n)=length {if count<n{self.too_short+=1;complete=false;} if count>n{self.tail_lists+=1;self.tail_slots+=(count-n) as u64;}}
   if complete{self.complete+=1;}
  } Ok(())
 }
}
fn report(p:&Probe,phase:&str){println!("{}",json!({"phase":phase,"tickStartStride":8,"ticks":p.ticks,"pawns":p.pawns,"rootMissing":p.root_missing,"rootWrongType":p.root_wrong_type,"zeroLength":p.zero_length,"lengthOver64":p.length_over_bound,"listMissing":p.list_missing,"tooShort":p.too_short,"listsWithHistoricalTail":p.tail_lists,"historicalTailSlots":p.tail_slots,"completeCurrentLists":p.complete,"allChildren":p.all.summary(),"currentPrefix":p.current.summary()}));}
fn main(){let bytes=std::fs::read(std::env::args().nth(1).expect("Demo path")).unwrap();let mut parser=Parser::from_slice(&bytes).unwrap();let probe:Rc<RefCell<Probe>>=parser.register_observer::<Probe>();parser.run_to_tick(1024).unwrap();report(&probe.borrow(),"smoke");if probe.borrow().pawns==0{return;}parser.run_to_end().unwrap();report(&probe.borrow(),"complete");}
