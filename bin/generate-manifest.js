#!/usr/bin/env node
// Standalone end-to-end manifest generation — no agent session needed.
// Chunks the diff mechanically (same code path as the skill), then calls the
// Anthropic API to write per-chunk descriptions and a comprehension-optimized
// reading order, and writes the same manifest.json the skill produces.
//
// Auth: ANTHROPIC_API_KEY environment variable.
//
// Targets (pick one; defaults to --working):
//   --working | --range "A...B" | --pr <number|url> [--repo owner/repo]
// Options:
//   -o, --out <path>     manifest output (default .review/manifest.json)
//   --model <id>         model (default claude-opus-4-8)
//   --batch-size <n>     chunks per description request (default 8)
//   --cwd <path>         repo to operate on
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectDiff } from '../src/diff.js';
import { chunkFiles } from '../src/chunker.js';
import { buildManifest, validateManifest } from '../src/manifest.js';
import { reviewDir, reviewKey, writeCurrentPointer } from '../src/review-paths.js';

const { values } = parseArgs({
  options: {
    working: { type: 'boolean' },
    range: { type: 'string' },
    pr: { type: 'string' },
    repo: { type: 'string' },
    out: { type: 'string', short: 'o' },
    model: { type: 'string' },
    'batch-size': { type: 'string' },
    cwd: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(
    'Usage: ANTHROPIC_API_KEY=... node bin/generate-manifest.js [--working | --range "A...B" | --pr <n|url> [--repo owner/repo]] [-o manifest.json] [--model claude-opus-4-8] [--batch-size 8]'
  );
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error(
    'error: no Anthropic credentials found. Set the ANTHROPIC_API_KEY environment variable.'
  );
  process.exit(1);
}

let Anthropic;
try {
  ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
} catch {
  console.error(
    'error: @anthropic-ai/sdk is not installed. Run `npm install` in the BelAirAutoReview repo.'
  );
  process.exit(1);
}

const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
const modesSet = ['working', 'range', 'pr'].filter((m) => values[m] !== undefined);
if (modesSet.length > 1) {
  console.error(`Pick exactly one target, got: ${modesSet.map((m) => `--${m}`).join(', ')}`);
  process.exit(1);
}
const mode = modesSet[0] ?? 'working';
const model = values.model ?? 'claude-opus-4-8';
const batchSize = Math.max(1, parseInt(values['batch-size'] ?? '8', 10) || 8);
// Resolved after the target is known (see below) unless -o was given explicitly.
let outPath = values.out ? path.resolve(cwd, values.out) : null;

const MAX_CODE_CHARS = 8000;
const truncate = (s) =>
  s.length > MAX_CODE_CHARS ? s.slice(0, MAX_CODE_CHARS) + '\n…[truncated]' : s;

const DESCRIBE_SYSTEM = `You are preparing a code-review manifest. For each chunk of a diff you are given, write a description of 2-4 sentences for a human reviewer:
- If the chunk has an old and a new version, describe what changed and why it likely matters.
- If the chunk is newly added code (no old version), describe what the code does.
- If the chunk is a deleted file, describe what was removed and the likely consequence.
Be specific and technical. Refer to functions, types, and config keys by name. Do not pad, do not speculate beyond what the code shows.`;

const DESC_SCHEMA = {
  type: 'object',
  properties: {
    descriptions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['id', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['descriptions'],
  additionalProperties: false,
};

const ORDER_SYSTEM = `You are ordering code-review chunks so a human reviewer builds understanding as they read, rather than following file or commit order. Apply these principles:
- New types, interfaces, and schemas come before the code that consumes them.
- New functions come before their callers.
- Config/schema/migration changes come before the code that reads them.
- High-level orchestration comes before deep implementation detail, unless a low-level piece is a prerequisite for understanding the orchestration.
- Keep closely related chunks adjacent; place deletions where their absence matters to the narrative.
Include EVERY chunk id exactly once. For each chunk, give a one-sentence rationale for why it sits where it does (its role in the reading order).`;

const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    order: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['id', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['order'],
  additionalProperties: false,
};

function chunkPromptBlock(c) {
  const head = [
    `### Chunk ${c.id}`,
    `file: ${c.file} | lines ${c.startLine}-${c.endLine} | kind: ${c.changeKind}` +
      (c.symbol ? ` | symbol: ${c.symbol}` : '') +
      (c.renamedFrom ? ` | renamed from: ${c.renamedFrom}` : ''),
  ];
  const parts = [head.join('\n')];
  if (typeof c.oldCode === 'string') {
    parts.push(`--- old version ---\n${truncate(c.oldCode)}`);
  }
  parts.push(`--- ${typeof c.oldCode === 'string' ? 'new version' : 'code'} ---\n${truncate(c.code)}`);
  return parts.join('\n');
}

async function callStructured(client, { system, user, schema, maxTokens }) {
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') {
    throw new Error('the model refused this request (stop_reason: refusal)');
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error('response hit max_tokens — try a smaller --batch-size');
  }
  const text = msg.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('model returned no text content');
  return JSON.parse(text);
}

try {
  console.log(`Collecting diff (${mode})…`);
  const { files, source, meta } = await collectDiff({
    mode,
    range: values.range,
    pr: values.pr,
    repo: values.repo,
    cwd,
  });
  const { chunks, warnings } = await chunkFiles(files, source);
  for (const w of warnings) console.error(`warning: ${w}`);

  if (chunks.length === 0) {
    console.log(`No changes found for ${meta.target} — nothing to review.`);
    process.exit(0);
  }
  console.log(`Chunked into ${chunks.length} chunk(s). Target: ${meta.target}`);

  // Each diff target gets its own .review/<key>/ directory.
  const key = reviewKey(meta.mode, meta.target);
  if (!outPath) outPath = path.join(reviewDir(cwd, meta.mode, meta.target), 'manifest.json');

  // Keep the intermediate chunks file next to the manifest for debugging/re-runs.
  const chunksDoc = {
    version: 1,
    ...meta,
    reviewKey: key,
    generatedAt: new Date().toISOString(),
    chunkCount: chunks.length,
    chunks,
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(
    path.join(path.dirname(outPath), 'chunks.json'),
    JSON.stringify(chunksDoc, null, 2) + '\n'
  );

  const client = new Anthropic();

  // Phase A: descriptions, in batches.
  const annotations = {};
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    console.log(
      `Describing chunks ${i + 1}-${i + batch.length} of ${chunks.length} (${model})…`
    );
    const user =
      `Review target: ${meta.target}${meta.title ? ` — ${meta.title}` : ''}\n\n` +
      `Write a description for each of the following ${batch.length} chunks.\n\n` +
      batch.map(chunkPromptBlock).join('\n\n');
    const result = await callStructured(client, {
      system: DESCRIBE_SYSTEM,
      user,
      schema: DESC_SCHEMA,
      maxTokens: 16000,
    });
    for (const d of result.descriptions ?? []) {
      if (d.id && d.description) annotations[d.id] = { description: d.description };
    }
    for (const c of batch) {
      if (!annotations[c.id]) {
        console.error(`warning: model returned no description for ${c.id}; retrying alone…`);
        const single = await callStructured(client, {
          system: DESCRIBE_SYSTEM,
          user: `Review target: ${meta.target}\n\nWrite a description for this chunk.\n\n${chunkPromptBlock(c)}`,
          schema: DESC_SCHEMA,
          maxTokens: 4000,
        });
        const d = (single.descriptions ?? [])[0];
        if (!d?.description) throw new Error(`could not obtain a description for ${c.id}`);
        annotations[c.id] = { description: d.description };
      }
    }
  }

  // Phase B: reading order over chunk summaries.
  console.log('Determining reading order…');
  const summaryList = chunks
    .map(
      (c) =>
        `- ${c.id} | ${c.changeKind}${c.symbol ? ` | ${c.symbol}` : ''} | ${annotations[c.id].description.replace(/\s+/g, ' ')}`
    )
    .join('\n');
  const orderResult = await callStructured(client, {
    system: ORDER_SYSTEM,
    user:
      `Review target: ${meta.target}${meta.title ? ` — ${meta.title}` : ''}\n\n` +
      `Order these ${chunks.length} chunks for reviewer comprehension:\n\n${summaryList}`,
    schema: ORDER_SCHEMA,
    maxTokens: 32000,
  });

  // Reconcile: dedupe, drop unknowns, append anything the model missed.
  const known = new Set(chunks.map((c) => c.id));
  const order = [];
  const seen = new Set();
  for (const entry of orderResult.order ?? []) {
    if (!known.has(entry.id)) {
      console.error(`warning: dropping unknown id from model order: ${entry.id}`);
      continue;
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    order.push(entry.id);
    if (entry.rationale?.trim()) annotations[entry.id].orderRationale = entry.rationale.trim();
  }
  for (const c of chunks) {
    if (!seen.has(c.id)) {
      console.error(`warning: model omitted ${c.id} from the order; appending at the end`);
      order.push(c.id);
    }
  }

  const { manifest, errors } = buildManifest(chunksDoc, { order, annotations });
  if (errors.length) {
    for (const e of errors) console.error(`  - ${e}`);
    throw new Error('manifest build failed');
  }
  const validation = validateManifest(manifest);
  if (validation.length) {
    for (const e of validation) console.error(`  - ${e}`);
    throw new Error('manifest failed validation');
  }

  await fs.writeFile(outPath, JSON.stringify(manifest, null, 2) + '\n');
  await writeCurrentPointer(cwd, key);
  console.log(`\nWrote manifest with ${manifest.steps.length} step(s) to ${outPath}`);
  console.log('View it with: node <BelAirAutoReview>/viewer/server.js  (from this repo)');
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
