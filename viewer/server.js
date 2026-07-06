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

const manifestPath = path.resolve(
  positionals[0] ?? path.join(process.cwd(), '.review', 'manifest.json')
);
const commentsPath = path.join(path.dirname(manifestPath), 'comments.json');
const summaryPath = path.join(path.dirname(manifestPath), 'summary.md');
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

async function readSummary() {
  try {
    return await fsp.readFile(summaryPath, 'utf8');
  } catch {
    return '';
  }
}

async function writeSummary(text) {
  if (!text || !text.trim()) {
    await fsp.rm(summaryPath, { force: true });
    return;
  }
  await fsp.mkdir(path.dirname(summaryPath), { recursive: true });
  const tmp = summaryPath + '.tmp';
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, summaryPath);
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

async function publishReview(manifest, comments) {
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
  for (const [id, text] of Object.entries(comments)) {
    if (!text || !text.trim()) continue;
    const step = stepById.get(id);
    if (!step) {
      results.push({ id, status: 'skipped', reason: 'no matching step in manifest' });
      continue;
    }
    const deleted = step.changeKind === 'deleted';
    const side = deleted ? 'LEFT' : 'RIGHT';
    const line = deleted ? step.oldStartLine || step.startLine : step.endLine;
    const common = { slug: pr.slug, num: pr.num, commitId: headSha, body: text, file: step.file };
    try {
      const url = await postPrComment({ ...common, line, side });
      results.push({ id, status: 'posted', url });
    } catch {
      // Line likely isn't part of the PR diff — fall back to a file-level comment.
      try {
        const url = await postPrComment({ ...common, line: null });
        results.push({ id, status: 'posted-file', url });
      } catch (err2) {
        results.push({ id, status: 'failed', reason: (err2.stderr || err2.message || '').slice(0, 300) });
      }
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

    if (pathname === '/api/summary' && req.method === 'GET') {
      sendJson(res, 200, { text: await readSummary() });
      return;
    }

    if (pathname === '/api/summary' && (req.method === 'PUT' || req.method === 'POST')) {
      const body = JSON.parse(await readBody(req));
      const text = String(body.text ?? '');
      await writeSummary(text);
      sendJson(res, 200, { ok: true, saved: text.trim() !== '' });
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
      if (!Object.values(comments).some((t) => t && t.trim())) {
        sendJson(res, 400, { error: 'no comments to publish' });
        return;
      }
      try {
        sendJson(res, 200, await publishReview(manifest, comments));
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
