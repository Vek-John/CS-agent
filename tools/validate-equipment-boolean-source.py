#!/usr/bin/env python3
"""Source-derived equipment accessor and serde smoke; never reads a Demo or produces Replay."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import uuid
ROOT=Path(__file__).resolve().parent.parent
PARSER=ROOT/'.local-data/upstream/cs2d/packages/parser'
args=argparse.ArgumentParser(description=__doc__)
args.add_argument('--parser-source',type=Path,default=PARSER/'src')
args.add_argument('--output-dir',type=Path,default=ROOT/'.local-data/equipment-boolean-source/a1')
opt=args.parse_args();opt.output_dir.mkdir(parents=True,exist_ok=True)
if (opt.output_dir/'result.json').exists():raise SystemExit('RESULT_EXISTS: choose a new output directory')
spec=importlib.util.spec_from_file_location('source_helper',ROOT/'tools/validate-blind-coverage.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
block=module.block
props=(opt.parser_source/'props.rs').read_text();collector=(opt.parser_source/'collector.rs').read_text();schema=(opt.parser_source/'schema.rs').read_text()
fields=[];expressions=[]
for name in ['helmet','defuser']:
 match=re.search(r'(#\[serde\([^\n]+\)\]\n\s*pub\(crate\) '+name+r': [^\n]+)',schema);assert match,name
 fields.append(match.group(1))
 expression=next(line.strip() for line in collector.splitlines() if line.strip().startswith(name+': prop_'))
 expressions.append(expression)
helper=re.search(r': (\w+)\(',expressions[0]).group(1)
assert all(helper in value for value in expressions)
modern='Option<bool>' in fields[0]
source=(ROOT/'tools/cs2d-host/fixtures/equipment-boolean-presence.rs').read_text()
source=source.replace('// PROPERTY_HELPER',block(props,'pub(crate) fn '+helper+'(')).replace('// IS_FALSE',block(schema,'pub(crate) fn is_false(')).replace('// EQUIPMENT_FIELDS','\n'.join(fields)).replace('// COLLECTOR_FIELDS','\n'.join(expression.replace(helper+'(', 'controlled::'+helper+'(') for expression in expressions)).replace('READ_HELPER',helper)
source=source.replace('EXPECTED_UNKNOWN_OR_FALSE(label)', '(if label=="false"{json!(false)}else{Value::Null})' if modern else 'json!(false)').replace('EXPECTED_UNKNOWN_OR_FALSE("missing")','Value::Null' if modern else 'json!(false)')
source=source.replace('EXPECTED_SERIALIZED_FALSE(label)','(if label=="false"{Some(&Value::Bool(false))}else{None})' if modern else 'None')
name='cs_coach_equipment_'+uuid.uuid4().hex[:10];example=PARSER/'examples'/f'{name}.rs';binary=PARSER/'target/release/examples'/name;example.parent.mkdir(parents=True, exist_ok=True);example.write_text(source)
child=None
try:
 with (opt.output_dir/'compile.txt').open('w') as log:
  child=subprocess.Popen(['cargo','build','--offline','--locked','--release','--no-default-features','--example',name,'--config','patch.crates-io.source2-demo.path='+json.dumps(str(ROOT/'vendor/source2-demo'))],cwd=PARSER,stdout=log,stderr=log,start_new_session=True,env={**os.environ,'CARGO_NET_OFFLINE':'true','RUSTUP_AUTO_INSTALL':'0'})
  child.wait(timeout=180)
  if child.returncode:raise RuntimeError('COMPILE_FAILED')
 child=subprocess.Popen([str(binary)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 out,err=child.communicate(timeout=30)
 if child.returncode:raise RuntimeError('SMOKE_FAILED')
 if len(out)+len(err)>32768:raise RuntimeError('SMOKE_OUTPUT_LIMIT')
 result=json.loads(out);result['optionalBooleanSchema']=modern
 with (opt.output_dir/'result.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
 print(json.dumps(result))
finally:
 if child and child.poll() is None:
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
  child.wait(timeout=2)
 example.unlink(missing_ok=True)
 for file in (PARSER/'target/release/examples').glob(name+'*'):
  if file.is_file():file.unlink()
