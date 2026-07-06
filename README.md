# BelAir Auto Review

Local tool for interactive, manual code review in two phases:

1. **Generate** a review manifest from a diff — chunked at function/class level,
   with a short description per chunk and a reading order optimized for
   comprehension (not file order).
2. **Browse** the manifest in a local web viewer (Monaco editor, diff view,
   step-by-step navigation) and type per-step comments that persist to disk.

There are two independent ways to generate a manifest:

| Path | What writes the descriptions/order | When to use |
|---|---|---|
| **Claude Skill** (`code-review-manifest`) | Claude itself, in your Claude Code session | You're already in a Claude Code session |
| **Standalone script** (`bin/generate-manifest.js`) | Direct Anthropic API calls | Headless / automated / no session |

Both share the same mechanical chunking code (`src/`) and produce the same
`manifest.json`, which the viewer consumes.

## Requirements

- Node.js ≥ 18.17 (you have 20.x — fine)
- `git`
- For **PR mode** only: the GitHub CLI — `brew install gh`, then `gh auth login`
  (for public repos an unauthenticated `gh` works at lower rate limits)
- For the **standalone script** only: `ANTHROPIC_API_KEY` in the environment

## Setup

```sh
cd /Users/omarh/Documents/Repos/BelAirAutoReview
npm install
```

That installs Monaco (vendored — the viewer works offline), the tree-sitter WASM
grammars used for structural chunking, and the Anthropic SDK.

### Install the skill

Symlink the skill into your personal skills directory so it's available in every
repo you open with Claude Code (symlink, not copy — the scripts resolve back into
this repo):

```sh
mkdir -p ~/.claude/skills
ln -s /Users/omarh/Documents/Repos/BelAirAutoReview/skills/code-review-manifest \
      ~/.claude/skills/code-review-manifest
```

### Sanity-checking a large diff

Before writing descriptions for every chunk, `bin/stats.js` prints a quick
breakdown of `chunks.json` (or a finished `manifest.json`) by change kind and
language — handy for spotting a diff that's much bigger than expected:

```sh
node bin/stats.js .review/chunks.json
```

## Phase 1a — generate via the skill (inside Claude Code)

Open Claude Code **in the repository you want to review** and ask for a review
manifest, naming the target:

- *"Prepare a review manifest for my uncommitted changes"* → working-tree diff
- *"Prepare a review manifest for `main...feature/foo`"* → commit range
  (`A...B` = changes on B since the merge base, like a PR; `A..B` = plain diff;
  a single ref means `ref...HEAD`; `empty` is a valid ref on either side and
  means the git empty tree — use `--range "empty...HEAD"` to review everything
  a ref contains from scratch, e.g. a repo's initial/root commit)
- *"Prepare a review manifest for PR 123"* or a full PR URL → GitHub PR via `gh`

Claude runs the chunking script, writes the descriptions and reading order
itself, and produces `.review/manifest.json` in the reviewed repo. If the target
is ambiguous, the skill instructs Claude to ask instead of guessing.

## Phase 1b — generate via the standalone script (no session)

Run from the repository you want to review (or pass `--cwd`):

```sh
export ANTHROPIC_API_KEY=sk-ant-...

# uncommitted changes
node /Users/omarh/Documents/Repos/BelAirAutoReview/bin/generate-manifest.js --working

# commit range
node .../bin/generate-manifest.js --range "main...feature/foo"

# GitHub PR (needs gh; --repo only when outside a checkout of that repo)
node .../bin/generate-manifest.js --pr 123 --repo owner/repo
node .../bin/generate-manifest.js --pr https://github.com/owner/repo/pull/123
```

Options: `-o <path>` (manifest output, default `.review/manifest.json`),
`--model <id>` (default `claude-opus-4-8`), `--batch-size <n>` (chunks per
description request, default 8).

This is a fully separate code path from the skill — it never shells out to
Claude Code, and the skill never calls the API.

## Phase 2 — browse in the viewer

From the reviewed repo (it picks up `./.review/manifest.json` by default):

```sh
node /Users/omarh/Documents/Repos/BelAirAutoReview/viewer/server.js
# or explicitly:
node .../viewer/server.js path/to/manifest.json --port 4173
```

Open http://localhost:4173. The viewer gives you:

- Monaco rendering with syntax highlighting per step (`language` field);
  a **side-by-side diff editor** when a step has `oldCode`, a read-only editor
  otherwise. Line numbers match the real file lines.
- The step's **description as a view zone** anchored above the code — it pushes
  the code down and scrolls with it.
- **Next/Prev** buttons (also `←`/`→` or `j`/`k`) stepping through the
  comprehension order, with a **"Step 4 of 23"** progress indicator.
- A **sidebar listing all steps grouped by file/line** for random access. Steps
  with an `orderRationale` show a ⓘ — hover for the rationale, click to pin it
  inline. Steps with comments show 💬.
- A **comment textarea** below each step. Comments autosave (debounced) to
  `comments.json` **next to the manifest** (`.review/comments.json`), keyed by
  step id, and reload on refresh. Clearing a comment deletes its key.

The editor is read-only throughout — this is a review tool, not an editor.

## How the pieces fit

```
repo under review
└── .review/
    ├── chunks.json         mechanical chunking output (no LLM)
    ├── review-notes.json   skill path only: Claude's descriptions + order
    ├── manifest.json       final manifest — the viewer's input
    └── comments.json       your comments, keyed by step id

BelAirAutoReview (this repo)
├── skills/code-review-manifest/   SKILL.md + wrapper scripts (symlink target)
├── src/                           shared: diff extraction, chunking, manifest schema
├── bin/chunk.js                   chunking CLI (used by the skill)
├── bin/write-manifest.js          chunks + notes → validated manifest (skill)
├── bin/generate-manifest.js       standalone API path (chunk + describe + order)
└── viewer/                        server.js + static app (Monaco from node_modules)
```

### Manifest format

```jsonc
{
  "steps": [
    {
      "id": "src/foo.ts:10-42",
      "file": "src/foo.ts",
      "startLine": 10,
      "endLine": 42,
      "code": "…new code for this range…",
      "oldCode": "…previous version (only in diff mode)…",
      "description": "2-4 sentences on what changed and why it matters.",
      "language": "typescript",
      "orderRationale": "optional — why this step comes here",
      // extras the viewer uses when present:
      "oldStartLine": 9, "symbol": "fooHandler", "changeKind": "modified"
    }
  ]
}
```

### Chunking behavior (deterministic, no LLM)

- Changed regions are expanded to their enclosing **function / method / class /
  type** via tree-sitter for JS/TS/TSX, Python, Go, Rust, Java, C, C++, C#,
  Ruby, and PHP. Other languages (and enclosing nodes over 200 lines) fall back
  to **hunk-based chunks** with 3 lines of context.
- Added files ≤ 120 lines become a single chunk; larger ones are segmented by
  top-level definitions. Deleted files become one chunk with `oldCode` (capped
  at 400 lines). Untracked files are included in `--working` mode. Binary files
  are skipped.

## Troubleshooting

- **"gh: Command not found"** — PR mode needs the GitHub CLI: `brew install gh`
  and `gh auth login`.
- **"tree-sitter unavailable … falling back to hunk-based chunking"** — run
  `npm install` in this repo; chunking still works, just less structurally.
- **Viewer shows "manifest not found"** — you started the server from a
  directory without `.review/manifest.json`; pass the manifest path explicitly.
- **`ANTHROPIC_API_KEY` unset** — only the standalone script needs it; the
  skill path uses your Claude Code session and needs no key.
