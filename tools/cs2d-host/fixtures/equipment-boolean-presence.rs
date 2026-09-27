//! Actual production accessors and serde field attributes. Typed property lookup
//! is controlled for explicit values; missing-property test uses real Entity::default().
use serde::Serialize;
use serde_json::{json, Value};
use source2_demo::FieldValue;
mod actual {
    use source2_demo::{Entity, FieldValue};
    // PROPERTY_HELPER
}
mod controlled {
    use source2_demo::FieldValue;
    pub(crate) struct Entity(pub(crate) Option<FieldValue>);
    impl Entity {
        fn get_property_by_name(&self, _name: &str) -> Result<&FieldValue, ()> { self.0.as_ref().ok_or(()) }
    }
    // PROPERTY_HELPER
}
// IS_FALSE
#[derive(Serialize)]
struct EquipmentFields {
    // EQUIPMENT_FIELDS
}
fn main() {
    let missing=source2_demo::Entity::default();
    assert!(missing.get_property_by_name("m_pItemServices.m_bHasHelmet").is_err());
    assert!(missing.get_property_by_name("m_pItemServices.m_bHasDefuser").is_err());
    let real_missing=serde_json::to_value(actual::READ_HELPER(&missing,"m_pItemServices.m_bHasHelmet")).unwrap();
    let cases=[("true",Some(FieldValue::Boolean(true))),("false",Some(FieldValue::Boolean(false))),
      ("missing",None),("wrong-integer",Some(FieldValue::Unsigned32(1))),("wrong-string",Some(FieldValue::String("true".into())))];
    let rows:Vec<Value>=cases.into_iter().map(|(label,value)|{
        let pawn=&controlled::Entity(value);
        let snapshot=EquipmentFields {
            // COLLECTOR_FIELDS
        };
        let raw=serde_json::to_value(controlled::READ_HELPER(pawn,"m_pItemServices.m_bHasHelmet")).unwrap();
        let encoded=serde_json::to_value(snapshot).unwrap();
        assert_eq!(raw,if label=="true"{json!(true)}else{EXPECTED_UNKNOWN_OR_FALSE(label)});
        assert_eq!(encoded.get("helmet"),if label=="true"{Some(&Value::Bool(true))}else{EXPECTED_SERIALIZED_FALSE(label)});
        assert_eq!(encoded.get("defuser"),encoded.get("helmet"));
        json!({"case":label,"accessorResult":raw,"serializedEquipment":encoded})
    }).collect();
    assert_eq!(real_missing,EXPECTED_UNKNOWN_OR_FALSE("missing"));
    println!("{}",json!({"synthetic":true,"realEntityMissingProperty":real_missing,"rows":rows,"boundary":"True/false/wrong-type property accessor is controlled; missing uses real Entity; serde fields/attributes and collector expressions are actual source"}));
}
