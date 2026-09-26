"""Exercise actual primary inventory selection against current-slot fixtures.

No Demo reads or downloads. --baseline-dir selects saved weapons.rs. Production
tables, inventory functions, prop_u32 and vendor lookup are injected; fake
entities supply parent lengths and retained children, not decoded network data.
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
    names = ['weapon_label', 'primary_weapon', 'disambiguate_usp', 'is_pistol']
    if 'fn current_inventory_labels(' in weapons:
        names.append('current_inventory_labels')
    functions = '\n'.join(block(weapons, f'fn {name}(') for name in names)
    functions += '\n' + block((current / 'props.rs').read_text(), 'fn prop_u32(')
    fixture = (ROOT / 'tools/cs2d-host/fixtures/primary-inventory.rs').read_text()
    fixture = (fixture.replace('// WEAPON_CODE', constants + '\n' + functions)
               .replace('// SOURCE2_LOOKUP', block((ROOT / 'vendor/source2-demo/src/entity/container.rs').read_text(), 'pub fn get_by_handle(')))
    print(f'Primary inventory source: {selected}', flush=True)
    with tempfile.TemporaryDirectory(prefix='cs-primary-inventory-') as temp:
        source = Path(temp) / 'regression.rs'; binary = Path(temp) / 'regression'
        source.write_text(fixture)
        subprocess.run(['rustc', '--edition=2021', '--test', '-Awarnings', str(source), '-o', str(binary)], check=True, timeout=60)
        subprocess.run([str(binary), '--nocapture'], check=True, timeout=30)


if __name__ == '__main__':
    main()
