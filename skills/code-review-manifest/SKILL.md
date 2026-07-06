---
name: code-review-manifest
description: Prepare an interactive code-review manifest from a diff — uncommitted changes, a commit range, or a GitHub PR. A script chunks the diff mechanically; the agent then writes per-chunk descriptions and a comprehension-optimized reading order, producing .review/manifest.json for the BelAir review viewer. Use when the user asks to prepare a review manifest, a guided/interactive code review, or to "set up a review" of a diff, branch, or PR.
---

# code-review-manifest

Produce `.review/manifest.json` inside the repository under review, then hand off to
the local viewer. The chunking is done by a provided script (deterministic, no LLM);
**you** write the descriptions and the reading order yourself, in-session — do not
call any external API or model for those steps.

**Paths:** `SKILL_DIR` below means the directory containing this SKILL.md (you know it
from how this skill was loaded). Run all commands from the repository being reviewed
(its root should be your cwd). Output goes to `.review/` in that repository.

If a script fails with a module-not-found error, the tool's dependencies aren't
installed: run `npm install` in the BelAirAutoReview repo (two levels above
`SKILL_DIR`) once, then retry.

## Step 0 — Resolve the target

Three supported targets:

| Target | Flag |
|---|---|
| Uncommitted changes (working tree vs HEAD, incl. untracked files) | `--working` |
| Commit range | `--range "A...B"` (also `A..B`; a single ref means `ref...HEAD`; `empty` is a valid ref on either side, meaning the git empty tree — use `--range "empty...HEAD"` to review everything a ref contains from scratch, e.g. a repo's initial commit) |
| GitHub PR | `--pr <number|url>` (add `--repo owner/repo` when not inside a checkout of that repo; requires an authenticated `gh` CLI) |

**Ask the user instead of guessing** when the target is ambiguous — e.g. they said
"review my changes" but the repo has both uncommitted changes and an unpushed branch,
or they said "review the PR" without a number and the current branch has no obvious
PR. If the user named a branch, prefer `--range "main...branch"` (or the repo's
default branch) unless they say otherwise.

## Step 1 — Chunk (mechanical)

```
node "$SKILL_DIR/scripts/chunk.js" <target flags>
```

This writes `.review/chunks.json` and prints an index of chunk ids. If it errors
(not a git repo, unknown ref, `gh` missing/unauthenticated), surface the problem and
fix it or ask the user. If it reports 0 chunks, tell the user there is nothing to
review and stop.

## Step 2 — Write descriptions (you, in-session)

Read `.review/chunks.json` (read it in slices if large). For **every** chunk id,
write a 2–4 sentence description based on the chunk's `code` / `oldCode`:

- `changeKind: "modified"` — what changed and why it likely matters.
- `changeKind: "added"` — what the code does.
- `changeKind: "deleted"` — what was removed and the likely consequence.

Be specific: name the functions/types/config keys involved. If a chunk is hard to
describe in isolation, open the surrounding file in the repo for context — but the
description must reflect the chunk's actual content. For large reviews (more than
~40 chunks), work file by file and accumulate your annotations as you go.

## Step 3 — Determine the reading order (you)

Order **all** chunk ids for reviewer comprehension, not file/commit order:

- New types, interfaces, and schemas before their consumers.
- New functions before their callers.
- Config/schema/migration changes before the code that reads them.
- High-level orchestration before deep implementation detail — unless a low-level
  piece is a prerequisite for understanding the orchestration.
- Keep closely related chunks adjacent; place deletions where their absence matters.

As you order, briefly note your rationale for each placement decision; where a
placement is non-obvious, record it as that chunk's `orderRationale` (one sentence).

## Step 4 — Write review-notes.json

Write `.review/review-notes.json`:

```json
{
  "summary": "optional: a few sentences summarizing the whole change for the reviewer",
  "order": ["chunk-id-1", "chunk-id-2", "..."],
  "annotations": {
    "chunk-id-1": {
      "description": "2-4 sentences.",
      "orderRationale": "optional, one sentence"
    }
  }
}
```

`order` must contain every chunk id from chunks.json exactly once; every id needs a
description. The optional top-level `summary` is an overall, review-wide note that
**you** write — what the change does as a whole, notable risks, and what the reviewer
should focus on; the viewer shows it read-only (it is not for the reviewer to edit).
Do **not** copy code into this file and do **not** edit chunks.json — the next step
merges the two.

## Step 5 — Build and validate the manifest

```
node "$SKILL_DIR/scripts/write-manifest.js"
```

This merges chunks + notes into `.review/manifest.json` and validates the schema.
If it reports errors (ids missing from the order, missing descriptions), fix
`review-notes.json` and re-run until it succeeds.

## Step 6 — Hand off to the viewer

Tell the user the manifest is ready at `.review/manifest.json` and that they can
browse it with:

```
node "$SKILL_DIR/scripts/serve.js"
```

(run from the reviewed repo; it serves the viewer at http://localhost:4173, picking
up `.review/manifest.json` automatically). Comments they type in the viewer persist
to `.review/comments.json`. Do not start the server yourself unless the user asks —
it's a long-running foreground process.
