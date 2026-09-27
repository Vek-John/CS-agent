"""Run actual blind collection/assembly against small synthetic identity lifecycles. No Demo reads."""
from pathlib import Path
import argparse, subprocess, tempfile
ROOT=Path(__file__).resolve().parent.parent

def block(source,marker):
 start=source.index(marker);brace=source.index('{',start);depth=1;end=brace+1
 while depth:
  depth+=(source[end]=='{')-(source[end]=='}');end+=1
 return source[start:end]

def main():
 args=argparse.ArgumentParser(description=__doc__);args.add_argument('--parser-source',type=Path,default=ROOT/'.local-data/upstream/cs2d/packages/parser/src');opt=args.parse_args()
 c=(opt.parser_source/'collector.rs').read_text();p=(opt.parser_source/'props.rs').read_text();a=(opt.parser_source/'assemble.rs').read_text();schema=(opt.parser_source/'schema.rs').read_text()
 field=next(line.strip() for line in c.splitlines() if 'pub(crate) blinds_raw:' in line)
 helpers='\n'.join(block(p,'fn '+name+'(') for name in ['ev_i32','ev_f32','round1'])
 if 'fn event_controller_owner(' in p:helpers+='\n'+block(p,'fn event_controller_owner(')
 branch=block(c,'"player_blind" => ');branch=branch[branch.index('{')+1:-1]
 marker='for (ordinal, (tick, victim, dur, flasher))' if 'for (ordinal, (tick, victim, dur, flasher))' in a else 'for (tick, uid, dur, flasher)'
 loop=block(a,marker);roundof=block(a,'let round_of = ')+';'
 fixture=(ROOT/'tools/cs2d-host/fixtures/blind-identity.rs').read_text().replace('// COLLECTOR_FIELD',field).replace('// HELPERS',helpers).replace('// BLIND_BODY',branch).replace('// BLIND_STRUCT',block(schema,'pub(crate) struct Blind')).replace('// ROUND_OF',roundof).replace('// ASSEMBLE',loop).replace('VENDOR_EVENT_VALUE',str(ROOT/'vendor/source2-demo/src/event/value.rs'))
 with tempfile.TemporaryDirectory(prefix='cs-blind-identity-') as temp:
  source=Path(temp)/'test.rs';binary=Path(temp)/'test';source.write_text(fixture)
  command=['rustc','--edition=2021','--test','-Awarnings',str(source),'-o',str(binary)]
  if 'blind_evidence_version' in schema:command+=['--cfg','blind_v1']
  subprocess.run(command,check=True,timeout=60);subprocess.run([str(binary),'--nocapture'],check=True,timeout=30)
if __name__=='__main__':main()
