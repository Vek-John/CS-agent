"""Compile the actual player_death branch against synthetic entity lifecycle cases.

No Demo reads or dependency downloads. --collector selects an optional baseline
collector, e.g. /tmp/cs-agent-death-before.rs. The current props identity helpers
and project-vendored source2-demo get_by_handle are injected unchanged.
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
    options.add_argument('--collector', type=Path, help='Pre-change collector for the red regression')
    args = options.parse_args()
    parser = args.upstream / 'packages/parser/src'
    collector_path = args.collector or parser / 'collector.rs'
    collector = collector_path.read_text()
    props = (parser / 'props.rs').read_text()
    branch = block(collector, '"player_death" => ')
    branch = branch[branch.index('{') + 1:-1]
    helpers = block(collector, 'fn steam_from_pawn_handle(')
    for name in ['event_pawn_to_packed', 'packed_pawn_matches', 'packed_pawn_owner', 'verified_event_pawn']:
        helpers += '\n' + block(props, f'fn {name}(')
    lookup = block((ROOT / 'vendor/source2-demo/src/entity/container.rs').read_text(), 'pub fn get_by_handle(')
    fixture = (ROOT / 'tools/cs2d-host/fixtures/death-identity.rs').read_text()
    fixture = (fixture.replace('// SOURCE2_LOOKUP', lookup)
               .replace('// IDENTITY_HELPERS', helpers)
               .replace('// KILL_VARIANT', block(collector, 'Kill {'))
               .replace('// PLAYER_DEATH', branch))
    print(f'Death source: {collector_path}', flush=True)
    with tempfile.TemporaryDirectory(prefix='cs-death-identity-') as temp:
        source = Path(temp) / 'regression.rs'
        binary = Path(temp) / 'regression'
        source.write_text(fixture)
        subprocess.run(['rustc', '--edition=2021', '--test', '-Awarnings', str(source), '-o', str(binary)],
                       check=True, timeout=60)
        subprocess.run([str(binary), '--nocapture'], check=True, timeout=30)


if __name__ == '__main__':
    main()
