import assert from 'node:assert/strict';
import test from 'node:test';

// Offline specification, not an installed parser change. Mirrors the pinned
// source2-demo 0.5.4 SliceReader::read_var_i32 after read_var_u32 (slice.rs:155).
const pinnedSignedDecode = wire => {
  const ux = wire | 0;
  return (ux & 1) !== 0 ? ~(ux >> 1) : ux >> 1;
};
const attemptedInverse = decoded => (((decoded >>> 0) << 1) ^ (decoded >> 31)) >>> 0;
// Proposed consumer rule AFTER an upstream field-specific Unsigned32 decoder.
const clipFromPreservedWire = raw => Number.isInteger(raw) && raw > 0 && raw <= 256 ? raw - 1 : undefined;

// Do not read Demo files: these are the finite wire-domain counterexamples.
test('pinned signed decode loses information before a caller can validate raw clip bounds', () => {
  for (const [valid, high] of [[1, 0xfffffffe], [31, 0xffffffe0]]) {
    assert.equal(pinnedSignedDecode(valid), pinnedSignedDecode(high));
    assert.equal(attemptedInverse(pinnedSignedDecode(high)), valid);
    assert.equal(clipFromPreservedWire(high), undefined);
  }
  assert.equal(pinnedSignedDecode(31), -16);
  assert.equal(clipFromPreservedWire(attemptedInverse(-16)), 30);
  // The plausible 30 cannot distinguish a valid sample from the high-bit wire.
});

test('proposed unsigned field rule distinguishes unknown wire zero from known empty wire one', () => {
  const rows = [[0, undefined], [1, 0], [31, 30], [41, 40], [101, 100], [256, 255], [257, undefined], [0xfffffffe, undefined], [0xffffffff, undefined], [-1, undefined], [1.5, undefined]];
  for (const [raw, expected] of rows) assert.equal(clipFromPreservedWire(raw), expected);
});

test('the proposed decoder override is CS2 m_iClip1 only; ordinary int32 stays signed', () => {
  const proposedDecoder = (game, name) => game === 'cs2' && name === 'm_iClip1' ? 'Unsigned32' : 'Signed32';
  assert.equal(proposedDecoder('cs2', 'm_iClip1'), 'Unsigned32');
  assert.equal(proposedDecoder('cs2', 'm_iHealth'), 'Signed32');
  assert.equal(proposedDecoder('cs2', 'm_iClip2'), 'Signed32');
  assert.equal(proposedDecoder('dota', 'm_iClip1'), 'Signed32');
});
