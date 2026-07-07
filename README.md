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
| **Agent Skill** (`code-review-manifest`) | The agent itself, in your Claude Code or Cursor session | You're already in an agent session |
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

Clone this repo, then from its root:

```sh
npm install
```

That installs Monaco (vendored — the viewer works offline), the tree-sitter WASM
grammars used for structural chunking, and the Anthropic SDK.

### Install the skill

The skill works in both **Claude Code** and **Cursor** — they use the same
`SKILL.md` format. It's symlinked (not copied) into each agent's personal skills
directory so it's available in every repo you open, and so the wrapper scripts
resolve back into this repo:

```sh
npm run install-skill
```

By default this links into every agent whose home directory exists
(`~/.claude/skills` and/or `~/.cursor/skills`). Restrict with `--claude` or
`--cursor`, and pass `--force` to replace an existing non-symlink directory:

```sh
npm run install-skill -- --cursor          # Cursor only
npm run install-skill -- --claude --force   # Claude only, replacing any existing dir
```

Prefer to do it by hand? Symlink the skill directory into the agent(s) you use
(replace `<repo>` with the absolute path to this repo):

```sh
# Claude Code
mkdir -p ~/.claude/skills
ln -s <repo>/skills/code-review-manifest ~/.claude/skills/code-review-manifest

# Cursor
mkdir -p ~/.cursor/skills
ln -s <repo>/skills/code-review-manifest ~/.cursor/skills/code-review-manifest
```

### Sanity-checking a large diff

Before writing descriptions for every chunk, `bin/stats.js` prints a quick
breakdown of `chunks.json` (or a finished `manifest.json`) by change kind and
language — handy for spotting a diff that's much bigger than expected:

```sh
node bin/stats.js .review/chunks.json
```

## Phase 1a — generate via the skill (inside Claude Code or Cursor)

Open your agent (Claude Code or Cursor) **in the repository you want to review**
and ask for a review manifest, naming the target:

- *"Prepare a review manifest for my uncommitted changes"* → working-tree diff
- *"Prepare a review manifest for `main...feature/foo`"* → commit range
  (`A...B` = changes on B since the merge base, like a PR; `A..B` = plain diff;
  a single ref means `ref...HEAD`; `empty` is a valid ref on either side and
  means the git empty tree — use `--range "empty...HEAD"` to review everything
  a ref contains from scratch, e.g. a repo's initial/root commit)
- *"Prepare a review manifest for PR 123"* or a full PR URL → GitHub PR via `gh`

The agent runs the chunking script, writes the descriptions and reading order
itself, and produces `.review/manifest.json` in the reviewed repo. If the target
is ambiguous, the skill instructs the agent to ask instead of guessing.

## Phase 1b — generate via the standalone script (no session)

Run from the repository you want to review (or pass `--cwd`):

```sh
export ANTHROPIC_API_KEY=sk-ant-...

# uncommitted changes (replace <repo> with the absolute path to this repo)
node <repo>/bin/generate-manifest.js --working

# commit range
node <repo>/bin/generate-manifest.js --range "main...feature/foo"

# GitHub PR (needs gh; --repo only when outside a checkout of that repo)
node <repo>/bin/generate-manifest.js --pr 123 --repo owner/repo
node <repo>/bin/generate-manifest.js --pr https://github.com/owner/repo/pull/123
```

Options: `-o <path>` (manifest output, default `.review/manifest.json`),
`--model <id>` (default `claude-opus-4-8`), `--batch-size <n>` (chunks per
description request, default 8).

This is a fully separate code path from the skill — it never shells out to an
agent, and the skill never calls the API.

## Phase 2 — browse in the viewer

From the reviewed repo (it picks up `./.review/manifest.json` by default):

```sh
node <repo>/viewer/server.js
# or explicitly:
node <repo>/viewer/server.js path/to/manifest.json --port 4173
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
- A **Summary** button (only when the manifest has a `summary`) that opens a
  read-only, agent-written overview of the whole change.
- A **Publish to PR** button (only for PR-mode manifests) that posts your
  per-step comments to the pull request — see below.

The editor is read-only throughout — this is a review tool, not an editor.

## Publishing comments to a GitHub PR

For a **PR-mode** manifest, the viewer shows a **Publish to PR** button that
posts each step's comment as an inline PR review comment (falling back to a
file-level comment when the line isn't part of the PR diff). It shells out to
the GitHub CLI (`gh`), so `gh` must be able to authenticate for the host the PR
lives on.

`gh` resolves credentials in this order: the `GH_TOKEN` / `GITHUB_TOKEN`
environment variable, then (for a non-default host) `GH_ENTERPRISE_TOKEN`, then
the stored login from `gh auth login`. The credentials must be visible to the
process running `viewer/server.js`, because that process is what spawns `gh`.

Pick whichever fits:

- **Already logged in** (simplest): if you've run `gh auth login` for the PR's
  host, just start the viewer normally — no extra variables:

  ```sh
  node <repo>/viewer/server.js
  ```

- **Per-run token** (no global change, scoped tokens, CI): pass the token — and
  the host if it isn't the default `github.com` — in the server's environment:

  ```sh
  GH_TOKEN=<token> node <repo>/viewer/server.js
  # non-default host:
  GH_TOKEN=<token> GH_HOST=<your-github-host> node <repo>/viewer/server.js
  ```

Notes:

- Use a token scoped to just the target repo with **Pull requests: read & write**
  (plus **Contents: read**). Keep it out of shell history, e.g. read it from a
  file: `GH_TOKEN=$(cat ~/.some-token-file) node <repo>/viewer/server.js`.
- The server reads the environment at **startup**, so changing these variables
  requires restarting the server.
- Re-publishing posts the comments again (there is no de-duplication yet).

## How the pieces fit

```
repo under review
└── .review/
    ├── chunks.json         mechanical chunking output (no LLM)
    ├── review-notes.json   skill path only: the agent's descriptions + order
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
  "summary": "optional — agent-written overview of the whole change (read-only in the viewer)",
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
  skill path uses your agent session (Claude Code or Cursor) and needs no key.
- **Publish to PR does nothing** — publishing is only available for PR-mode
  manifests and needs `gh` authenticated for the PR's host.
