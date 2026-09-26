import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it } from 'vitest';

// Execute the shipped patch's actual domain functions without an upstream checkout.
// An explicit baseline path supports red validation against the pre-change source.
const patch = readFileSync(new URL('./patches/0017-active-weapon-identity.patch', import.meta.url), 'utf8');
const section = patch.split('--- a/').find(s => s.startsWith('apps/app/src/viewer/domain/rounds.ts\n'));
const source = process.env.CS_COACH_KNIFE_BASELINE
  ? readFileSync(process.env.CS_COACH_KNIFE_BASELINE, 'utf8')
  : section?.split('\n').filter(line => line.startsWith(' ') || line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
function extract(name) {
  if (!source) throw new Error('Missing shipped round-domain source');
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) throw new Error(`Missing source function ${name}`);
  const brace = source.indexOf('{', start); let end = brace + 1, depth = 1;
  while (depth && end < source.length) { depth += (source[end] === '{') - (source[end] === '}'); end++; }
  if (depth) throw new Error('Incomplete function source');
  return source.slice(start, end);
}
const names = ['isKnifeRound', 'isPreGameRound', 'preGameRoundCount', 'roundDisplayLabels'];
const { isKnifeRound, isPreGameRound, roundDisplayLabels } = new Function(stripTypeScriptTypes(names.map(extract).join('\n')).replaceAll('export ', '') + '\nreturn { isKnifeRound, isPreGameRound, roundDisplayLabels };')();
const round = (number, weapons) => ({ number, frames: [{ players: weapons.map(weapon => ({ weapon })) }] });
describe('unknown active weapons in Viewer round classification', () => {
  it.each([[''], ['Faca', ''], []].map(weapons => ({ weapons })))('does not hide or renumber unknown weapons $weapons as a knife round', ({ weapons }) => {
    const first = round(1, weapons);
    expect(isKnifeRound(first)).toBe(false);
    expect(isPreGameRound(first)).toBe(false);
    expect(roundDisplayLabels([first, round(2, ['AK-47'])])).toEqual(['1', '2']);
  });
  it('does not bridge an empty player frame into all-knife evidence', () => {
    expect(isKnifeRound({ ...round(1, ['Faca']), frames: [{ players: [{ weapon: 'Faca' }] }, { players: [] }] })).toBe(false);
  });
  it('preserves known knife openers and the separate frameless pregame rule', () => {
    expect(isKnifeRound(round(1, ['Faca', 'Faca']))).toBe(true);
    expect(roundDisplayLabels([round(1, ['Faca']), round(2, ['AK-47'])])).toEqual(['0', '1']);
    expect(isKnifeRound({ number: 0, frames: [] })).toBe(false);
    expect(isPreGameRound({ number: 0, frames: [] })).toBe(true);
  });
});
