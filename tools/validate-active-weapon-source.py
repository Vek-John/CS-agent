"""Test actual active weapon label lookup and knife-round inference sources.

No Demo reads or downloads. --baseline-dir selects saved weapons.rs/assemble.rs
for a red run. Weapon tables, label functions, prop_u32 and the vendored
source2-demo lookup are injected; synthetic entities supply only raw fields.
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
    assemble = (selected / 'assemble.rs').read_text()
    constants = weapons[weapons.index('const KNIFE_LABEL:'):weapons.index('pub(crate) fn weapon_label(')]
    functions = '\n'.join(block(weapons, f'fn {name}(') for name in ['weapon_label', 'active_weapon_label', 'disambiguate_usp'])
    functions += '\n' + block((current / 'props.rs').read_text(), 'fn prop_u32(')
    replacements = {
        '// SOURCE2_LOOKUP': block((ROOT / 'vendor/source2-demo/src/entity/container.rs').read_text(), 'pub fn get_by_handle('),
        '// WEAPON_CODE': constants + '\n' + functions,
        '// KNIFE_ROUND': block(assemble, 'let is_knife_round =') + ';\nis_knife_round(0, 1000)',
        '// KNIFE_SPLIT': block(assemble, 'let knife_split =') + ');\nknife_split',
    }
    fixture = (ROOT / 'tools/cs2d-host/fixtures/active-weapon-identity.rs').read_text()
    for marker, source in replacements.items():
        fixture = fixture.replace(marker, source)
    print(f'Active weapon source: {selected}', flush=True)
    with tempfile.TemporaryDirectory(prefix='cs-active-weapon-') as temp:
        source = Path(temp) / 'regression.rs'; binary = Path(temp) / 'regression'
        source.write_text(fixture)
        subprocess.run(['rustc', '--edition=2021', '--test', '-Awarnings', str(source), '-o', str(binary)], check=True, timeout=60)
        subprocess.run([str(binary), '--nocapture'], check=True, timeout=30)


if __name__ == '__main__':
    main()
