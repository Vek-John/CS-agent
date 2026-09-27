#!/usr/bin/env python3
"""Compile actual Parser report expressions and helpers with real source2 protobuf decoding.
The input is a generated valid 1–2 KiB packet, not a measured Demo. No files are read as Demo input.
"""
from pathlib import Path
import importlib.util, json, os, signal, subprocess, uuid
import argparse
root=Path(__file__).resolve().parent.parent
args=argparse.ArgumentParser(description='Synthetic actual source2 hurt report decoding; no Demo file input.');args.add_argument('--parser-source',type=Path,default=root/'.local-data/upstream/cs2d/packages/parser/src');args.add_argument('--output-dir',type=Path,default=root/'.local-data/hurt-payload-presence/green');opt=args.parse_args()
folder=opt.output_dir;folder.mkdir(parents=True,exist_ok=True)
if (folder/'result.json').exists():raise SystemExit('RESULT_EXISTS: choose a new output directory')
parser=root/'.local-data/upstream/cs2d/packages/parser'
spec=importlib.util.spec_from_file_location('source',root/'tools/validate-blind-coverage.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
block=module.block
source=(root/'tools/cs2d-host/fixtures/hurt-payload-presence.rs').read_text();vendor=(root/'vendor/source2-demo/src/tests.rs').read_text();props=(opt.parser_source/'props.rs').read_text();collector=(opt.parser_source/'collector.rs').read_text()
helpers=block(props,'pub(crate) fn ev_i32(')+'\n'+'\n'.join(block(vendor,'fn '+name+'(') for name in ['replay_with_messages','replay_with_playback_ticks','sync_payload','demo_packet_payload','packet_data'])
if 'pub(crate) fn ev_hurt_report_i32(' in props:helpers+='\n'+block(props,'pub(crate) fn ev_hurt_report_i32(')
source=source.replace('// HELPERS',helpers)
fields=[line.strip().rstrip(',').split(': ',1) for line in collector.splitlines() if line.strip().startswith(('reported_health_damage: ev_','reported_armor_damage: ev_','reported_health_after: ev_','reported_armor_after: ev_'))]
assert len(fields)==4
source=source.replace('// COLLECTOR_REPORTS','let reports=json!({'+','.join(json.dumps(name)+':'+expr for name,expr in fields)+'});')
name='cs_coach_hurt_presence_'+uuid.uuid4().hex[:8];example=parser/'examples'/f'{name}.rs';binary=parser/'target/release/examples'/name
example.parent.mkdir(parents=True,exist_ok=True);example.write_text(source)
child=None
try:
 with (folder/'compile.txt').open('w') as log:
  child=subprocess.Popen(['cargo','build','--offline','--locked','--release','--no-default-features','--example',name,'--config','patch.crates-io.source2-demo.path='+json.dumps(str(root/'vendor/source2-demo'))],cwd=parser,stdout=log,stderr=log,start_new_session=True,env={**os.environ,'CARGO_NET_OFFLINE':'true','RUSTUP_AUTO_INSTALL':'0'})
  child.wait(timeout=180)
  assert child.returncode==0,'COMPILE_FAILED'
 child=subprocess.Popen([str(binary)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 out,err=child.communicate(timeout=30);assert child.returncode==0,'PROBE_FAILED';assert len(out)+len(err)<32768
 result=json.loads(out);(folder/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'callbacks':result['actualDecodedCallbacks'],'inputBytes':result['inputBytes'],'result':'PASS'}))
finally:
 if child and child.poll() is None:
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  child.wait(timeout=2)
 example.unlink(missing_ok=True)
 for path in (parser/'target/release/examples').glob(name+'*'):
  if path.is_file():path.unlink()
