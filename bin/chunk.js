#!/usr/bin/env node
// Mechanical chunking CLI (no LLM). Extracts the diff for a target and splits
// it into candidate review chunks, written to .review/chunks.json.
//
// Targets (pick one; defaults to --working):
//   --working                 uncommitted changes (working tree vs HEAD + untracked)
//   --range "A...B"           commit range (also A..B, or a single ref meaning ref...HEAD)
//   --pr <number|url>         GitHub PR via the gh CLI (add --repo owner/repo if
//                             running outside a checkout of that repo)
// Options:
//   -o, --out <path>          output path (default .review/chunks.json)
//   --cwd <path>              repo to operate on (default: current directory)
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectDiff } from '../src/diff.js';
import { chunkFiles } from '../src/chunker.js';
import { reviewDir, reviewKey, writeCurrentPointer } from '../src/review-paths.js';

const { values } = parseArgs({
  options: {
    working: { type: 'boolean' },
    range: { type: 'string' },
    pr: { type: 'string' },
    repo: { type: 'string' },
    out: { type: 'string', short: 'o' },
    cwd: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(
    'Usage: node bin/chunk.js [--working | --range "A...B" | --pr <number|url> [--repo owner/repo]] [-o out.json] [--cwd dir]'
  );
  process.exit(0);
}

const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
const modesSet = ['working', 'range', 'pr'].filter((m) => values[m] !== undefined);
if (modesSet.length > 1) {
  console.error(`Pick exactly one target, got: ${modesSet.map((m) => `--${m}`).join(', ')}`);
  process.exit(1);
}
const mode = modesSet[0] ?? 'working';

try {
  const { files, source, meta } = await collectDiff({
    mode,
    range: values.range,
    pr: values.pr,
    repo: values.repo,
    cwd,
  });
  const { chunks, warnings } = await chunkFiles(files, source);

  for (const w of warnings) console.error(`warning: ${w}`);

  // Each diff target gets its own .review/<key>/ directory so its artifacts and
  // comments never collide with those of other diffs.
  const key = reviewKey(meta.mode, meta.target);
  const dir = reviewDir(cwd, meta.mode, meta.target);
  const outPath = values.out ? path.resolve(cwd, values.out) : path.join(dir, 'chunks.json');

  const doc = {
    version: 1,
    ...meta,
    reviewKey: key,
    generatedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    chunks,
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(doc, null, 2) + '\n');
  await writeCurrentPointer(cwd, key);

  console.log(`Target: ${meta.target}${meta.title ? ` — ${meta.title}` : ''}`);
  console.log(`Review dir: ${path.relative(cwd, dir) || '.'}`);
  if (chunks.length === 0) {
    console.log('No changes found — nothing to review.');
    process.exit(0);
  }
  console.log(`Wrote ${chunks.length} chunk(s) to ${outPath}\n`);
  chunks.forEach((c, i) => {
    const tags = [c.changeKind, c.structural ? 'structural' : 'hunk'];
    console.log(
      `${String(i + 1).padStart(3)}. ${c.id}  [${tags.join(', ')}]${c.symbol ? `  ${c.symbol}` : ''}`
    );
  });
  console.log(
    `\nNext: write descriptions + a reading order into ${path.join(path.relative(cwd, dir) || '.', 'review-notes.json')}, then run bin/write-manifest.js.`
  );
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
