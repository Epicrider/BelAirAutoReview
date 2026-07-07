// Per-diff storage layout. Each review target (working tree, a commit range, or
// a PR) gets its own directory under .review/, so manifests and the comments
// made against them never collide across diffs. A current.json pointer records
// the most recently generated review so the pipeline and viewer have a default.
//
//   .review/
//   ├── current.json                    { key, dir } → the active review
//   ├── working/                        uncommitted changes
//   │   ├── chunks.json
//   │   ├── review-notes.json
//   │   ├── manifest.json
//   │   ├── comments.json
//   │   ├── line-comments.json
//   │   └── reviewed.json
//   ├── pr-owner-repo-123/              a GitHub PR
//   └── range-main-feature-foo/         a commit range
import fs from 'node:fs/promises';
import path from 'node:path';

/** Filesystem-safe slug for a review target. */
function slug(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

/**
 * Stable key identifying a review target, derived from its mode + target.
 *   working              → "working"
 *   range "main...foo"   → "range-main-foo"
 *   pr "owner/repo#123"  → "pr-owner-repo-123"
 */
export function reviewKey(mode, target) {
  if (mode === 'working') return 'working';
  if (mode === 'range') return `range-${slug(target)}`;
  if (mode === 'pr') return `pr-${slug(target)}`;
  return slug(target || mode);
}

/** The .review root for a repo. */
export function reviewRoot(cwd) {
  return path.join(cwd, '.review');
}

/** The per-target directory for a review. */
export function reviewDir(cwd, mode, target) {
  return path.join(reviewRoot(cwd), reviewKey(mode, target));
}

/** Record the active review so tools and the viewer have a default. */
export async function writeCurrentPointer(cwd, key) {
  const root = reviewRoot(cwd);
  await fs.mkdir(root, { recursive: true });
  const doc = { key, dir: path.join('.review', key), updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(root, 'current.json'), JSON.stringify(doc, null, 2) + '\n');
}

/** Read the active-review pointer, or null when there isn't one. */
export async function readCurrentPointer(cwd) {
  try {
    return JSON.parse(await fs.readFile(path.join(reviewRoot(cwd), 'current.json'), 'utf8'));
  } catch {
    return null;
  }
}
