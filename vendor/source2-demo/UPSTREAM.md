# source2-demo 0.5.4

Project-controlled copy of the installed crates.io release, upstream repository:
https://github.com/Rupas1k/source2-demo
Upstream package VCS revision: 5dd12b587c0653a96f1c844103fd13d9aea34ace.

The original `src/`, normalized Cargo manifest, original manifest, README, MIT
license and Apache-2.0 license are retained. No registry configuration, build
outputs, optional allocator source or global Cargo configuration is copied. Original CRLF
line endings are retained; a local Git whitespace attribute recognizes them.

Local change: in `src/parser/demo/commands.rs`, CS2 scalar `m_iClip1` declared as
`int32` is assigned `FieldDecoder::Unsigned32` before the production `Field` is
constructed. The original unsigned wire survives intact, including sentinel and
high-bit values. There is no normalization or signed inverse in this dependency.
The cs2d consumer owns checked +1 normalization and unknown/bounds handling.
Other field types, arrays, ordinary int32 fields and non-CS2 builds are unchanged.

The same file contains synthetic send-table tests using real `Parser.dem_send_tables`
and `Field.decoder.decode`, not a parallel model of the decoder. Tests perform no
Demo file access. `tools/cs2d-parser-toolchain.mjs` supplies an explicit, relative
Cargo patch override for standard builds/native tests and verifies the
resolved package with locked target-specific metadata. Parser Cargo.lock
is authoritative. Prerequisite-only `cs2d:check` runs before patches and does not
resolve dependencies. Set `CARGO_NET_OFFLINE=true` for an explicitly offline run;
standard builds retain Cargo network behavior for locked dependencies; no shared registry files or global Cargo configuration change.

Reevaluate the local override before upgrading upstream. Do not combine this raw
wire fix with the rejected post-hoc Signed32 inverse described in
`docs/validation/DECISION_AMMO.md`.
