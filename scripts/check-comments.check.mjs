import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findComments, check } from './check-comments.mjs';

test('identifies source comments without mistaking URLs or strings for comments', () => {
  const source = 'const url = "https://example.com";\nconst value = 1; // remove\n';
  assert.deepEqual(findComments('example.ts', source), [2]);
});

test('identifies JSX comments and allows no extra comment in another file', () => {
  assert.deepEqual(findComments('example.tsx', 'const view = <div>{/* remove */}</div>;'), [1]);
  assert.deepEqual(check({ 'a.ts': 1, 'b.ts': 1 }, { 'a.ts': 2 }), ['b.ts: 1 comment lines; allowed 0']);
});

test('ignores shebangs and SQL markers inside strings', () => {
  assert.deepEqual(findComments('run.sh', '#!/bin/sh\necho "# text"\n# remove'), [3]);
  assert.deepEqual(findComments('query.sql', "select '-- text';\n-- remove"), [2]);
});

test('ratchets every line of multiline comments', () => {
  for (const file of ['example.ts', 'example.css', 'query.sql', 'page.html']) {
    const block = file.endsWith('html') ? '<!-- old\nnew -->' : '/* old\nnew */';
    assert.deepEqual(findComments(file, block), [1, 2]);
    assert.deepEqual(check({ [file]: findComments(file, block).length }, { [file]: 1 }),
      [`${file}: 2 comment lines; allowed 1`]);
  }
});

test('apostrophes inside CSS and SQL comments cannot hide later comments', () => {
  assert.deepEqual(findComments('example.css', "/* don't */\n/* it's new */"), [1, 2]);
  assert.deepEqual(findComments('query.sql', "-- don't\n-- it's new"), [1, 2]);
});
