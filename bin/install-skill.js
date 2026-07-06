#!/usr/bin/env node
// Symlink the code-review-manifest skill into the personal skills directory of
// one or both supported agents, so it's available in every repo you review.
//
// The skill dir is symlinked (not copied) on purpose: the wrapper scripts
// resolve back into this repo via relative imports, which only works if the
// real path stays inside the repo.
//
// Targets:
//   --all      install into every agent that's present (default)
//   --claude   install into ~/.claude/skills only
//   --cursor   install into ~/.cursor/skills only
// Options:
//   --force    replace an existing non-symlink directory at the target
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'code-review-manifest';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillSource = path.join(repoRoot, 'skills', SKILL_NAME);

const AGENTS = [
  { flag: 'claude', label: 'Claude Code', dir: path.join(os.homedir(), '.claude', 'skills') },
  { flag: 'cursor', label: 'Cursor', dir: path.join(os.homedir(), '.cursor', 'skills') },
];

const { values } = parseArgs({
  options: {
    all: { type: 'boolean' },
    claude: { type: 'boolean' },
    cursor: { type: 'boolean' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  console.log(
    'Usage: node bin/install-skill.js [--all | --claude | --cursor] [--force]\n' +
      '  --all      install into every agent whose home dir exists (default)\n' +
      '  --claude   install into ~/.claude/skills only\n' +
      '  --cursor   install into ~/.cursor/skills only\n' +
      '  --force    replace an existing non-symlink directory at the target'
  );
  process.exit(0);
}

// Which agents were explicitly requested? If none, treat as --all.
const explicit = AGENTS.filter((a) => values[a.flag]);
const selected = explicit.length > 0 ? explicit : AGENTS;
const requireAgentHome = explicit.length === 0; // --all only touches agents already set up

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function installFor(agent) {
  const agentHome = path.dirname(agent.dir); // ~/.claude or ~/.cursor
  if (requireAgentHome && !(await exists(agentHome))) {
    console.log(`- ${agent.label}: skipped (${agentHome} not found)`);
    return { skipped: true };
  }

  await fs.mkdir(agent.dir, { recursive: true });
  const target = path.join(agent.dir, SKILL_NAME);

  const stat = await fs.lstat(target).catch(() => null);
  if (stat) {
    if (stat.isSymbolicLink()) {
      const current = await fs.readlink(target).catch(() => null);
      if (current && path.resolve(agent.dir, current) === skillSource) {
        console.log(`- ${agent.label}: already linked (${target})`);
        return { linked: true };
      }
      await fs.rm(target);
    } else if (values.force) {
      await fs.rm(target, { recursive: true, force: true });
    } else {
      console.error(
        `- ${agent.label}: ${target} exists and is not a symlink; pass --force to replace it`
      );
      return { error: true };
    }
  }

  await fs.symlink(skillSource, target);
  console.log(`- ${agent.label}: linked ${target} -> ${skillSource}`);
  return { linked: true };
}

if (!(await exists(skillSource))) {
  console.error(`error: skill source not found at ${skillSource}`);
  process.exit(1);
}

let hadError = false;
console.log(`Installing "${SKILL_NAME}" skill from ${skillSource}\n`);
for (const agent of selected) {
  const result = await installFor(agent);
  if (result.error) hadError = true;
}

process.exit(hadError ? 1 : 0);
