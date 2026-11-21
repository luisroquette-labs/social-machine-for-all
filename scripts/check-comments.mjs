import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import parser from '@typescript-eslint/parser';

const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'comment-baseline.json');
const sourcePattern = /\.[cm]?[jt]sx?$/;

export function findComments(file, source) {
  const comments = parser.parse(source, { filePath: file, comment: true, jsx: true, sourceType: 'module' }).comments;
  return [...new Set(comments.flatMap(comment => Array.from(
    { length: comment.loc.end.line - comment.loc.start.line + 1 },
    (_, index) => comment.loc.start.line + index,
  )))];
}

function counts() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString().split('\0').filter(file => sourcePattern.test(file) && fs.existsSync(file));
  return Object.fromEntries(files.sort().map(file => [file, findComments(file, fs.readFileSync(file, 'utf8')).length]));
}

export function check(current, baseline) {
  return [...new Set([...Object.keys(current), ...Object.keys(baseline)])].flatMap(file => {
    const count = current[file] ?? 0;
    const allowed = baseline[file] ?? 0;
    if (count > allowed) return [`${file}: ${count} comment lines; allowed ${allowed}`];
    if (count < allowed) return [`${file}: baseline is stale (${count} comment lines; allowed ${allowed})`];
    return [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const current = counts();
  if (process.argv.includes('--write-baseline')) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
  } else {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const failures = check(current, baseline);
    if (failures.length) {
      console.error(`Comment ratchet failed:\n${failures.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log(`Comment ratchet passed: ${Object.values(current).reduce((a, b) => a + b, 0)} remaining comment lines in JS/TS.`);
    }
  }
}
