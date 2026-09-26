"""Run the production Bomb branch against synthetic entity lifecycle cases.

No Demo reads or dependency downloads. --collector can select a pre-change
collector (for example /tmp/cs-agent-bomb-before.rs) for the red regression.
Identity helpers come from the patched checkout; get_by_handle comes from the
project-controlled source2-demo vendor, including its index-only behavior.
"""
import argparse
from pathlib import Path
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


def main():
    options = argparse.ArgumentParser(description=__doc__)
    options.add_argument('upstream', nargs='?', type=Path,
                         default=ROOT / '.local-data/upstream/cs2d')
    options.add_argument('--collector', type=Path,
                         help='Alternative production collector, used for baseline regression')
    args = options.parse_args()
    parser = args.upstream / 'packages/parser/src'
    collector_path = args.collector or parser / 'collector.rs'
    collector = collector_path.read_text()
    props = (parser / 'props.rs').read_text()
    branch = block(collector, 'name @ ("bomb_planted" | "bomb_defused" | "bomb_exploded") => ')
    branch = branch[branch.index('{') + 1:-1]
    helpers = block(collector, 'fn steam_from_pawn_handle(')
    for name in ['event_pawn_to_packed', 'packed_pawn_matches', 'packed_pawn_owner', 'verified_event_pawn']:
        helpers += '\n' + block(props, f'fn {name}(')
    source2 = ROOT / 'vendor/source2-demo/src/entity/container.rs'
    lookup = block(source2.read_text(), 'pub fn get_by_handle(')
    fixture = (ROOT / 'tools/cs2d-host/fixtures/bomb-identity.rs').read_text()
    fixture = (fixture.replace('// SOURCE2_LOOKUP', lookup)
               .replace('// IDENTITY_HELPERS', helpers)
               .replace('// BOMB_KIND', block(collector, 'enum BombKind '))
               .replace('// BOMB_EVENT', branch))
    print(f'Bomb source: {collector_path}', flush=True)
    with tempfile.TemporaryDirectory(prefix='cs-bomb-identity-') as temp:
        source = Path(temp) / 'regression.rs'
        binary = Path(temp) / 'regression'
        source.write_text(fixture)
        subprocess.run(['rustc', '--edition=2021', '--test', '-Awarnings', str(source), '-o', str(binary)],
                       check=True, timeout=60)
        subprocess.run([str(binary), '--nocapture'], check=True, timeout=30)


if __name__ == '__main__':
    main()
