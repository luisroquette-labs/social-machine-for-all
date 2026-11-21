import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findComments, check } from './check-comments.mjs';

test('counts JS, TS, and JSX comments without counting markers in strings', () => {
  assert.deepEqual(findComments('example.ts', 'const url = "https://example.com";\nconst value = 1; // remove'), [2]);
  assert.deepEqual(findComments('example.tsx', 'const view = <div>{/* remove */}</div>;'), [1]);
});

test('counts every line of a multiline comment', () => {
  assert.deepEqual(findComments('example.ts', '/* old\nnew */'), [1, 2]);
});

test('rejects a new comment and requires tightening after a removal', () => {
  assert.deepEqual(check({ 'a.ts': 1 }, { 'a.ts': 0 }), ['a.ts: 1 comment lines; allowed 0']);
  assert.deepEqual(check({ 'a.ts': 0 }, { 'a.ts': 1 }), ['a.ts: baseline is stale (0 comment lines; allowed 1)']);
  assert.deepEqual(check({}, { 'a.ts': 1 }), ['a.ts: baseline is stale (0 comment lines; allowed 1)']);
});
