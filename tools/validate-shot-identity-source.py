"""Compile the production weapon_fire branch against a tiny entity-lifecycle fixture.
No Demo reads. Requires the existing patched checkout and installed Rust compiler.
The real source2 index lookup is included, not a reimplemented resolution algorithm.
"""
from pathlib import Path
import os
import subprocess
import tempfile
import sys

root = Path(__file__).resolve().parent.parent
upstream = Path(sys.argv[1]) if len(sys.argv) > 1 else root / '.local-data/upstream/cs2d'
parser = upstream / 'packages/parser/src'

def block(source, marker):
    start = source.index(marker)
    brace = source.index('{', start)
    depth = 1
    end = brace + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]

collector = (parser / 'collector.rs').read_text()
props = (parser / 'props.rs').read_text()
branch = block(collector, '"weapon_fire" => ')
branch = branch[branch.index('{') + 1:-1]
helpers = block(collector, 'fn steam_from_pawn_handle(')
for name in ['event_pawn_to_packed', 'packed_pawn_matches', 'packed_pawn_owner', 'verified_event_pawn']:
    marker = f'fn {name}'
    if marker in props:
        start = props.index(marker)
        if props[start-11:start] == 'pub(crate) ': start -= 11
        helpers += '\n' + block(props[start:], marker)
registry = Path(os.environ.get('CARGO_HOME', Path.home() / '.cargo')) / 'registry/src'
source2 = next(registry.glob('*/source2-demo-0.5.4/src/entity/container.rs'))
lookup = block(source2.read_text(), 'pub fn get_by_handle(')
fixture = (root / 'tools/cs2d-host/fixtures/shot-identity.rs').read_text()
fixture = fixture.replace('// SOURCE2_LOOKUP', lookup).replace('// IDENTITY_HELPERS', helpers).replace('// WEAPON_FIRE', branch)
with tempfile.TemporaryDirectory(prefix='cs-shot-identity-') as temp:
    source = Path(temp) / 'regression.rs'
    binary = Path(temp) / 'regression'
    source.write_text(fixture)
    subprocess.run(['rustc', '--edition=2021', '--test', '-Awarnings', str(source), '-o', str(binary)], check=True, timeout=60)
    subprocess.run([str(binary), '--nocapture'], check=True, timeout=30)
