use crate::entity::field::*;
use crate::entity::Class;
use crate::error::ParserError;
use crate::parser::demo::DemoMessages;
use crate::parser::Parser;
use crate::proto::*;
use crate::reader::*;
use crate::HashMap;
use crate::StringTableRow;
use std::rc::Rc;

pub trait DemoCommands {
    fn dem_send_tables(&mut self, send_tables: CDemoSendTables) -> Result<(), ParserError>;

    fn dem_class_info(&mut self, class_info: CDemoClassInfo) -> Result<(), ParserError>;

    fn dem_packet(&mut self, demo_packet: CDemoPacket) -> Result<(), ParserError>;

    fn dem_full_packet(&mut self, full_packet: CDemoFullPacket) -> Result<(), ParserError>;

    fn dem_string_tables(&mut self, string_tables: CDemoStringTables) -> Result<(), ParserError>;

    fn dem_stop(&mut self) -> Result<(), ParserError> {
        Ok(())
    }
}

impl<'a, R> DemoCommands for Parser<'a, R>
where
    R: BitsReader + MessageReader,
{
    fn dem_send_tables(&mut self, send_tables: CDemoSendTables) -> Result<(), ParserError> {
        let serializers = &mut self.context.serializers;

        let mut reader = SliceReader::new(send_tables.data());
        let amount = reader.read_var_u32();
        let buf = reader.read_bytes(amount);

        let fs = CSvcMsgFlattenedSerializer::decode(buf.as_slice())?;

        let resolve = |p: Option<i32>| -> &str {
            if let Some(i) = p {
                return &fs.symbols[i as usize];
            }
            ""
        };

        let mut fields: Vec<Rc<Field>> = vec![];
        let mut field_types: HashMap<&str, Rc<FieldType>> = HashMap::default();

        for s in fs.serializers.iter() {
            let ser_name = resolve(s.serializer_name_sym);
            let mut serializer = Serializer::default();

            for i in s.fields_index.iter().map(|&x| x as usize) {
                let current_field = &fs.fields[i];
                let field_serializer_name = resolve(current_field.field_serializer_name_sym);

                if i >= fields.len() {
                    let var_type_str = resolve(current_field.var_type_sym);
                    let var_name = resolve(current_field.var_name_sym);

                    let current_field_serializer = serializers.get(field_serializer_name);

                    let field_type = field_types
                        .entry(var_type_str)
                        .or_insert_with(|| Rc::new(FieldType::new(var_type_str)))
                        .clone();

                    let properties = FieldProperties {
                        encoder: match var_name {
                            "m_flSimulationTime" | "m_flAnimTime" => Some(FieldEncoder::SimTime),
                            "m_flRuneTime" => Some(FieldEncoder::RuneTime),
                            _ => FieldEncoder::from_str(resolve(current_field.var_encoder_sym)),
                        },
                        encoder_flags: current_field.encode_flags(),
                        bit_count: current_field.bit_count(),
                        low_value: current_field.low_value(),
                        high_value: current_field.high_value(),
                    };

                    let model = if let Some(ser) = current_field_serializer {
                        if field_type.pointer {
                            FieldModel::Pointer(ser.clone())
                        } else {
                            FieldModel::Vector(ser.clone())
                        }
                    } else if matches!(
                        field_type.base.as_ref(),
                        "CUtlVector" | "CNetworkUtlVectorBase" | "CUtlVectorEmbeddedNetworkVar"
                    ) {
                        FieldModel::ValueVector(FieldDecoder::from_field(
                            field_type.generic.as_ref().unwrap(),
                            properties,
                        ))
                    } else if field_type.count > 0 && field_type.base.as_ref() != "char" {
                        FieldModel::Array
                    } else {
                        FieldModel::Value
                    };

                    let mut decoder = match model {
                        FieldModel::Value | FieldModel::Array => {
                            FieldDecoder::from_field(&field_type, properties)
                        }
                        FieldModel::Vector(_) | FieldModel::ValueVector(_) => {
                            FieldDecoder::Unsigned32
                        }
                        FieldModel::Pointer(_) => FieldDecoder::Boolean,
                    };

                    if ser_name == "CCSGameModeRules" || var_name == "m_pGameModeRules" {
                        decoder = FieldDecoder::CCSGameModeRules;
                    }

                    // CS2 declares this scalar int32, but its ammo wire codec is unsigned.
                    // Preserve the raw value here; +1 normalization belongs to the consumer.
                    #[cfg(feature = "cs2")]
                    if var_name == "m_iClip1" && field_type.base.as_ref() == "int32"
                        && matches!(model, FieldModel::Value)
                    {
                        decoder = FieldDecoder::Unsigned32;
                    }

                    let field = Field {
                        var_name: var_name.into(),
                        field_type,
                        model,
                        decoder,
                    };
                    fields.push(field.into());
                }
                serializer.fields.push(Rc::clone(&fields[i]));
            }
            serializers.insert(ser_name.into(), serializer.into());
        }
        Ok(())
    }

    fn dem_class_info(&mut self, class_info: CDemoClassInfo) -> Result<(), ParserError> {
        for class in class_info.classes {
            let class_id = class.class_id();
            let network_name = class.network_name();
            let serializer = self.context.serializers[network_name].clone();
            let class = Rc::new(Class::new(class_id, network_name.into(), serializer));

            self.context.classes.classes_vec.push(class.clone());
            self.context
                .classes
                .classes_by_name
                .insert(network_name.into(), class);
        }
        Ok(())
    }

    fn dem_packet(&mut self, packet: CDemoPacket) -> Result<(), ParserError> {
        let mut packet_reader = SliceReader::new(packet.data());
        while packet_reader.remaining_bytes() != 0 {
            let msg_type = packet_reader.read_ubit_var() as i32;
            let size = packet_reader.read_var_u32();
            let msg_buf = packet_reader.read_bytes(size);

            #[cfg(feature = "dota")]
            if let Ok(msg) = EDotaUserMessages::try_from(msg_type) {
                self.on_dota_user_message(msg, &msg_buf)?;
                continue;
            }

            #[cfg(feature = "deadlock")]
            if let Ok(msg) = CitadelUserMessageIds::try_from(msg_type) {
                self.on_citadel_user_message(msg, &msg_buf)?;
                continue;
            } else if let Ok(msg) = ECitadelGameEvents::try_from(msg_type) {
                self.on_citadel_game_event(msg, &msg_buf)?;
                continue;
            }

            #[cfg(feature = "cs2")]
            if let Ok(msg) = ECstrike15UserMessages::try_from(msg_type) {
                self.on_cs2_user_message(msg, &msg_buf)?;
                continue;
            } else if let Ok(msg) = ECsgoGameEvents::try_from(msg_type) {
                self.on_cs2_game_event(msg, &msg_buf)?;
                continue;
            }

            if let Ok(msg) = SvcMessages::try_from(msg_type) {
                self.on_svc_message(msg, &msg_buf)?;
            } else if let Ok(msg) = EBaseUserMessages::try_from(msg_type) {
                self.on_base_user_message(msg, &msg_buf)?;
            } else if let Ok(msg) = EBaseGameEvents::try_from(msg_type) {
                self.on_base_game_event(msg, &msg_buf)?;
            } else if let Ok(msg) = NetMessages::try_from(msg_type) {
                self.on_net_message(msg, &msg_buf)?;
            }
        }

        Ok(())
    }

    fn dem_full_packet(&mut self, full_packet: CDemoFullPacket) -> Result<(), ParserError> {
        if self.context.last_full_packet_tick == u32::MAX || self.skip_deltas {
            self.dem_string_tables(full_packet.string_table.unwrap())?;
            self.dem_packet(full_packet.packet.unwrap())?;
        }

        self.context.last_full_packet_tick = self.context.tick;

        Ok(())
    }

    fn dem_string_tables(&mut self, msg: CDemoStringTables) -> Result<(), ParserError> {
        for table in msg.tables.iter() {
            let x = self
                .context
                .string_tables
                .get_by_name_mut(table.table_name())?;

            x.items
                .resize_with(table.items.len(), StringTableRow::default);
            for (i, item) in table.items.iter().enumerate() {
                x.items[i].index = i as i32;
                x.items[i].key = item.str().to_string();
                x.items[i].value = Rc::new(item.data().to_vec()).into();
                if table.table_name() == "instancebaseline" {
                    self.context.baselines.add_baseline(
                        item.str().parse().unwrap_or(-1),
                        x.items[i].value.as_ref().unwrap().clone(),
                    );
                }
            }
        }

        Ok(())
    }

    fn dem_stop(&mut self) -> Result<(), ParserError> {
        self.on_stop()?;
        Ok(())
    }
}

#[cfg(test)]
mod ammo_wire_tests {
    use super::*;
    use crate::writer::{write_demo_message, write_var_u64_to_vec};

    // Exercise the real send-table Field construction and actual bitstream decoder.
    // This synthetic header is not a user Demo and performs no file access.
    fn field(name: &str, field_type: &str) -> Rc<Field> {
        let mut header = b"PBDEMS2\0".to_vec();
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&[0; 4]);
        write_demo_message(&mut header, EDemoCommands::DemFileInfo, 0, &CDemoFileInfo::default().encode_to_vec()).unwrap();
        let mut parser = Parser::from_slice(&header).unwrap();
        let serialized = CSvcMsgFlattenedSerializer {
            symbols: vec!["CWeaponFixture".into(), field_type.into(), name.into()],
            serializers: vec![ProtoFlattenedSerializerT { serializer_name_sym: Some(0), serializer_version: Some(0), fields_index: vec![0] }],
            fields: vec![ProtoFlattenedSerializerFieldT { var_type_sym: Some(1), var_name_sym: Some(2), ..Default::default() }],
        }.encode_to_vec();
        let mut bytes = write_var_u64_to_vec(serialized.len() as u64);
        bytes.extend(serialized);
        parser.dem_send_tables(CDemoSendTables { data: Some(bytes) }).unwrap();
        Rc::clone(&parser.context.serializers["CWeaponFixture"].fields[0])
    }

    fn decode(field: &Field, raw: u32) -> FieldValue {
        let bytes = write_var_u64_to_vec(raw as u64);
        field.decoder.decode(&mut SliceReader::new(&bytes))
    }

    #[test]
    fn clip_wire_survives_field_construction_without_signed_aliasing() {
        let clip = field("m_iClip1", "int32");
        for raw in [0, 1, 31, 41, 101, 256, 257, 0x80000000, 0xffffffe0, 0xfffffffe, u32::MAX] {
            let value = decode(&clip, raw);
            #[cfg(feature = "cs2")]
            assert_eq!(value, FieldValue::Unsigned32(raw));
            #[cfg(not(feature = "cs2"))]
            {
                let bytes = write_var_u64_to_vec(raw as u64);
                assert_eq!(value, FieldValue::Signed32(SliceReader::new(&bytes).read_var_i32()));
            }
        }
    }

    #[test]
    fn other_int32_arrays_and_field_types_keep_the_existing_decoder() {
        for (name, ty) in [("m_iHealth", "int32"), ("m_iClip2", "int32"), ("m_iClip1", "int32[2]")] {
            let actual = field(name, ty);
            for raw in [0, 1, 31, 0xfffffffe, u32::MAX] {
                let bytes = write_var_u64_to_vec(raw as u64);
                assert_eq!(decode(&actual, raw), FieldValue::Signed32(SliceReader::new(&bytes).read_var_i32()));
            }
        }
        assert_eq!(decode(&field("m_iClip1", "uint8"), 31), FieldValue::Unsigned8(31));
    }
}
