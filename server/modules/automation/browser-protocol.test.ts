import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_PROTOCOL_VERSION,
  BrowserNdjsonDecoder,
  assertBrowserExpectedTarget,
  parseBrowserExpectedTarget,
  safeSessionId,
  serializeBrowserFrame,
  type BrowserRequestFrame,
} from './browser-protocol.js';

test('browser protocol decodes split and coalesced NDJSON frames', () => {
  const frame: BrowserRequestFrame = {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    kind: 'request',
    id: 'request-1',
    method: 'status',
    payload: {},
  };
  const decoder = new BrowserNdjsonDecoder();
  const serialized = serializeBrowserFrame(frame);

  assert.deepEqual(decoder.push(serialized.slice(0, 7)), []);
  assert.deepEqual(decoder.push(`${serialized.slice(7)}${serialized}`), [frame, frame]);
});
test('browser session identifiers reject traversal and control characters', () => {
  assert.equal(safeSessionId('session-1:browser'), true);
  assert.equal(safeSessionId('../session'), false);
  assert.equal(safeSessionId('session\n2'), false);
  assert.equal(safeSessionId(''), false);
});

test('browser decoder rejects a non-protocol JSON object', () => {
  const decoder = new BrowserNdjsonDecoder();
  assert.throws(() => decoder.push('{"kind":"request"}\n'), /Invalid browser protocol frame/);
});

test('managed target parsing fails closed and reserves null tabs for open', () => {
  assert.equal(parseBrowserExpectedTarget(undefined), undefined);
  for (const value of [null, {}, { tabId: '' }, { tabId: null }, { tabId: 'a', extra: true }, { tabId: 'a', origin: 'https://example.test/path' }]) {
    assert.throws(() => parseBrowserExpectedTarget(value), /invalid_target/);
  }
  assert.deepEqual(parseBrowserExpectedTarget({ tabId: null }, true), { tabId: null });
});

test('managed fence rejects tab and origin drift but checks navigation destination', () => {
  const expected = { tabId: 'approved', origin: 'https://approved.test' };
  assert.throws(() => assertBrowserExpectedTarget(expected, 'foreign', 'approved', 'https://approved.test'), /target_changed/);
  assert.throws(() => assertBrowserExpectedTarget(expected, 'approved', 'foreign', 'https://approved.test'), /target_changed/);
  assert.throws(() => assertBrowserExpectedTarget(expected, 'approved', 'approved', 'https://foreign.test'), /target_changed/);
  assert.doesNotThrow(() => assertBrowserExpectedTarget(expected, 'approved', 'approved', 'https://old.test', 'https://approved.test/path'));
  assert.throws(() => assertBrowserExpectedTarget(expected, 'approved', 'approved', 'https://approved.test', 'https://foreign.test'), /target_changed/);
  assert.throws(() => assertBrowserExpectedTarget({ tabId: null }, 'new-tab', 'new-tab'), /target_changed/);
  assert.doesNotThrow(() => assertBrowserExpectedTarget({ tabId: null }, null, null));
});
