#!/usr/bin/env node
// Merge chunks.json + review-notes.json into the final, validated manifest.json.
//
// review-notes.json shape:
// {
//   "order": ["<chunk id>", ...],                     // every chunk id exactly once
//   "annotations": {
//     "<chunk id>": { "description": "...", "orderRationale": "..." (optional) }
//   }
// }
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, validateManifest } from '../src/manifest.js';
import { readCurrentPointer } from '../src/review-paths.js';

// Real repo root, resolved through the symlink Node followed to load this file,
// so the printed command is an exact, copy-pasteable absolute path.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(repoRoot, 'viewer', 'server.js');
const quote = (p) => (/[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

const { values } = parseArgs({
  options: {
    chunks: { type: 'string' },
    notes: { type: 'string' },
    out: { type: 'string', short: 'o' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(
    'Usage: node bin/write-manifest.js [--chunks .review/chunks.json] [--notes .review/review-notes.json] [-o .review/manifest.json]'
  );
  process.exit(0);
}

// Default all three paths to the active review's directory (.review/<key>/),
// recorded by chunk.js. Fall back to the legacy flat .review/ layout.
const pointer = await readCurrentPointer(process.cwd());
const defaultDir = pointer ? path.resolve(pointer.dir) : path.resolve('.review');

const chunksPath = path.resolve(values.chunks ?? path.join(defaultDir, 'chunks.json'));
const notesPath = path.resolve(values.notes ?? path.join(defaultDir, 'review-notes.json'));
const outPath = path.resolve(values.out ?? path.join(defaultDir, 'manifest.json'));

async function readJson(p, label) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch (err) {
    console.error(`error: cannot read ${label} at ${p}: ${err.message}`);
    process.exit(1);
  }
}

const chunksDoc = await readJson(chunksPath, 'chunks file');
const notes = await readJson(notesPath, 'notes file');

const { manifest, errors } = buildManifest(chunksDoc, notes);
if (errors.length) {
  console.error(`manifest build failed with ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nFix review-notes.json and re-run (do not edit chunks.json).');
  process.exit(1);
}

const validation = validateManifest(manifest);
if (validation.length) {
  console.error('manifest failed validation:');
  for (const e of validation) console.error(`  - ${e}`);
  process.exit(1);
}

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote manifest with ${manifest.steps.length} step(s) to ${outPath}`);
// --repo pins the reviewed repo so the command works from any directory (the
// server serves <repo>/.review and runs git/gh there).
console.log('\nTo view it, run this exact command in your terminal (works from anywhere):\n');
console.log(`  node ${quote(serverPath)} --repo ${quote(process.cwd())}\n`);
console.log('Then open http://localhost:4173 . Leave it running; new reviews appear on refresh.');
