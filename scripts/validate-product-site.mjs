import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const docs = resolve(root, 'docs');
const html = await readFile(resolve(docs, 'index.html'), 'utf8');
const h1Count = (html.match(/<h1\b/g) || []).length;
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const tabs = (html.match(/role="tab"/g) || []).length;
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1].split('?', 1)[0])
  .filter((ref) => ref && !/^(?:#|https?:|data:|mailto:)/.test(ref));

if (h1Count !== 1) throw new Error(`Expected one H1, found ${h1Count}`);
if (ids.length !== new Set(ids).size) throw new Error('Duplicate IDs found');
if (tabs !== 3) throw new Error(`Expected three automation tabs, found ${tabs}`);
if (!html.includes('Illustrative controls only')) throw new Error('Simulation boundary is missing');
if (!html.includes('https://luisroquette-labs.github.io/social-machine-for-all/') || html.includes('cfgauss-ai')) throw new Error('Product site still points to the previous GitHub owner');
await Promise.all(refs.map((ref) => access(resolve(docs, ref))));
console.log(`Product site validation passed: one H1, ${ids.length} unique IDs, three stages, explicit boundary, no missing assets`);
