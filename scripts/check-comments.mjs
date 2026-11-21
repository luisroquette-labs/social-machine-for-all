import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import parser from '@typescript-eslint/parser';

const baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'comment-baseline.json');
const sourcePattern = /\.(?:[cm]?[jt]sx?|css|html|sql|ya?ml|sh)$/;

function stripQuoted(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, value => ' '.repeat(value.length));
}

export function findComments(file, source) {
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const comments = parser.parse(source, { filePath: file, comment: true, jsx: true, sourceType: 'module' }).comments;
    return [...new Set(comments.flatMap(comment => Array.from(
      { length: comment.loc.end.line - comment.loc.start.line + 1 },
      (_, index) => comment.loc.start.line + index,
    )))];
  }
  const lines = [];
  const add = (offset) => lines.push(source.slice(0, offset).split('\n').length);
  const addRange = (offset, value) => {
    const first = source.slice(0, offset).split('\n').length;
    for (let index = 0; index < value.split('\n').length; index++) lines.push(first + index);
  };
  if (/\.html$/.test(file)) {
    const masked = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, value => value.replace(/[^\n]/g, ' '));
    for (const match of masked.matchAll(/<!--[\s\S]*?-->/g)) addRange(match.index, match[0]);
  } else if (/\.(?:css|sql)$/.test(file)) {
    const sql = file.endsWith('.sql');
    for (let index = 0; index < source.length;) {
      const start = index;
      if (source.startsWith('/*', index)) {
        const end = source.indexOf('*/', index + 2);
        index = end < 0 ? source.length : end + 2;
        addRange(start, source.slice(start, index));
      } else if (sql && source.startsWith('--', index)) {
        const end = source.indexOf('\n', index + 2);
        index = end < 0 ? source.length : end;
        add(start);
      } else if (sql && source[index] === '$') {
        const tag = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(source.slice(index))?.[0];
        if (tag) {
          const end = source.indexOf(tag, index + tag.length);
          index = end < 0 ? source.length : end + tag.length;
        } else index++;
      } else if (source[index] === '"' || source[index] === "'") {
        const quote = source[index++];
        while (index < source.length) {
          if (source[index] === '\\') { index += 2; continue; }
          if (source[index] === quote) {
            if (sql && source[index + 1] === quote) { index += 2; continue; }
            index++;
            break;
          }
          index++;
        }
      } else {
        index++;
      }
    }
  } else {
    let offset = 0;
    let heredoc = null;
    for (const [index, raw] of source.split('\n').entries()) {
      if (heredoc) {
        if ((heredoc.tabs ? raw.replace(/^\t+/, '') : raw) === heredoc.name) heredoc = null;
        offset += raw.length + 1;
        continue;
      }
      if (!(index === 0 && raw.startsWith('#!'))) {
        const line = stripQuoted(raw);
        const marker = file === '.gitignore' ? /^#/.exec(line) : /(^|[\s;|&()])#/.exec(line);
        if (marker) add(offset + marker.index + (marker[1]?.length ?? 0));
        if (/\.sh$/.test(file)) {
          const opener = /<<(-?)/g;
          for (const match of line.matchAll(opener)) {
            if (marker && match.index > marker.index) break;
            const token = /^\s*(['"]?)([A-Za-z_][A-Za-z_0-9-]*)\1(?=\s|[;|&<>]|$)/.exec(raw.slice(match.index + match[0].length));
            if (token) { heredoc = { name: token[2], tabs: match[1] === '-' }; break; }
          }
        }
      }
      offset += raw.length + 1;
    }
  }
  return [...new Set(lines)];
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString().split('\0')
    .filter(file => (sourcePattern.test(file) || ['.gitignore', '.env.example', '.githooks/pre-push'].includes(file))
      && !file.startsWith('graphify-out/') && fs.existsSync(file));
}

function counts(files = trackedFiles()) {
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
      console.log(`Comment ratchet passed: ${Object.values(current).reduce((a, b) => a + b, 0)} remaining comment lines.`);
    }
  }
}
