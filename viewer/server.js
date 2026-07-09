#!/usr/bin/env node
// Tiny local server for the review viewer. Serves the static viewer, Monaco
// from node_modules, the manifest, and a comments read/write endpoint that
// persists to comments.json next to the manifest. No auth — local use only.
//
// Usage: node viewer/server.js [path/to/manifest.json] [--port 4173]
// Default manifest: ./.review/manifest.json (relative to the cwd you run from)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { collectDiff } from '../src/diff.js';
import { readCurrentPointer } from '../src/review-paths.js';

const viewerDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(viewerDir, '..');
const monacoRoot = path.join(repoRoot, 'node_modules', 'monaco-editor', 'min');

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

if (values.help) {
  console.log('Usage: node viewer/server.js [path/to/manifest.json] [--port 4173]');
  process.exit(0);
}

// Default to the active review (.review/<key>/manifest.json via current.json),
// then the legacy flat .review/manifest.json. An explicit path always wins.
async function resolveManifestPath() {
  if (positionals[0]) return path.resolve(positionals[0]);
  const pointer = await readCurrentPointer(process.cwd());
  if (pointer) return path.resolve(pointer.dir, 'manifest.json');
  return path.resolve(process.cwd(), '.review', 'manifest.json');
}

const manifestPath = await resolveManifestPath();
const commentsPath = path.join(path.dirname(manifestPath), 'comments.json');
const lineCommentsPath = path.join(path.dirname(manifestPath), 'line-comments.json');
const reviewedPath = path.join(path.dirname(manifestPath), 'reviewed.json');
const basePort = parseInt(values.port ?? '4173', 10) || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function sendFile(res, filePath) {
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

/** Resolve a URL sub-path under a root dir, rejecting traversal. */
function safeJoin(root, subPath) {
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + subPath));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function readComments() {
  try {
    return JSON.parse(await fsp.readFile(commentsPath, 'utf8'));
  } catch {
    return {};
  }
}

async function writeComments(comments) {
  await fsp.mkdir(path.dirname(commentsPath), { recursive: true });
  const tmp = commentsPath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(comments, null, 2) + '\n');
  await fsp.rename(tmp, commentsPath);
}

// Line comments: { "<stepId>": { "<realFileLine>": "text" } }
async function readLineComments() {
  try {
    return JSON.parse(await fsp.readFile(lineCommentsPath, 'utf8'));
  } catch {
    return {};
  }
}

async function writeLineComments(data) {
  await fsp.mkdir(path.dirname(lineCommentsPath), { recursive: true });
  const tmp = lineCommentsPath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fsp.rename(tmp, lineCommentsPath);
}

// Reviewed state: { "<stepId>": true }
async function readReviewed() {
  try {
    return JSON.parse(await fsp.readFile(reviewedPath, 'utf8'));
  } catch {
    return {};
  }
}

async function writeReviewed(data) {
  await fsp.mkdir(path.dirname(reviewedPath), { recursive: true });
  const tmp = reviewedPath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fsp.rename(tmp, reviewedPath);
}

// ---------- reading surrounding file context ----------
// Re-derive a file reader (readNew/readOld) from the manifest's source so the
// viewer can request lines around a chunk on demand. Cached after first use.
let _fileSource = null;
async function getFileSource() {
  if (_fileSource) return _fileSource;
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const src = manifest.source || {};
  let opts;
  if (src.mode === 'working') opts = { mode: 'working', cwd: process.cwd() };
  else if (src.mode === 'range') opts = { mode: 'range', range: src.target, cwd: process.cwd() };
  else if (src.mode === 'pr') {
    const m = String(src.target).match(/^([^/]+\/[^#]+)#(\d+)$/);
    if (!m) throw new Error(`cannot parse PR target "${src.target}"`);
    opts = { mode: 'pr', pr: m[2], repo: m[1], cwd: process.cwd() };
  } else {
    throw new Error(`unknown manifest source mode: ${src.mode}`);
  }
  const { source } = await collectDiff(opts);
  _fileSource = source;
  return source;
}

async function readContext(file, start, end, side) {
  const source = await getFileSource();
  const content = side === 'old' ? await source.readOld(file) : await source.readNew(file);
  const all = content.split('\n');
  const s = Math.max(1, start);
  const e = Math.min(all.length, end);
  return { start: s, end: e, total: all.length, lines: s <= e ? all.slice(s - 1, e) : [] };
}

// Build a file tree of the folders that contain changed files, listing every
// file in them (not just changed ones), so the reviewer can browse siblings.
async function buildTree() {
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const source = await getFileSource();
  // Map changed file path -> first step index (for click-to-step).
  const changed = new Map();
  manifest.steps.forEach((s, i) => {
    if (!changed.has(s.file)) changed.set(s.file, i);
  });
  // Relevant folders: the directory of each changed file ('' = repo root).
  const dirs = [...new Set([...changed.keys()].map((f) => f.split('/').slice(0, -1).join('/')))];
  dirs.sort();
  const folders = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await source.listDir(dir);
    } catch (err) {
      entries = [];
    }
    const files = entries
      .filter((e) => e.type === 'file')
      .map((e) => {
        const full = dir ? `${dir}/${e.name}` : e.name;
        return { name: e.name, path: full, changed: changed.has(full), stepIdx: changed.get(full) ?? null };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    folders.push({ dir, files });
  }
  return { folders };
}

// ---------- publishing to a GitHub PR (via the gh CLI) ----------
const execFileP = promisify(execFile);

async function gh(args) {
  try {
    const { stdout } = await execFileP('gh', args, { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('GitHub CLI (gh) not found — install it (brew install gh) and run `gh auth login`.');
    }
    const stderr = (err.stderr || '').toString().trim();
    const e = new Error(stderr || err.message);
    e.stderr = stderr;
    throw e;
  }
}

function parsePrTarget(target) {
  const m = String(target || '').match(/^([^/]+)\/([^#]+)#(\d+)$/); // owner/repo#123
  return m ? { slug: `${m[1]}/${m[2]}`, num: m[3] } : null;
}

async function postPrComment({ slug, num, commitId, body, file, line, side }) {
  const args = [
    'api',
    '--method',
    'POST',
    `repos/${slug}/pulls/${num}/comments`,
    '-f',
    `body=${body}`,
    '-f',
    `commit_id=${commitId}`,
    '-f',
    `path=${file}`,
  ];
  if (line != null) args.push('-F', `line=${line}`, '-f', `side=${side}`);
  else args.push('-f', 'subject_type=file'); // whole-file comment (line not in diff)
  args.push('--jq', '.html_url');
  return (await gh(args)).trim();
}

async function publishReview(manifest, comments, lineComments) {
  const pr = manifest.source && manifest.source.mode === 'pr'
    ? parsePrTarget(manifest.source.target)
    : null;
  if (!pr) {
    const e = new Error('Publishing requires a PR-mode manifest (generate it with --pr).');
    e.status = 400;
    throw e;
  }
  const headSha = (await gh(['api', `repos/${pr.slug}/pulls/${pr.num}`, '--jq', '.head.sha'])).trim();
  const stepById = new Map(manifest.steps.map((s) => [s.id, s]));
  const results = [];

  // Post one comment anchored to a line (with a file-level fallback).
  async function post(idLabel, file, body, line, side) {
    const common = { slug: pr.slug, num: pr.num, commitId: headSha, body, file };
    try {
      const url = await postPrComment({ ...common, line, side });
      results.push({ id: idLabel, status: 'posted', url });
    } catch {
      try {
        const url = await postPrComment({ ...common, line: null });
        results.push({ id: idLabel, status: 'posted-file', url });
      } catch (err2) {
        results.push({ id: idLabel, status: 'failed', reason: (err2.stderr || err2.message || '').slice(0, 300) });
      }
    }
  }

  // Step-level comments — anchored to the step's line.
  for (const [id, text] of Object.entries(comments || {})) {
    if (!text || !text.trim()) continue;
    const step = stepById.get(id);
    if (!step) {
      results.push({ id, status: 'skipped', reason: 'no matching step in manifest' });
      continue;
    }
    const deleted = step.changeKind === 'deleted';
    const side = deleted ? 'LEFT' : 'RIGHT';
    const line = deleted ? step.oldStartLine || step.startLine : step.endLine;
    await post(id, step.file, text, line, side);
  }

  // Per-line comments — anchored to their exact (new-side) file line.
  for (const [id, byLine] of Object.entries(lineComments || {})) {
    const step = stepById.get(id);
    if (!step) {
      results.push({ id, status: 'skipped', reason: 'no matching step in manifest' });
      continue;
    }
    for (const [lineStr, text] of Object.entries(byLine || {})) {
      if (!text || !text.trim()) continue;
      await post(`${step.file}:${lineStr}`, step.file, text, Number(lineStr), 'RIGHT');
    }
  }

  const posted = results.filter((r) => r.status.startsWith('posted')).length;
  const failed = results.filter((r) => r.status === 'failed').length;
  return { ok: failed === 0, target: manifest.source.target, posted, failed, results };
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === '/api/manifest' && req.method === 'GET') {
      try {
        const data = await fsp.readFile(manifestPath, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      } catch {
        sendJson(res, 404, {
          error: `manifest not found at ${manifestPath} — generate one first (skill or bin/generate-manifest.js)`,
        });
      }
      return;
    }

    if (pathname === '/api/comments' && req.method === 'GET') {
      sendJson(res, 200, await readComments());
      return;
    }

    if (pathname === '/api/comments' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = JSON.parse(await readBody(req));
      if (typeof body.id !== 'string') {
        sendJson(res, 400, { error: 'expected {id: string, text: string}' });
        return;
      }
      const comments = await readComments();
      const text = String(body.text ?? '');
      if (text.trim() === '') delete comments[body.id];
      else comments[body.id] = text;
      await writeComments(comments);
      sendJson(res, 200, { ok: true, saved: text.trim() !== '' });
      return;
    }

    if (pathname === '/api/line-comments' && req.method === 'GET') {
      sendJson(res, 200, await readLineComments());
      return;
    }

    if (pathname === '/api/line-comments' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = JSON.parse(await readBody(req));
      if (typeof body.id !== 'string' || !Number.isInteger(body.line)) {
        sendJson(res, 400, { error: 'expected {id: string, line: int, text: string}' });
        return;
      }
      const data = await readLineComments();
      const text = String(body.text ?? '');
      const forStep = data[body.id] || {};
      if (text.trim() === '') delete forStep[body.line];
      else forStep[body.line] = text;
      if (Object.keys(forStep).length) data[body.id] = forStep;
      else delete data[body.id];
      await writeLineComments(data);
      sendJson(res, 200, { ok: true, saved: text.trim() !== '' });
      return;
    }

    if (pathname === '/api/context' && req.method === 'GET') {
      const file = url.searchParams.get('file');
      const start = parseInt(url.searchParams.get('start'), 10);
      const end = parseInt(url.searchParams.get('end'), 10);
      const side = url.searchParams.get('side') === 'old' ? 'old' : 'new';
      if (!file || !Number.isInteger(start) || !Number.isInteger(end)) {
        sendJson(res, 400, { error: 'expected file, start, end query params' });
        return;
      }
      try {
        sendJson(res, 200, await readContext(file, start, end, side));
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/tree' && req.method === 'GET') {
      try {
        sendJson(res, 200, await buildTree());
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/file' && req.method === 'GET') {
      const file = url.searchParams.get('file');
      const side = url.searchParams.get('side') === 'old' ? 'old' : 'new';
      if (!file) {
        sendJson(res, 400, { error: 'expected file query param' });
        return;
      }
      try {
        const source = await getFileSource();
        const content = side === 'old' ? await source.readOld(file) : await source.readNew(file);
        sendJson(res, 200, { file, content, lineCount: content.split('\n').length });
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }

    if (pathname === '/api/reviewed' && req.method === 'GET') {
      sendJson(res, 200, await readReviewed());
      return;
    }

    if (pathname === '/api/reviewed' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = JSON.parse(await readBody(req));
      if (typeof body.id !== 'string') {
        sendJson(res, 400, { error: 'expected {id: string, reviewed: bool}' });
        return;
      }
      const data = await readReviewed();
      if (body.reviewed) data[body.id] = true;
      else delete data[body.id];
      await writeReviewed(data);
      sendJson(res, 200, { ok: true, reviewed: !!body.reviewed });
      return;
    }

    if (pathname === '/api/publish' && req.method === 'POST') {
      let manifest;
      try {
        manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
      } catch {
        sendJson(res, 404, { error: 'manifest not found' });
        return;
      }
      const comments = await readComments();
      const lineComments = await readLineComments();
      const hasStep = Object.values(comments).some((t) => t && t.trim());
      const hasLine = Object.values(lineComments).some(
        (byLine) => byLine && Object.values(byLine).some((t) => t && t.trim())
      );
      if (!hasStep && !hasLine) {
        sendJson(res, 400, { error: 'no comments to publish' });
        return;
      }
      try {
        sendJson(res, 200, await publishReview(manifest, comments, lineComments));
      } catch (err) {
        sendJson(res, err.status || 500, { error: err.message });
      }
      return;
    }

    if (pathname.startsWith('/vendor/monaco/')) {
      const target = safeJoin(monacoRoot, pathname.slice('/vendor/monaco/'.length));
      if (!target) {
        res.writeHead(403).end();
        return;
      }
      await sendFile(res, target);
      return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const target = safeJoin(viewerDir, rel);
    if (!target) {
      res.writeHead(403).end();
      return;
    }
    await sendFile(res, target);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

function listen(port, attemptsLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.error(`port ${port} is in use, trying ${port + 1}…`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`error: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`BelAir review viewer`);
    console.log(`  manifest: ${manifestPath}${fs.existsSync(manifestPath) ? '' : '  (NOT FOUND yet — generate it, then refresh)'}`);
    console.log(`  comments: ${commentsPath}`);
    if (!fs.existsSync(monacoRoot)) {
      console.log(`  WARNING: monaco-editor not found — run \`npm install\` in ${repoRoot}`);
    }
    console.log(`  → http://localhost:${port}`);
  });
}

listen(basePort, 10);
