// Language detection: maps file extensions to Monaco language ids and, where a
// tree-sitter grammar is bundled (via @vscode/tree-sitter-wasm), to the
// grammar + the node types that make good review-chunk boundaries.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Grammar definitions: wasm basename candidates
// (@vscode/tree-sitter-wasm/wasm/tree-sitter-<name>.wasm) and the node types
// treated as chunk boundaries (functions/methods/classes/types).
const GRAMMARS = {
  javascript: {
    wasmNames: ['javascript'],
    nodeTypes: [
      'function_declaration',
      'generator_function_declaration',
      'method_definition',
      'class_declaration',
    ],
  },
  typescript: {
    wasmNames: ['typescript'],
    nodeTypes: [
      'function_declaration',
      'generator_function_declaration',
      'method_definition',
      'class_declaration',
      'abstract_class_declaration',
      'interface_declaration',
      'type_alias_declaration',
      'enum_declaration',
    ],
  },
  tsx: {
    wasmNames: ['tsx'],
    nodeTypes: [
      'function_declaration',
      'generator_function_declaration',
      'method_definition',
      'class_declaration',
      'abstract_class_declaration',
      'interface_declaration',
      'type_alias_declaration',
      'enum_declaration',
    ],
  },
  python: {
    wasmNames: ['python'],
    nodeTypes: ['function_definition', 'class_definition', 'decorated_definition'],
  },
  go: {
    wasmNames: ['go'],
    nodeTypes: ['function_declaration', 'method_declaration', 'type_declaration'],
  },
  rust: {
    wasmNames: ['rust'],
    nodeTypes: ['function_item', 'struct_item', 'enum_item', 'impl_item', 'trait_item'],
  },
  java: {
    wasmNames: ['java'],
    nodeTypes: [
      'method_declaration',
      'constructor_declaration',
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
    ],
  },
  c: {
    wasmNames: ['cpp'], // no standalone C grammar in the bundle; cpp parses C fine here
    nodeTypes: ['function_definition', 'struct_specifier', 'enum_specifier'],
  },
  cpp: {
    wasmNames: ['cpp'],
    nodeTypes: ['function_definition', 'class_specifier', 'struct_specifier', 'enum_specifier'],
  },
  csharp: {
    wasmNames: ['c-sharp'],
    nodeTypes: [
      'method_declaration',
      'constructor_declaration',
      'class_declaration',
      'interface_declaration',
      'enum_declaration',
      'struct_declaration',
    ],
  },
  ruby: {
    wasmNames: ['ruby'],
    nodeTypes: ['method', 'singleton_method', 'class', 'module'],
  },
  php: {
    wasmNames: ['php'],
    nodeTypes: [
      'function_definition',
      'method_declaration',
      'class_declaration',
      'interface_declaration',
      'trait_declaration',
    ],
  },
};

// ext (without dot, lowercased) → { monaco, grammar? }
const EXT_MAP = {
  js: { monaco: 'javascript', grammar: 'javascript' },
  mjs: { monaco: 'javascript', grammar: 'javascript' },
  cjs: { monaco: 'javascript', grammar: 'javascript' },
  jsx: { monaco: 'javascript', grammar: 'javascript' },
  ts: { monaco: 'typescript', grammar: 'typescript' },
  mts: { monaco: 'typescript', grammar: 'typescript' },
  cts: { monaco: 'typescript', grammar: 'typescript' },
  tsx: { monaco: 'typescript', grammar: 'tsx' },
  py: { monaco: 'python', grammar: 'python' },
  pyi: { monaco: 'python', grammar: 'python' },
  go: { monaco: 'go', grammar: 'go' },
  rs: { monaco: 'rust', grammar: 'rust' },
  java: { monaco: 'java', grammar: 'java' },
  c: { monaco: 'c', grammar: 'c' },
  h: { monaco: 'c', grammar: 'c' },
  cc: { monaco: 'cpp', grammar: 'cpp' },
  cpp: { monaco: 'cpp', grammar: 'cpp' },
  cxx: { monaco: 'cpp', grammar: 'cpp' },
  hpp: { monaco: 'cpp', grammar: 'cpp' },
  hh: { monaco: 'cpp', grammar: 'cpp' },
  cs: { monaco: 'csharp', grammar: 'csharp' },
  rb: { monaco: 'ruby', grammar: 'ruby' },
  php: { monaco: 'php', grammar: 'php' },
  // Highlight-only (hunk-based chunking):
  json: { monaco: 'json' },
  jsonc: { monaco: 'json' },
  yml: { monaco: 'yaml' },
  yaml: { monaco: 'yaml' },
  toml: { monaco: 'ini' },
  ini: { monaco: 'ini' },
  md: { monaco: 'markdown' },
  markdown: { monaco: 'markdown' },
  html: { monaco: 'html' },
  htm: { monaco: 'html' },
  css: { monaco: 'css' },
  scss: { monaco: 'scss' },
  less: { monaco: 'less' },
  sql: { monaco: 'sql' },
  sh: { monaco: 'shell' },
  bash: { monaco: 'shell' },
  zsh: { monaco: 'shell' },
  xml: { monaco: 'xml' },
  svg: { monaco: 'xml' },
  kt: { monaco: 'kotlin' },
  kts: { monaco: 'kotlin' },
  swift: { monaco: 'swift' },
  lua: { monaco: 'lua' },
  r: { monaco: 'r' },
  pl: { monaco: 'perl' },
  dockerfile: { monaco: 'dockerfile' },
  graphql: { monaco: 'graphql' },
  proto: { monaco: 'proto' },
  vue: { monaco: 'html' },
  svelte: { monaco: 'html' },
  env: { monaco: 'shell' },
};

const BASENAME_MAP = {
  dockerfile: { monaco: 'dockerfile' },
  makefile: { monaco: 'plaintext' },
  '.gitignore': { monaco: 'plaintext' },
  '.env': { monaco: 'shell' },
};

let wasmDirCache;
function wasmDir() {
  if (wasmDirCache !== undefined) return wasmDirCache;
  try {
    const pkg = require.resolve('@vscode/tree-sitter-wasm/package.json');
    wasmDirCache = path.join(path.dirname(pkg), 'wasm');
  } catch {
    wasmDirCache = null;
  }
  return wasmDirCache;
}

function resolveWasm(grammarKey) {
  const dir = wasmDir();
  if (!dir) return null;
  for (const name of GRAMMARS[grammarKey].wasmNames) {
    const p = path.join(dir, `tree-sitter-${name}.wasm`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * @param {string} filePath
 * @returns {{ id: string, grammar: null | { wasmPath: string, nodeTypes: Set<string> } }}
 */
export function languageForFile(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  const entry = EXT_MAP[ext] || BASENAME_MAP[base] || { monaco: 'plaintext' };
  let grammar = null;
  if (entry.grammar) {
    const wasmPath = resolveWasm(entry.grammar);
    if (wasmPath) {
      grammar = { wasmPath, nodeTypes: new Set(GRAMMARS[entry.grammar].nodeTypes) };
    }
  }
  return { id: entry.monaco, grammar };
}
