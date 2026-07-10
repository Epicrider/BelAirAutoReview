#!/usr/bin/env node
// Print a quick summary of a chunks.json or manifest.json file: counts by
// change kind and by language. Useful for sanity-checking a large diff before
// writing descriptions for every chunk.
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const { positionals, values } = parseArgs({
  options: { help: { type: 'boolean', short: 'h' } },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log('Usage: node bin/stats.js <chunks.json|manifest.json>');
  process.exit(values.help ? 0 : 1);
}

const filePath = path.resolve(positionals[0]);
let doc;
try {
  doc = JSON.parse(await fs.readFile(filePath, 'utf8'));
} catch (err) {
  console.error(`error: cannot read/parse ${filePath}: ${err.message}`);
  process.exit(1);
}
const items = doc.chunks ?? doc.steps ?? [];

if (items.length === 0) {
  console.log('No items found.');
  process.exit(0);
}

const byKind = {};
const byLanguage = {};
for (const item of items) {
  const kind = item.changeKind ?? 'unknown';
  const lang = item.language ?? 'unknown';
  byKind[kind] = (byKind[kind] ?? 0) + 1;
  byLanguage[lang] = (byLanguage[lang] ?? 0) + 1;
}

console.log(`${items.length} item(s) in ${path.basename(filePath)}\n`);
console.log('By change kind:');
for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(10)} ${count}`);
}
console.log('\nBy language:');
for (const [lang, count] of Object.entries(byLanguage).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${lang.padEnd(10)} ${count}`);
}
