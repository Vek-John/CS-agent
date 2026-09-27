//! Game event system for handling in-game events.
//!
//! This module provides types for working with game events - structured events
//! that occur during gameplay like player kills, item purchases, ability uses,
//! etc.
//!
//! # Overview
//!
//! Game events are defined by the game and contain named key-value pairs.
//! Each event has a name (e.g., "dota_player_kill") and a set of values.
//!
//! # Examples
//!
//! ## Handling game events
//!
//! ```no_run
//! use source2_demo::prelude::*;
//!
//! #[derive(Default)]
//! struct EventLogger;
//!
//! #[observer]
//! #[uses_game_events]
//! impl EventLogger {
//!     #[on_game_event]
//!     fn on_game_event(&mut self, ctx: &Context, ge: &GameEvent) -> ObserverResult {
//!         println!("Event: {}", ge.name());
//!
//!         // Iterate all key-value pairs
//!         for (key, value) in ge.iter() {
//!             println!("  {}: {:?}", key, value);
//!         }
//!
//!         // Get specific value
//!         if let Ok(player_id) = ge.get_value("player_id") {
//!             let id: i32 = player_id.try_into()?;
//!             println!("Player ID: {}", id);
//!         }
//!
//!         Ok(())
//!     }
//! }
//! ```

#[cfg(feature = "dota")]
mod combat_log;
mod definition;
mod list;
mod value;

#[cfg(feature = "dota")]
pub use combat_log::*;
use definition::*;
pub use list::*;
pub use value::*;

use crate::error::GameEventError;
use crate::proto::CSvcMsgGameEvent;

/// Represents a game event with its name and values.
///
/// Game events are structured in-game occurrences. Each event has a name and a
/// set of named values.
///
/// # Examples
///
/// ## Accessing event data
///
/// ```no_run
/// use source2_demo::prelude::*;
///
/// # fn example(ge: &GameEvent) -> anyhow::Result<()> {
/// // Get the event name
/// println!("Event: {}", ge.name());
///
/// // Iterate all key-value pairs
/// for (key, value) in ge.iter() {
///     println!("{}: {:?}", key, value);
/// }
///
/// // Get a specific value
/// let player_id: i32 = ge.get_value("player_id")?.try_into()?;
/// # Ok(())
/// # }
/// ```
pub struct GameEvent<'a> {
    id: i32,
    list: &'a GameEventList,
    keys: Vec<EventValue>,
    wire_value_types: Vec<Option<i32>>,
}

impl<'a> GameEvent<'a> {
    pub(crate) fn new(list: &'a GameEventList, ge: CSvcMsgGameEvent) -> Self {
        let id = ge.eventid();
        // Preserve wire metadata independently of the compatibility EventValue projection.
        let wire_value_types = ge.keys.iter().map(|key| {
            let present = match key.r#type() {
                1 => key.val_string.is_some(),
                2 => key.val_float.is_some(),
                3 | 8 => key.val_long.is_some(),
                4 | 9 => key.val_short.is_some(),
                5 => key.val_byte.and_then(|value| u8::try_from(value).ok()).is_some(),
                6 => key.val_bool.is_some(),
                7 => key.val_uint64.is_some(),
                _ => false,
            };
            present.then_some(key.r#type()).filter(|_| key.r#type.is_some())
        }).collect();
        let keys = ge
            .keys
            .iter()
            .map(|key| match key.r#type() {
                1 => EventValue::String(key.val_string().into()),
                2 => EventValue::Float(key.val_float()),
                3 => EventValue::Int(key.val_long()),
                4 => EventValue::Int(key.val_short()),
                5 => EventValue::Byte(key.val_byte() as u8),
                6 => EventValue::Bool(key.val_bool()),
                7 => EventValue::U64(key.val_uint64()),
                8 => EventValue::Int(key.val_long()),
                9 => EventValue::Int(key.val_short()),
                _ => unreachable!("Unknown event type: {}", key.r#type()),
            })
            .collect::<Vec<_>>();

        Self { id, list, keys, wire_value_types }
    }

    /// Returns the event's numeric ID.
    pub fn id(&self) -> i32 {
        self.id
    }

    /// Returns the event's name.
    ///
    /// Event names are strings
    pub fn name(&self) -> &str {
        &self.list.list[&self.id].name
    }

    /// Returns an iterator over all key-value pairs in the event.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ge: &GameEvent) {
    /// for (key, value) in ge.iter() {
    ///     println!("{}: {:?}", key, value);
    /// }
    /// # }
    /// ```
    pub fn iter(&self) -> impl Iterator<Item = (&str, &EventValue)> {
        self.keys
            .iter()
            .zip(self.list.list[&self.id].keys.iter())
            .map(|(value, key)| (key.name.as_str(), value))
    }

    /// Wire type only when its value is present and agrees with the event descriptor.
    /// Missing keys, missing type/value payloads, mismatches, or unrepresentable bytes remain unknown.
    pub fn validated_value_type(&self, name: &str) -> Option<i32> {
        let definition = self.list.list.get(&self.id)?;
        let key = definition.name_to_key.get(name)?;
        let expected = key.value_type?;
        let actual = self.wire_value_types.get(key.id as usize).copied().flatten()?;
        (actual == expected).then_some(actual)
    }

    /// Gets the value for a specific key.
    ///
    /// # Arguments
    ///
    /// * `key` - The name of the key to look up
    ///
    /// # Errors
    ///
    /// Returns [`GameEventError::UnknownKey`] if the key doesn't exist for this
    /// event.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use source2_demo::prelude::*;
    ///
    /// # fn example(ge: &GameEvent) -> anyhow::Result<()> {
    /// // Get a value and convert it
    /// let player_id: i32 = ge.get_value("player_id")?.try_into()?;
    /// let hero_name: String = ge.get_value("hero_name")?.try_into()?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn get_value(&self, key: &str) -> Result<&EventValue, GameEventError> {
        let key = self.list.list[&self.id]
            .name_to_key
            .get(key)
            .ok_or_else(|| GameEventError::UnknownKey(key.to_string()))?;
        Ok(&self.keys[key.id as usize])
    }
}

#[cfg(test)]
mod wire_type_tests {
    use super::*;
    use crate::proto::{csvc_msg_game_event, csvc_msg_game_event_list, CSvcMsgGameEventList};
    fn definition(kind: Option<i32>) -> GameEventList {
        GameEventList::new(CSvcMsgGameEventList { descriptors: vec![csvc_msg_game_event_list::DescriptorT {
            eventid: Some(1), name: Some("player_blind".into()), keys: vec![csvc_msg_game_event_list::KeyT { r#type: kind, name: Some("userid".into()) }],
        }] })
    }
    fn event(list: &GameEventList, kind: i32, value: Option<i32>) -> GameEvent<'_> {
        let mut key = csvc_msg_game_event::KeyT { r#type: Some(kind), ..Default::default() };
        if kind == 8 || kind == 3 { key.val_long = value; } else { key.val_short = value; }
        GameEvent::new(list, CSvcMsgGameEvent { eventid: Some(1), keys: vec![key], ..Default::default() })
    }
    #[test] fn retains_descriptor_and_wire_types_without_changing_integer_projection() {
        for kind in [3,4,8,9] {
            let list = definition(Some(kind)); let ge = event(&list, kind, Some(257));
            assert_eq!(ge.validated_value_type("userid"), Some(kind));
            let raw: i32 = ge.get_value("userid").unwrap().try_into().unwrap(); assert_eq!(raw, 257);
        }
    }
    #[test] fn missing_payload_descriptor_or_mismatched_wire_is_unknown() {
        let list = definition(Some(9));
        assert_eq!(event(&list,9,None).validated_value_type("userid"),None);
        assert_eq!(event(&list,4,Some(1)).validated_value_type("userid"),None);
        assert_eq!(event(&list,8,Some(1)).validated_value_type("userid"),None);
        assert_eq!(event(&list,9,Some(1)).validated_value_type("absent"),None);
        let absent = GameEvent::new(&list, CSvcMsgGameEvent { eventid: Some(1), ..Default::default() });
        assert_eq!(absent.validated_value_type("userid"),None);
        let unknown = definition(None); assert_eq!(event(&unknown,9,Some(1)).validated_value_type("userid"),None);
    }
    #[test] fn float_requires_present_payload_and_matching_descriptor() {
        let list = definition(Some(2));
        for value in [None, Some(0.04)] {
            let ge = GameEvent::new(&list, CSvcMsgGameEvent { eventid: Some(1), keys: vec![csvc_msg_game_event::KeyT { r#type: Some(2), val_float: value, ..Default::default() }], ..Default::default() });
            assert_eq!(ge.validated_value_type("userid"), value.map(|_| 2));
        }
        let wrong = definition(Some(9));
        let ge = GameEvent::new(&wrong, CSvcMsgGameEvent { eventid: Some(1), keys: vec![csvc_msg_game_event::KeyT { r#type: Some(2), val_float: Some(0.04), ..Default::default() }], ..Default::default() });
        assert_eq!(ge.validated_value_type("userid"), None);
    }

    #[test] fn byte_validation_rejects_lossy_wrapping_without_changing_legacy_values() {
        let list = definition(Some(5));
        for value in [None, Some(-256), Some(256), Some(0), Some(40), Some(255)] {
            let ge = GameEvent::new(&list, CSvcMsgGameEvent { eventid: Some(1), keys: vec![csvc_msg_game_event::KeyT { r#type: Some(5), val_byte: value, ..Default::default() }], ..Default::default() });
            let valid = value.and_then(|v| u8::try_from(v).ok()).map(|_| 5);
            assert_eq!(ge.validated_value_type("userid"), valid);
            let legacy: i32 = ge.get_value("userid").unwrap().try_into().unwrap();
            assert_eq!(legacy, value.unwrap_or(0) as u8 as i32);
        }
    }

}
