// Offline source-feasibility probe: actual FieldState, minimal fixture path/value types.
// This does not parse a Demo or prove property availability, identity, or freshness.
mod entity { pub mod field {
 #[derive(Clone, Debug)] pub struct FieldPath { pub path: [u16; 7], pub last: usize }
 #[derive(Clone, Debug, PartialEq)] pub enum FieldValue { Unsigned32(u32) }
}}
#[path = "../vendor/source2-demo/src/entity/field/state.rs"]
mod actual_state;
use entity::field::{FieldPath, FieldValue};
fn main() {
 let mut state = actual_state::FieldState::default();
 let first = FieldPath { path: [0; 7], last: 0 };
 let mut other = first.clone(); other.path[0] = 1;
 assert_eq!(state.get_value(&first), None);
 state.set(&first, FieldValue::Unsigned32(0));
 assert_eq!(state.get_value(&first), Some(&FieldValue::Unsigned32(0)));
 state.set(&other, FieldValue::Unsigned32(7));
 assert_eq!(state.get_value(&first), Some(&FieldValue::Unsigned32(0)));
 assert_eq!(state.clone().get_value(&first), Some(&FieldValue::Unsigned32(0)));
 println!("{{\"source\":\"actual-vendor-FieldState\",\"missingDistinctFromZero\":true,\"storedZeroPersistsWithoutNewUpdate\":true}}");
}
