#!/usr/bin/env python3
"""Bounded anonymous equipment coverage. --smoke never reads a Demo file.
Uses the existing blind coverage execute monitor unchanged; Cargo is outside runtime RSS accounting.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import uuid
ROOT=Path(__file__).resolve().parent.parent
PARSER=ROOT/'.local-data/upstream/cs2d/packages/parser'
spec=importlib.util.spec_from_file_location('bounded_blind_runner',ROOT/'tools/validate-blind-coverage.py')
shared=importlib.util.module_from_spec(spec);spec.loader.exec_module(shared)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--smoke',action='store_true');mode.add_argument('--input',type=Path)
    parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    if args.output.exists():parser.error('OUTPUT_EXISTS: preserve prior evidence and choose a new path')
    if args.input and args.input.stat().st_size>shared.CAP:parser.error('INPUT_TOO_LARGE')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    source=(ROOT/'tools/cs2d-host/fixtures/equipment-coverage.rs').read_text().replace('CURRENT_PROPS',str(PARSER/'src/props.rs'))
    tests=(ROOT/'vendor/source2-demo/src/tests.rs').read_text()
    helpers='\n'.join(shared.block(tests,'fn '+name+'(') for name in ['replay_with_messages','replay_with_playback_ticks','sync_payload','demo_packet_payload','packet_data'])
    source=source.replace('// SYNTHETIC_WRITERS',helpers)
    name='cs_coach_equipment_coverage_'+uuid.uuid4().hex[:10];example=PARSER/'examples'/f'{name}.rs';binary=PARSER/'target/release/examples'/name
    example.parent.mkdir(parents=True,exist_ok=True);example.write_text(source)
    build=None
    stage="COMPILE"
    try:
        with args.output.with_suffix('.compile.txt').open('x') as log:
            build=subprocess.Popen(['cargo','build','--offline','--locked','--release','--no-default-features','--example',name,'--config','patch.crates-io.source2-demo.path='+json.dumps(str(ROOT/'vendor/source2-demo'))],cwd=PARSER,stdout=log,stderr=log,start_new_session=True,env={**os.environ,'CARGO_NET_OFFLINE':'true','RUSTUP_AUTO_INSTALL':'0'})
            try:build.wait(timeout=180)
            finally:
                if build.poll() is None:
                    try:os.killpg(build.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                    build.wait(timeout=2)
        if build.returncode:
            result={'stage':'COMPILE','exitCode':build.returncode,'formalInputRead':False}
        else:
            stage='RUNTIME'
            result=shared.execute(binary,['--smoke'] if args.smoke else [str(args.input.resolve())])
            result['mode']='SYNTHETIC_SMOKE' if args.smoke else 'EXPLICIT_SINGLE_INPUT'
            if not args.smoke and result.get('coverage',{}).get('partitionAndReaderChecksPassed') is False:
                result['stopReason']='COVERAGE_PARTITION_OR_READER_MISMATCH'
            if not args.smoke and result.get('coverage',{}).get('coverageStatus')=='NO_ELIGIBLE_PLAYER_SAMPLES' and result.get('stopReason') is None:
                result['stopReason']='NO_ELIGIBLE_PLAYER_SAMPLES'
        with args.output.open('x') as output:json.dump(result,output,ensure_ascii=False,indent=2);output.write('\n')
        print(json.dumps(result,ensure_ascii=False))
        return 0 if result.get('exitCode')==0 and result.get('stopReason') is None else 1
    except subprocess.TimeoutExpired:
        with args.output.open('x') as output:json.dump({'stage':stage,'stopReason':stage+'_DEADLINE','formalInputRead':stage=='RUNTIME' and not args.smoke},output)
        print('EQUIPMENT_COVERAGE_'+stage+'_DEADLINE');return 1
    finally:
        example.unlink(missing_ok=True)
        for path in (PARSER/'target/release/examples').glob(name+'*'):
            if path.is_file():path.unlink()

if __name__=='__main__':raise SystemExit(main())
