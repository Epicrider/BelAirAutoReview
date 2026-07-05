// Deterministic diff chunking. No LLM involved.
//
// For each changed file, changed regions are grouped into candidate chunks:
//  - structurally, at function/class/type level via tree-sitter (when a grammar
//    is available and the enclosing node isn't huge), or
//  - hunk-based, with a few lines of context, as the fallback.
//
// Each chunk carries the new code for its line range and, when the range maps
// back to old lines, the old version of that region (for the diff view).
import { languageForFile } from './languages.js';

const MAX_NODE_LINES = 200; // enclosing node bigger than this → hunk fallback
const WHOLE_FILE_MAX = 120; // added files up to this size become a single chunk
const CONTEXT = 3; // context lines around hunk-fallback ranges
const MERGE_GAP = 2; // ranges closer than this merge into one chunk
const MIN_RANGE = 5; // tiny gap ranges get merged into a neighbor
const DELETED_FILE_CAP = 400; // max old lines shown for a deleted file

let ts = null; // { Parser, Language } once web-tree-sitter is initialized
let tsFailed = false;
const langCache = new Map();

async function getParser(grammar, warn) {
  if (!grammar || tsFailed) return null;
  try {
    if (!ts) {
      const mod = await import('@vscode/tree-sitter-wasm');
      const api = mod.default ?? mod;
      await api.Parser.init();
      ts = { Parser: api.Parser, Language: api.Language };
    }
    let lang = langCache.get(grammar.wasmPath);
    if (!lang) {
      lang = await ts.Language.load(grammar.wasmPath);
      langCache.set(grammar.wasmPath, lang);
    }
    const parser = new ts.Parser();
    parser.setLanguage(lang);
    return parser;
  } catch (err) {
    if (!tsFailed) {
      tsFailed = true;
      warn(
        `tree-sitter unavailable (${err.message}) — falling back to hunk-based chunking. ` +
          'Run `npm install` in the BelAirAutoReview repo to enable structural chunking.'
      );
    }
    return null;
  }
}

export function splitLines(content) {
  const lines = String(content).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const nodeStartLine = (n) => n.startPosition.row + 1;
const nodeEndLine = (n) => (n.endPosition.column === 0 ? n.endPosition.row : n.endPosition.row + 1);

const NAME_TYPES = new Set([
  'identifier',
  'type_identifier',
  'field_identifier',
  'property_identifier',
  'constant',
  'name',
]);

function symbolFor(node) {
  if (!node) return null;
  try {
    let n = node.childForFieldName?.('name');
    if (n) return n.text;
    // C/C++ style: function_definition → declarator → ... → identifier
    let d = node.childForFieldName?.('declarator');
    let depth = 0;
    while (d && depth++ < 6) {
      if (NAME_TYPES.has(d.type)) return d.text;
      d = d.childForFieldName?.('declarator') ?? d.namedChildren?.find((c) => NAME_TYPES.has(c.type));
      if (d && NAME_TYPES.has(d.type)) return d.text;
    }
    // decorated_definition and similar wrappers: look one level down
    for (const c of node.namedChildren ?? []) {
      const inner = c.childForFieldName?.('name');
      if (inner) return inner.text;
      if (NAME_TYPES.has(c.type)) return c.text;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

/** Smallest chunk-boundary node covering lines [a, b]; null if none. */
function smallestChunkableCovering(tree, nodeTypes, a, b) {
  let node = tree.rootNode.descendantForPosition(
    { row: a - 1, column: 0 },
    { row: a - 1, column: 0 }
  );
  while (node) {
    if (nodeTypes.has(node.type) && nodeStartLine(node) <= a && nodeEndLine(node) >= b) {
      return node;
    }
    node = node.parent;
  }
  return null;
}

/**
 * Segment a span of an (entirely new) file using chunk-boundary nodes,
 * gap-filling around them so the whole span is covered. Oversized nodes are
 * segmented recursively (e.g. a big class into its methods).
 */
function segmentSpan(node, nodeTypes, spanStart, spanEnd, out) {
  const kids = [];
  const gather = (n, depth) => {
    for (const c of n.namedChildren ?? []) {
      if (nodeTypes.has(c.type)) kids.push(c);
      else if (depth < 3) gather(c, depth + 1);
    }
  };
  gather(node, 0);
  kids.sort((x, y) => x.startPosition.row - y.startPosition.row);

  let cursor = spanStart;
  for (const k of kids) {
    const s = nodeStartLine(k);
    const e = nodeEndLine(k);
    if (s < cursor) continue; // nested inside an already-emitted node
    if (s > cursor) out.push({ start: cursor, end: s - 1 });
    if (e - s + 1 > MAX_NODE_LINES) segmentSpan(k, nodeTypes, s, e, out);
    else out.push({ start: s, end: e, symbol: symbolFor(k), structural: true });
    cursor = e + 1;
  }
  if (cursor <= spanEnd) out.push({ start: cursor, end: spanEnd });
}

/** Changed regions (in new-file line numbers) implied by the hunks. */
function changedRegions(hunks, lineCount) {
  const marked = new Set();
  for (const h of hunks) {
    let newLine = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    for (const s of h.segments) {
      if (s.type === 'add') {
        marked.add(newLine);
        newLine++;
      } else if (s.type === 'del') {
        // Deletion sits between newLine-1 and newLine: mark both neighbors.
        marked.add(Math.min(Math.max(1, newLine - 1), lineCount));
        marked.add(Math.min(Math.max(1, newLine), lineCount));
      } else {
        newLine++;
      }
    }
  }
  const lines = [...marked].sort((a, b) => a - b);
  const regions = [];
  for (const l of lines) {
    const last = regions[regions.length - 1];
    if (last && l <= last.end + 1) last.end = l;
    else regions.push({ start: l, end: l });
  }
  return regions;
}

/** Map a new-file line range back to the corresponding old-file range. */
function mapNewRangeToOld(hunks, a, b) {
  if (!hunks || hunks.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  const push = (o) => {
    if (o < lo) lo = o;
    if (o > hi) hi = o;
  };

  for (const h of hunks) {
    let oldLine = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    let newLine = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    for (const s of h.segments) {
      if (s.type === 'ctx') {
        if (newLine >= a && newLine <= b) push(oldLine);
        oldLine++;
        newLine++;
      } else if (s.type === 'del') {
        if (newLine >= a && newLine - 1 <= b) push(oldLine);
        oldLine++;
      } else {
        newLine++;
      }
    }
  }

  // Range endpoints that fall outside every hunk map by cumulative offset.
  const outside = (L) => {
    let delta = 0;
    for (const h of hunks) {
      const newStart = h.newLines === 0 ? h.newStart + 1 : h.newStart;
      if (L < newStart) return L + delta;
      if (h.newLines > 0 && L <= h.newStart + h.newLines - 1) return null; // inside hunk
      delta += h.oldLines - h.newLines;
    }
    return L + delta;
  };
  for (const L of [a, b]) {
    const o = outside(L);
    if (o != null && o >= 1) push(o);
  }

  if (hi < 0) return null;
  return [lo, hi];
}

function mergeRanges(ranges) {
  ranges.sort((x, y) => x.start - y.start || x.end - y.end);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + MERGE_GAP + 1) {
      last.end = Math.max(last.end, r.end);
      last.symbol = last.symbol || r.symbol;
      last.structural = Boolean(last.structural && r.structural);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Fold tiny ranges (blank-line gaps, stray imports) into a neighbor. */
function absorbTinyRanges(ranges) {
  const out = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const size = r.end - r.start + 1;
    if (size < MIN_RANGE && ranges[i + 1]) {
      ranges[i + 1] = {
        ...ranges[i + 1],
        start: r.start,
        symbol: ranges[i + 1].symbol || r.symbol,
        structural: Boolean(ranges[i + 1].structural && r.structural !== false),
      };
    } else if (size < MIN_RANGE && out.length) {
      out[out.length - 1].end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function truncateLines(lines, cap) {
  if (lines.length <= cap) return { text: lines.join('\n'), truncated: false };
  return {
    text: lines.slice(0, cap).join('\n') + `\n… (${lines.length - cap} more lines truncated)`,
    truncated: true,
  };
}

/**
 * @param {import('./diff.js').FileDiff[]} files
 * @param {{readNew: (f: string) => Promise<string>, readOld: (f: string) => Promise<string>}} source
 * @returns {Promise<{chunks: object[], warnings: string[]}>}
 */
export async function chunkFiles(files, source) {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  const chunks = [];

  for (const file of files) {
    const anyPath = file.newPath || file.oldPath;
    if (anyPath.startsWith('.review/') || anyPath.includes('/.review/')) {
      continue; // never review this tool's own output directory
    }
    if (file.binary) {
      warn(`skipping binary file: ${anyPath}`);
      continue;
    }

    if (file.status === 'deleted') {
      const filePath = file.oldPath || file.newPath;
      let oldContent;
      try {
        oldContent = await source.readOld(filePath);
      } catch (err) {
        warn(`cannot read old content of deleted file ${filePath}: ${err.message}`);
        continue;
      }
      const { text } = truncateLines(splitLines(oldContent), DELETED_FILE_CAP);
      chunks.push({
        id: `${filePath}#deleted`,
        file: filePath,
        startLine: 1,
        endLine: 1,
        code: '',
        oldCode: text,
        oldStartLine: 1,
        language: languageForFile(filePath).id,
        changeKind: 'deleted',
        structural: false,
      });
      continue;
    }

    const filePath = file.newPath;
    let newContent;
    try {
      newContent = await source.readNew(filePath);
    } catch (err) {
      warn(`cannot read ${filePath}: ${err.message}`);
      continue;
    }
    if (newContent.includes('\u0000')) {
      warn(`skipping binary file: ${filePath}`);
      continue;
    }
    if (newContent.length > 2_000_000) {
      warn(`skipping very large file (${Math.round(newContent.length / 1024)} KB): ${filePath}`);
      continue;
    }

    const lines = splitLines(newContent);
    const lineCount = Math.max(1, lines.length);
    const langInfo = languageForFile(filePath);
    let tree = null;
    const parser = await getParser(langInfo.grammar, warn);
    if (parser) {
      try {
        tree = parser.parse(newContent);
      } catch (err) {
        warn(`parse failed for ${filePath}: ${err.message}`);
      }
    }
    const nodeTypes = langInfo.grammar?.nodeTypes ?? new Set();

    let ranges = [];
    if (file.status === 'added') {
      if (!tree || lineCount <= WHOLE_FILE_MAX) {
        ranges = [{ start: 1, end: lineCount, structural: false }];
      } else {
        segmentSpan(tree.rootNode, nodeTypes, 1, lineCount, ranges);
        ranges = absorbTinyRanges(mergeRanges(ranges));
      }
    } else {
      const regions = changedRegions(file.hunks, lineCount);
      for (const region of regions) {
        let start = Math.max(1, region.start - CONTEXT);
        let end = Math.min(lineCount, region.end + CONTEXT);
        let symbol = null;
        let structural = false;
        if (tree) {
          const node = smallestChunkableCovering(tree, nodeTypes, region.start, Math.min(region.end, lineCount));
          if (node) {
            symbol = symbolFor(node);
            if (nodeEndLine(node) - nodeStartLine(node) + 1 <= MAX_NODE_LINES) {
              start = nodeStartLine(node);
              end = nodeEndLine(node);
              structural = true;
            }
          }
        }
        ranges.push({ start, end, symbol, structural });
      }
      ranges = mergeRanges(ranges);
    }

    for (const r of ranges) {
      const code = lines.slice(r.start - 1, r.end).join('\n');
      const chunk = {
        id: `${filePath}:${r.start}-${r.end}`,
        file: filePath,
        startLine: r.start,
        endLine: r.end,
        code,
        language: langInfo.id,
        changeKind: file.status === 'added' ? 'added' : file.status === 'renamed' ? 'modified' : file.status,
        structural: Boolean(r.structural),
      };
      if (r.symbol) chunk.symbol = r.symbol;
      if (file.status === 'renamed') chunk.renamedFrom = file.oldPath;

      if (file.status !== 'added') {
        const oldRange = mapNewRangeToOld(file.hunks, r.start, r.end);
        if (oldRange) {
          try {
            const oldLines = splitLines(await source.readOld(file.oldPath || filePath));
            const oldSlice = oldLines.slice(oldRange[0] - 1, oldRange[1]).join('\n');
            if (oldSlice !== code) {
              chunk.oldCode = oldSlice;
              chunk.oldStartLine = oldRange[0];
            }
          } catch (err) {
            warn(`cannot read old content of ${file.oldPath || filePath}: ${err.message}`);
          }
        } else {
          chunk.changeKind = 'added';
        }
      }
      chunks.push(chunk);
    }
  }

  return { chunks, warnings };
}
