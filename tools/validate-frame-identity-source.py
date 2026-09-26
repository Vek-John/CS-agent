"""Compile actual player sampling and three assemble completeness consumers.
Synthetic entities only; no Demo/dependency reads. --baseline-dir selects saved
collector.rs/props.rs/assemble.rs from before the identity fix for a red run.
Weapon/ammo/geometry accessors are fixture stubs; identity and selection logic
are extracted from production, including the vendored index-only lookup.
"""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def block(source, marker):
    start = source.index(marker)
    brace = source.index('{', start)
    depth, end = 1, brace + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


def body(source, marker):
    value = block(source, marker)
    return value[value.index('{') + 1:-1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', nargs='?', type=Path, default=ROOT / '.local-data/upstream/cs2d')
    parser.add_argument('--baseline-dir', type=Path)
    args = parser.parse_args()
    current = args.upstream / 'packages/parser/src'
    selected = args.baseline_dir or current
    collector = (selected / 'collector.rs').read_text()
    props = (selected / 'props.rs').read_text()
    assemble = (selected / 'assemble.rs').read_text()
    schema = (current / 'schema.rs').read_text()
    start = collector.index('self.last_cap = tick;')
    sample = collector[start:collector.index('// Grenade projectile flight points', start)]
    helpers = '\n'.join(block(props, f'fn {name}') for name in [
        'side_of(', 'prop_i32(', 'prop_u32(', 'prop_u64(', 'packed_pawn_matches(', 'packed_pawn_owner(',
    ])
    if 'fn verified_controller_pawn' in props:
        helpers += '\n' + block(props, 'fn verified_controller_pawn')
    definitions = '\n'.join(block(schema, f'struct {name} ') for name in ['PlayerState', 'PlayerMeta'])
    definitions = re.sub(r'^\s*#\[serde[^\n]*\]\n', '\n', definitions, flags=re.MULTILINE)
    fixture = (ROOT / 'tools/cs2d-host/fixtures/frame-identity.rs').read_text()
    parts = {
        '// SOURCE2_LOOKUP': block((ROOT / 'vendor/source2-demo/src/entity/container.rs').read_text(), 'pub fn get_by_handle('),
        '// IDENTITY_HELPERS': helpers,
        '// STATE_TYPES': definitions,
        '// RAW_FRAME': block(collector, 'struct RawFrame '),
        '// FRAME_SAMPLE': sample,
        '// RESPAWN_PREDICATE': body(assemble, '.find(|f| {'),
        '// KNIFE_ROUND': block(assemble, 'let is_knife_round =') + ';\nis_knife_round(0, 1000)',
        '// KNIFE_SPLIT': block(assemble, 'let knife_split =') + ');\nknife_split',
    }
    for marker, source in parts.items():
        fixture = fixture.replace(marker, source)
    print(f'Frame source: {selected}', flush=True)
    with tempfile.TemporaryDirectory(prefix='cs-frame-identity-') as temp:
        source = Path(temp) / 'regression.rs'; binary = Path(temp) / 'regression'
        source.write_text(fixture)
        subprocess.run(['rustc', '--edition=2021', '--test', '-Awarnings', str(source), '-o', str(binary)], check=True, timeout=60)
        subprocess.run([str(binary), '--nocapture'], check=True, timeout=30)


if __name__ == '__main__':
    main()
