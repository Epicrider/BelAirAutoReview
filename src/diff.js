// Diff extraction for the three review targets:
//  - working:  uncommitted changes (working tree vs HEAD, plus untracked files)
//  - range:    two refs/SHAs (A...B merge-base semantics by default)
//  - pr:       a GitHub PR, fetched via the gh CLI
//
// Returns parsed per-file diffs plus a FileSource capable of reading full
// old/new file contents, so the chunker can extract complete function bodies.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;

async function run(cmd, args, opts = {}) {
  try {
    const { stdout } = await execFileP(cmd, args, { maxBuffer: MAX_BUFFER, ...opts });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      const hint =
        cmd === 'gh'
          ? ' PR mode needs the GitHub CLI: `brew install gh` then `gh auth login`.'
          : '';
      throw new Error(`Command not found: ${cmd}.${hint}`);
    }
    const stderr = (err.stderr || '').toString().trim();
    throw new Error(
      `\`${cmd} ${args.join(' ')}\` failed${stderr ? `:\n${stderr}` : ` (exit ${err.code})`}`
    );
  }
}

const git = (args, cwd) => run('git', args, { cwd });
const gh = (args, cwd) => run('gh', args, { cwd });

/**
 * Parse a unified diff into per-file structures.
 * FileDiff: { oldPath, newPath, status: 'added'|'modified'|'deleted'|'renamed',
 *             binary, hunks: [{ oldStart, oldLines, newStart, newLines,
 *             segments: [{type: 'add'|'del'|'ctx', text}] }] }
 */
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  let oldRemaining = 0;
  let newRemaining = 0;

  const stripPrefix = (p) => {
    let s = p.split('\t')[0].trim();
    if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    if (s === '/dev/null') return null;
    if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
    return s;
  };

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { oldPath: null, newPath: null, status: 'modified', binary: false, hunks: [] };
      files.push(cur);
      hunk = null;
      oldRemaining = newRemaining = 0;
      const m = raw.match(/^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/);
      if (m) {
        cur.oldPath = m[1];
        cur.newPath = m[2];
      }
      continue;
    }
    if (!cur) continue;

    if (raw.startsWith('@@ ')) {
      const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      hunk = {
        oldStart: +m[1],
        oldLines: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3],
        newLines: m[4] === undefined ? 1 : +m[4],
        segments: [],
      };
      cur.hunks.push(hunk);
      oldRemaining = hunk.oldLines;
      newRemaining = hunk.newLines;
      continue;
    }

    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      const c = raw[0];
      if (c === '\\') continue; // "\ No newline at end of file"
      if (c === '+') {
        hunk.segments.push({ type: 'add', text: raw.slice(1) });
        newRemaining--;
      } else if (c === '-') {
        hunk.segments.push({ type: 'del', text: raw.slice(1) });
        oldRemaining--;
      } else {
        hunk.segments.push({ type: 'ctx', text: raw.slice(1) });
        oldRemaining--;
        newRemaining--;
      }
      continue;
    }

    if (raw.startsWith('new file mode')) cur.status = 'added';
    else if (raw.startsWith('deleted file mode')) cur.status = 'deleted';
    else if (raw.startsWith('rename from ')) {
      cur.oldPath = raw.slice('rename from '.length);
      cur.status = 'renamed';
    } else if (raw.startsWith('rename to ')) cur.newPath = raw.slice('rename to '.length);
    else if (raw.startsWith('Binary files') || raw.startsWith('GIT binary patch'))
      cur.binary = true;
    else if (raw.startsWith('--- ')) {
      const p = stripPrefix(raw.slice(4));
      if (p !== null) cur.oldPath = p;
      else if (cur.status === 'modified') cur.status = 'added';
    } else if (raw.startsWith('+++ ')) {
      const p = stripPrefix(raw.slice(4));
      if (p !== null) cur.newPath = p;
      else cur.status = 'deleted';
    }
  }
  return files.filter((f) => f.newPath || f.oldPath);
}

function looksBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

async function collectWorking(cwd) {
  const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
  let hasHead = true;
  try {
    await git(['rev-parse', '--verify', 'HEAD'], root);
  } catch {
    hasHead = false;
  }
  const diffText = hasHead
    ? await git(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--find-renames'], root)
    : '';
  const files = parseUnifiedDiff(diffText);

  // Untracked files don't show up in `git diff` — include them as added files.
  const out = await git(['ls-files', '--others', '--exclude-standard', '-z'], root);
  for (const f of out.split('\0').filter(Boolean)) {
    try {
      const buf = await fs.readFile(path.join(root, f));
      files.push({
        oldPath: null,
        newPath: f,
        status: 'added',
        binary: looksBinary(buf),
        hunks: [],
        untracked: true,
      });
    } catch {
      /* unreadable (socket, permissions) — skip */
    }
  }

  return {
    files,
    source: {
      readNew: (file) => fs.readFile(path.join(root, file), 'utf8'),
      readOld: (file) => {
        if (!hasHead) throw new Error('repository has no commits yet');
        return git(['show', `HEAD:${file}`], root);
      },
      listDir: async (dir) => {
        const ents = await fs.readdir(path.join(root, dir || '.'), { withFileTypes: true });
        return ents
          .filter((e) => e.name !== '.git')
          .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      },
    },
    meta: {
      mode: 'working',
      target: 'uncommitted changes (working tree vs HEAD)',
      base: hasHead ? 'HEAD' : null,
      head: '(working tree)',
      root,
    },
  };
}

// Git's well-known hash for the empty tree — diffing against it shows
// everything a ref contains, including root commits with no parent to diff
// against normally. "empty" is accepted as a friendly alias for this.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const isEmptyTreeAlias = (ref) => ref.trim().toLowerCase() === 'empty' || ref.trim() === EMPTY_TREE_SHA;

async function collectRange(rangeArg, cwd) {
  const root = (await git(['rev-parse', '--show-toplevel'], cwd)).trim();
  let base;
  let head;
  let display = rangeArg;
  if (rangeArg.includes('...')) {
    const [a, b] = rangeArg.split('...');
    head = b || 'HEAD';
    base = isEmptyTreeAlias(a) ? EMPTY_TREE_SHA : (await git(['merge-base', a, head], root)).trim();
  } else if (rangeArg.includes('..')) {
    const [a, b] = rangeArg.split('..');
    base = a;
    head = b || 'HEAD';
  } else {
    // Single ref: review what `HEAD` adds on top of it (merge-base semantics).
    head = 'HEAD';
    base = (await git(['merge-base', rangeArg, 'HEAD'], root)).trim();
    display = `${rangeArg}...HEAD`;
  }
  const baseSha = isEmptyTreeAlias(base)
    ? EMPTY_TREE_SHA
    : (await git(['rev-parse', '--verify', `${base}^{commit}`], root)).trim();
  const headSha = (await git(['rev-parse', '--verify', `${head}^{commit}`], root)).trim();
  const diffText = await git(
    ['diff', '--no-color', '--no-ext-diff', '--find-renames', baseSha, headSha],
    root
  );
  return {
    files: parseUnifiedDiff(diffText),
    source: {
      readNew: (file) => git(['show', `${headSha}:${file}`], root),
      readOld: (file) => {
        if (baseSha === EMPTY_TREE_SHA) return Promise.reject(new Error('no old version (empty tree)'));
        return git(['show', `${baseSha}:${file}`], root);
      },
      listDir: async (dir) => {
        const prefix = dir ? dir.replace(/\/*$/, '/') : '';
        const out = await git(['ls-tree', headSha, prefix], root);
        return out
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [meta, p = ''] = line.split('\t');
            const type = meta.split(' ')[1];
            return { name: p.slice(prefix.length), type: type === 'tree' ? 'dir' : 'file' };
          });
      },
    },
    meta: {
      mode: 'range',
      target: display,
      base: baseSha === EMPTY_TREE_SHA ? '(empty tree)' : baseSha,
      head: headSha,
      root,
    },
  };
}

async function collectPr(prArg, repoArg, cwd) {
  await run('gh', ['--version']);
  let owner, repo, num;
  const urlMatch = String(prArg).match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/pull\/(\d+)/);
  if (urlMatch) {
    [, owner, repo, num] = urlMatch;
  } else if (/^\d+$/.test(String(prArg).replace(/^#/, ''))) {
    num = String(prArg).replace(/^#/, '');
    if (repoArg) {
      [owner, repo] = repoArg.split('/');
    } else {
      const nwo = JSON.parse(await gh(['repo', 'view', '--json', 'nameWithOwner'], cwd))
        .nameWithOwner;
      [owner, repo] = nwo.split('/');
    }
  } else {
    throw new Error(
      `Cannot parse PR target "${prArg}". Pass a PR number (with --repo owner/repo if outside the repo) or a full PR URL.`
    );
  }
  if (!owner || !repo) throw new Error('Could not determine the GitHub repository for the PR.');

  const slug = `${owner}/${repo}`;
  const pr = JSON.parse(await gh(['api', `repos/${slug}/pulls/${num}`]));
  const baseSha = pr.base.sha;
  const headSha = pr.head.sha;
  const headRepo = pr.head.repo?.full_name || slug;
  const baseRepo = pr.base.repo?.full_name || slug;
  const diffText = await gh([
    'api',
    `repos/${slug}/pulls/${num}`,
    '-H',
    'Accept: application/vnd.github.v3.diff',
  ]);

  const cache = new Map();
  const fetchFile = async (repoSlug, sha, file) => {
    const key = `${repoSlug}@${sha}:${file}`;
    if (cache.has(key)) return cache.get(key);
    const encoded = file.split('/').map(encodeURIComponent).join('/');
    const content = await gh([
      'api',
      `repos/${repoSlug}/contents/${encoded}?ref=${sha}`,
      '-H',
      'Accept: application/vnd.github.raw',
    ]);
    cache.set(key, content);
    return content;
  };

  return {
    files: parseUnifiedDiff(diffText),
    source: {
      readNew: (file) => fetchFile(headRepo, headSha, file),
      readOld: (file) => fetchFile(baseRepo, baseSha, file),
      listDir: async (dir) => {
        const encoded = (dir || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
        const json = JSON.parse(
          await gh(['api', `repos/${headRepo}/contents/${encoded}?ref=${headSha}`])
        );
        const arr = Array.isArray(json) ? json : [];
        return arr.map((e) => ({ name: e.name, type: e.type === 'dir' ? 'dir' : 'file' }));
      },
    },
    meta: {
      mode: 'pr',
      target: `${slug}#${num}`,
      title: pr.title,
      base: baseSha,
      head: headSha,
    },
  };
}

/**
 * @param {{mode: 'working'|'range'|'pr', range?: string, pr?: string, repo?: string, cwd?: string}} opts
 */
export async function collectDiff(opts) {
  const cwd = opts.cwd || process.cwd();
  switch (opts.mode) {
    case 'working':
      return collectWorking(cwd);
    case 'range':
      return collectRange(opts.range, cwd);
    case 'pr':
      return collectPr(opts.pr, opts.repo, cwd);
    default:
      throw new Error(`Unknown mode: ${opts.mode}`);
  }
}
