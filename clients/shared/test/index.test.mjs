import assert from 'node:assert/strict';
import test from 'node:test';
import {formatBytes} from '../src/index.ts';

test('formatBytes uses readable decimal units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.match(formatBytes(1_000), /^1(?:[.,]0)? KB$/);
  assert.match(formatBytes(15_200_000_000), /^15[.,]2 GB$/);
  assert.match(formatBytes(1_000_000_000_000), /^1(?:[.,]0)? TB$/);
});
