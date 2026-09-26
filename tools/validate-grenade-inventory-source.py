"""Compile the actual grenade inventory projection against sparse vector fixtures.

No Demo reads or dependency downloads. --baseline-dir selects pre-change
weapons.rs. The production label tables/functions and vendor entity lookup are
injected. Vector root/children are supplied by a fake entity, not a wire decoder.
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
    options.add_argument('upstream', nargs='?', type=Path, default=ROOT / '.local-data/upstream/cs2d')
    options.add_argument('--baseline-dir', type=Path)
    args = options.parse_args()
    current = args.upstream / 'packages/parser/src'
    selected = args.baseline_dir or current
    weapons = (selected / 'weapons.rs').read_text()
    constants = weapons[weapons.index('const KNIFE_LABEL:'):weapons.index('pub(crate) fn weapon_label(')]
    functions = '\n'.join(block(weapons, f'fn {name}(') for name in ['weapon_label', 'grenade_inventory'])
    fixture = (ROOT / 'tools/cs2d-host/fixtures/grenade-inventory.rs').read_text()
    fixture = (fixture.replace('// WEAPON_CODE', constants + '\n' + functions)
               .replace('// SOURCE2_LOOKUP', block((ROOT / 'vendor/source2-demo/src/entity/container.rs').read_text(), 'pub fn get_by_handle(')))
    print(f'Grenade inventory source: {selected}', flush=True)
    with tempfile.TemporaryDirectory(prefix='cs-grenade-inventory-') as temp:
        source = Path(temp) / 'regression.rs'; binary = Path(temp) / 'regression'
        source.write_text(fixture)
        subprocess.run(['rustc', '--edition=2021', '--test', '-Awarnings', str(source), '-o', str(binary)], check=True, timeout=60)
        subprocess.run([str(binary), '--nocapture'], check=True, timeout=30)


if __name__ == '__main__':
    main()
