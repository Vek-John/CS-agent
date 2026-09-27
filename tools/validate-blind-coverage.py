#!/usr/bin/env python3
"""Bounded event-only coverage. --smoke reads no Demo; --input is an explicit one-pass scan.
Compilation uses cached dependencies offline. Runtime limits exclude Cargo and monitor
only the owned native child; sampledPeakRssBytes can miss between-poll peaks.
"""
import argparse
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
PARSER = ROOT / '.local-data/upstream/cs2d/packages/parser'
CAP = 128 * 1024 * 1024

def block(source, marker):
    start = source.index(marker)
    cursor = source.index('{', start) + 1
    depth = 1
    while depth:
        depth += (source[cursor] == '{') - (source[cursor] == '}')
        cursor += 1
    return source[start:cursor]

def execute(binary, arguments):
    started = time.monotonic()
    child = subprocess.Popen([str(binary), *arguments], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)
    selector = selectors.DefaultSelector()
    output = bytearray()
    total = 0
    peak = 0
    reason = None
    reaped = False
    max_rss = 0
    def poll_owned():
        nonlocal reaped, max_rss
        if not reaped:
            pid, status, usage = os.wait4(child.pid, os.WNOHANG)
            if pid:
                reaped = True
                child.returncode = os.waitstatus_to_exitcode(status)
                max_rss = int(usage.ru_maxrss) * (1 if sys.platform == 'darwin' else 1024)
        return child.returncode
    def kill_owned():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    for stream in (child.stdout, child.stderr):
        selector.register(stream, selectors.EVENT_READ)
    try:
        while selector.get_map() or poll_owned() is None:
            if time.monotonic() - started > 45:
                reason = 'RUNTIME_DEADLINE'
                break
            if poll_owned() is None:
                try:
                    sample = subprocess.run(['ps', '-o', 'rss=', '-p', str(child.pid)], capture_output=True, timeout=1)
                except subprocess.TimeoutExpired:
                    reason = 'RUNTIME_MONITOR_TIMEOUT'
                    break
                except OSError:
                    reason = 'RUNTIME_MONITOR_FAILED'
                    break
                try:
                    rss = int(sample.stdout.strip()) * 1024
                    peak = max(peak, rss)
                    if rss > 512 * 1024 * 1024:
                        reason = 'RUNTIME_RSS_LIMIT'
                        break
                except ValueError:
                    pass
            for key, _ in selector.select(0.025):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                total += len(chunk)
                if total > 32 * 1024:
                    reason = 'RUNTIME_OUTPUT_LIMIT'
                    break
                if key.fileobj is child.stdout:
                    output.extend(chunk)
            if reason:
                break
        if reason and not reaped:
            kill_owned()
        deadline = time.monotonic() + 2
        while poll_owned() is None and time.monotonic() < deadline:
            time.sleep(0.01)
        code = child.returncode
        if max_rss > 512 * 1024 * 1024 and reason is None:
            reason = 'RUNTIME_RSS_LIMIT_OBSERVED_AT_EXIT'
        result = {'exitCode': code, 'stopReason': reason, 'elapsedMs': round((time.monotonic()-started)*1000),
                  'sampledPeakRssBytes': peak, 'ownedChildMaxRssBytes': max_rss, 'outputBytes': total, 'runtimeRssBudgetBytes': 512*1024*1024,
                  'runtimeDeadlineSeconds': 45, 'inputCapBytes': CAP}
        if code == 0 and reason is None:
            try:
                result['coverage'] = json.loads(output)
                if result['coverage'].get('complete') is False:
                    result['stopReason'] = 'PARSE_INCOMPLETE'
            except (ValueError, UnicodeError):
                result['stopReason'] = 'INVALID_SUMMARY'
        return result
    finally:
        if poll_owned() is None:
            kill_owned()
            child.wait(timeout=2)
        selector.close()
        child.stdout.close()
        child.stderr.close()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--smoke', action='store_true')
    mode.add_argument('--input', type=Path)
    parser.add_argument('--player', help='Exact current controller name; never printed')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('Output already exists; preserve prior results and select a new path.')
    if args.input and args.input.stat().st_size > CAP:
        parser.error('INPUT_TOO_LARGE')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    name = 'cs_coach_blind_coverage_' + uuid.uuid4().hex[:10]
    example = PARSER / 'examples' / (name + '.rs')
    binary = PARSER / 'target/release/examples' / name
    source = (ROOT/'tools/cs2d-host/fixtures/blind-coverage.rs').read_text()
    props = (PARSER/'src/props.rs').read_text()
    source = source.replace('// CURRENT_EVENT_CONTROLLER_OWNER', block(props, 'pub(crate) fn event_controller_owner('))
    tests = (ROOT/'vendor/source2-demo/src/tests.rs').read_text()
    helpers = '\n'.join(block(tests, 'fn '+name+'(') for name in [
        'replay_with_messages', 'replay_with_playback_ticks', 'sync_payload', 'demo_packet_payload', 'packet_data'])
    source = source.replace('// VENDOR_SYNTHETIC_WRITERS',
                            'use source2_demo::writer::{write_demo_message, BitstreamWriter, BitsWriter};\n'+helpers)
    example.parent.mkdir(exist_ok=True)
    example.write_text(source)
    compile_log = args.output.with_suffix('.compile.txt')
    command = ['cargo', 'build', '--offline', '--locked', '--release', '--no-default-features',
               '--example', name, '--config', 'patch.crates-io.source2-demo.path='+json.dumps(str(ROOT/'vendor/source2-demo'))]
    stage = 'COMPILE'
    try:
        with compile_log.open('w') as log:
            built = subprocess.Popen(command, cwd=PARSER, env={**os.environ, 'CARGO_NET_OFFLINE':'true', 'RUSTUP_AUTO_INSTALL':'0'},
                                     stdout=log, stderr=log, start_new_session=True)
            try:
                built.wait(timeout=180)
            finally:
                if built.poll() is None:
                    try:
                        os.killpg(built.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    built.wait(timeout=2)
        if built.returncode != 0:
            result = {'stage':'COMPILE', 'exitCode':built.returncode, 'formalInputRead':False}
        else:
            native_args = ['--smoke'] if args.smoke else [str(args.input.resolve())] + ([args.player] if args.player else [])
            stage = 'RUNTIME'
            result = execute(binary, native_args)
            result['mode'] = 'SYNTHETIC_SMOKE' if args.smoke else 'EXPLICIT_SINGLE_INPUT'
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get('exitCode') == 0 and result.get('stopReason') is None else 1
    except subprocess.TimeoutExpired:
        args.output.write_text(json.dumps({'stage':stage,'stopReason':stage+'_DEADLINE','formalInputRead':stage=='RUNTIME' and not args.smoke})+'\n')
        print('BLIND_COVERAGE_'+stage+'_DEADLINE')
        return 1
    finally:
        example.unlink(missing_ok=True)
        # Names are unique per run; remove only the executable/dependency artifacts created for this example.
        for path in (PARSER/'target/release/examples').glob(name+'*'):
            if path.is_file(): path.unlink()

if __name__ == '__main__':
    raise SystemExit(main())
