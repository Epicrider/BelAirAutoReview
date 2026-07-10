// BelAir review viewer. Plain JS on top of the Monaco AMD build served by
// server.js. One editor (plain or diff) is reused across steps; the step's
// description is rendered as a Monaco view zone anchored above the code, so it
// participates in normal scroll flow instead of floating over it.
'use strict';

(function () {
  const state = {
    manifest: null,
    comments: {},
    lineComments: {}, // { stepId: { realLine: text } }
    reviewed: {}, // { stepId: true }
    expand: {}, // { stepId: { above, below } } context lines requested
    overrides: {}, // { stepId: { code, oldCode, newStart, oldStart, chunkFrom, chunkTo, above, below } }
    newOffset: 0, // real file line of the first shown new-side line (with context)
    idx: 0,
    plainEditor: null,
    diffEditor: null,
    zoneIds: new Map(), // editor → description view zone id
    lineModal: null, // { step, realLine } while the line-comment modal is open
    plainDecorations: null, // added-line highlight in the plain editor
    diffLayout: 'side-by-side', // 'side-by-side' | 'inline'; persisted
    wordWrap: false, // wrap long code lines instead of horizontal scroll; persisted
    showAllInfo: false, // whether every step's order rationale is expanded
    collapsedFiles: new Set(), // sidebar file groups collapsed by the user
    theme: 'auto', // 'auto' | 'light' | 'dark' | 'sayori-light' | 'sayori-dark'
    sidebarView: 'steps', // 'steps' | 'files'
    review: null, // active review key ('' = legacy flat manifest), null before load
    filesBuilt: false, // Files view built once and cached
    viewingFile: null, // path of a full file loaded in the code view, or null
    fileCache: null, // { path, newContent, oldContent, changeKind } for the open file
    saveTimer: null,
  };

  const DIFF_LAYOUT_KEY = 'belair.diffLayout';
  const SIDEBAR_W_KEY = 'belair.sidebarWidth';
  const COMMENT_H_KEY = 'belair.commentHeight';
  const COLLAPSED_KEY = 'belair.collapsedFiles';
  const WRAP_KEY = 'belair.wordWrap';
  const THEME_KEY = 'belair.theme';
  const SIDEBAR_VIEW_KEY = 'belair.sidebarView';
  const REVIEW_KEY = 'belair.review';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Build an API URL that carries the active review key so every request targets
  // the right .review/<key>/ directory.
  function apiUrl(pathname, params = {}) {
    const usp = new URLSearchParams(params);
    if (state.review != null) usp.set('review', state.review);
    const qs = usp.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }

  async function fetchJsonSafe(url, fallback) {
    try {
      const res = await fetch(url);
      if (!res.ok) return fallback;
      return await res.json();
    } catch {
      return fallback;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showError(msg) {
    const el = $('error-banner');
    el.textContent = msg;
    el.hidden = false;
  }

  let toastTimer = null;
  function showToast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = kind || '';
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 7000);
  }

  // ---------- theme ----------
  // Diff add/remove backgrounds are strengthened so changes are unmistakable;
  // the same soft green/red is reused across all palettes for consistency.
  const DIFF_DARK = {
    'diffEditor.insertedLineBackground': '#22c55e29',
    'diffEditor.removedLineBackground': '#ef444426',
    'diffEditor.insertedTextBackground': '#22c55e29',
    'diffEditor.removedTextBackground': '#ef444459',
    'diffEditorGutter.insertedLineBackground': '#22c55e4d',
    'diffEditorGutter.removedLineBackground': '#ef44444d',
    'diffEditorOverview.insertedForeground': '#22c55eaa',
    'diffEditorOverview.removedForeground': '#ef4444aa',
    'diffEditor.diagonalFill': '#ffffff17',
  };
  const DIFF_LIGHT = {
    'diffEditor.insertedLineBackground': '#16a34a21',
    'diffEditor.removedLineBackground': '#dc262620',
    'diffEditor.insertedTextBackground': '#16a34a21',
    'diffEditor.removedTextBackground': '#dc26264d',
    'diffEditorGutter.insertedLineBackground': '#16a34a40',
    'diffEditorGutter.removedLineBackground': '#dc262640',
    'diffEditorOverview.insertedForeground': '#16a34aaa',
    'diffEditorOverview.removedForeground': '#dc2626aa',
    'diffEditor.diagonalFill': '#00000014',
  };

  // Theme registry. Doki Sayori palettes are from the Doki Theme (by
  // Unthrottled) master definitions; "auto" follows the OS preference.
  const THEMES = {
    auto: { label: 'Auto (system)' },
    light: { label: 'Light', dark: false, monaco: 'belair-light' },
    dark: { label: 'Dark', dark: true, monaco: 'belair-dark' },
    'sayori-light': {
      label: 'Doki Sayori Light',
      dark: false,
      monaco: 'sayori-light',
      bodyClass: 'theme-sayori-light',
    },
    'sayori-dark': {
      label: 'Doki Sayori Dark',
      dark: true,
      monaco: 'sayori-dark',
      bodyClass: 'theme-sayori-dark',
    },
  };

  let monacoThemesDefined = false;
  function defineMonacoThemes() {
    if (monacoThemesDefined || !window.monaco) return;
    monaco.editor.defineTheme('belair-light', { base: 'vs', inherit: true, rules: [], colors: { ...DIFF_LIGHT } });
    monaco.editor.defineTheme('belair-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { ...DIFF_DARK } });
    monaco.editor.defineTheme('sayori-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: '', foreground: 'bbbbbb' },
        { token: 'comment', foreground: '6b7a90', fontStyle: 'italic' },
        { token: 'string', foreground: 'ff89ba' },
        { token: 'keyword', foreground: '3f77ef' },
        { token: 'number', foreground: 'a486fd' },
        { token: 'constant', foreground: 'a486fd' },
        { token: 'type', foreground: '52ffa3' },
        { token: 'class', foreground: '52ffa3' },
        { token: 'function', foreground: '01cfe7' },
        { token: 'tag', foreground: '7da6ff' },
        { token: 'attribute.name', foreground: 'fff37c' },
      ],
      colors: {
        'editor.background': '#111b2d',
        'editor.foreground': '#bbbbbb',
        'editorLineNumber.foreground': '#666879',
        'editor.selectionBackground': '#234164',
        'editorCursor.foreground': '#00bcd4',
        ...DIFF_DARK,
      },
    });
    monaco.editor.defineTheme('sayori-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: '', foreground: '252427' },
        { token: 'comment', foreground: '7790af', fontStyle: 'italic' },
        { token: 'string', foreground: 'e59584' },
        { token: 'keyword', foreground: '3f77ef' },
        { token: 'number', foreground: '4c94d6' },
        { token: 'constant', foreground: '4c94d6' },
        { token: 'type', foreground: 'ef5d99' },
        { token: 'class', foreground: 'ef5d99' },
        { token: 'function', foreground: '2e7093' },
        { token: 'tag', foreground: '167bba' },
      ],
      colors: {
        'editor.background': '#f0faff',
        'editor.foreground': '#252427',
        'editorLineNumber.foreground': '#aaaaaa',
        'editor.selectionBackground': '#a9c8ec',
        'editorCursor.foreground': '#2e7093',
        ...DIFF_LIGHT,
      },
    });
    monacoThemesDefined = true;
  }

  function prefersDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme(id) {
    // Auto follows the OS but defaults to the Doki Sayori palettes.
    const resolved =
      id === 'auto' || !THEMES[id] ? (prefersDark() ? 'sayori-dark' : 'sayori-light') : id;
    const t = THEMES[resolved];
    document.body.classList.remove('dark', 'theme-sayori-light', 'theme-sayori-dark');
    if (t.dark) document.body.classList.add('dark');
    if (t.bodyClass) document.body.classList.add(t.bodyClass);
    if (window.monaco) {
      defineMonacoThemes();
      monaco.editor.setTheme(t.monaco);
    }
  }

  function setThemeById(id) {
    state.theme = THEMES[id] ? id : 'auto';
    try {
      localStorage.setItem(THEME_KEY, state.theme);
    } catch {
      /* storage disabled */
    }
    const sel = $('theme-select');
    if (sel) sel.value = state.theme;
    applyTheme(state.theme);
  }

  // Re-apply on OS change only while following the system.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme('auto');
  });

  // ---------- editors ----------
  const EDITOR_OPTS = {
    readOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'none',
    fontSize: 13,
    occurrencesHighlight: 'off',
    contextmenu: false,
  };

  function ensureEditors() {
    const wrap = state.wordWrap ? 'on' : 'off';
    if (!state.plainEditor) {
      state.plainEditor = monaco.editor.create($('editor-plain'), { ...EDITOR_OPTS, wordWrap: wrap });
      attachGutterHandler(state.plainEditor);
    }
    if (!state.diffEditor) {
      state.diffEditor = monaco.editor.createDiffEditor($('editor-diff'), {
        ...EDITOR_OPTS,
        wordWrap: wrap,
        renderSideBySide: state.diffLayout === 'side-by-side',
        enableSplitViewResizing: true,
        // Show where every change is: +/- gutter indicators, char-level inline
        // highlights (advanced algorithm), whitespace-sensitive, and colored
        // overview ruler ticks. No revert arrows — the viewer is read-only.
        renderIndicators: true,
        renderMarginRevertIcon: false,
        ignoreTrimWhitespace: false,
        diffAlgorithm: 'advanced',
        renderOverviewRuler: true,
      });
      attachGutterHandler(state.diffEditor.getModifiedEditor());
    }
  }

  function lineNumberFn(offset) {
    return (n) => String(n + offset - 1);
  }

  // ---------- diff layout toggle ----------
  function setDiffLayout(layout, { rerender = true } = {}) {
    state.diffLayout = layout === 'inline' ? 'inline' : 'side-by-side';
    try {
      localStorage.setItem(DIFF_LAYOUT_KEY, state.diffLayout);
    } catch {
      /* private mode / storage disabled — non-fatal */
    }
    for (const btn of document.querySelectorAll('#diff-layout .seg-btn')) {
      btn.classList.toggle('active', btn.dataset.layout === state.diffLayout);
    }
    if (state.diffEditor) {
      state.diffEditor.updateOptions({ renderSideBySide: state.diffLayout === 'side-by-side' });
    }
    // Re-render whatever's shown (step or full-file diff) so view-zone alignment
    // matches the new layout.
    if (rerender) rerenderCurrent();
  }

  // ---------- word wrap toggle ----------
  function setWordWrap(on, { rerender = true } = {}) {
    state.wordWrap = !!on;
    try {
      localStorage.setItem(WRAP_KEY, state.wordWrap ? '1' : '0');
    } catch {
      /* storage disabled */
    }
    $('btn-wrap').classList.toggle('active', state.wordWrap);
    const wrap = state.wordWrap ? 'on' : 'off';
    if (state.plainEditor) state.plainEditor.updateOptions({ wordWrap: wrap });
    if (state.diffEditor) {
      state.diffEditor.getOriginalEditor().updateOptions({ wordWrap: wrap });
      state.diffEditor.getModifiedEditor().updateOptions({ wordWrap: wrap });
    }
    // Wrapping changes line heights, so re-render to keep view zones aligned.
    if (rerender) rerenderCurrent();
  }

  // Re-render whatever the code panel is currently showing (a step, or a full
  // file) without switching between them.
  function rerenderCurrent() {
    if (state.viewingFile) showFile(state.viewingFile);
    else if (state.manifest) showStep(state.idx);
  }

  // ---------- resizable panels ----------
  // Drag the handle between the sidebar and code (x) or between the code and
  // comment box (y). Sizes are clamped and persisted; Monaco relayouts itself
  // (automaticLayout), and we re-render the step so the description zone is
  // re-measured for the new width.
  function makeDrag(handle, axis, apply, getStart, storageKey) {
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startPos = axis === 'x' ? e.clientX : e.clientY;
      const startSize = getStart();
      let lastSize = startSize;
      document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
      const move = (ev) => {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos;
        lastSize = apply(delta, startSize);
      };
      const up = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        document.body.classList.remove('resizing-x', 'resizing-y');
        try {
          localStorage.setItem(storageKey, String(Math.round(lastSize)));
        } catch {
          /* storage disabled */
        }
        rerenderCurrent();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  function initResizers() {
    const sidebar = $('sidebar');
    const commentBox = $('comment-box');
    try {
      const w = parseInt(localStorage.getItem(SIDEBAR_W_KEY), 10);
      if (w) sidebar.style.width = clamp(w, 160, 640) + 'px';
      const h = parseInt(localStorage.getItem(COMMENT_H_KEY), 10);
      if (h) commentBox.style.height = clamp(h, 70, 600) + 'px';
    } catch {
      /* storage disabled */
    }

    makeDrag(
      $('sidebar-resizer'),
      'x',
      (dx, start) => {
        const w = clamp(start + dx, 160, Math.min(640, window.innerWidth - 320));
        sidebar.style.width = w + 'px';
        return w;
      },
      () => sidebar.getBoundingClientRect().width,
      SIDEBAR_W_KEY
    );

    makeDrag(
      $('comment-resizer'),
      'y',
      (dy, start) => {
        const max = Math.max(70, $('main').getBoundingClientRect().height - 160);
        const h = clamp(start - dy, 70, max); // drag up grows the comment area
        commentBox.style.height = h + 'px';
        return h;
      },
      () => commentBox.getBoundingClientRect().height,
      COMMENT_H_KEY
    );
  }

  // ---------- per-line comments ----------
  // Comments anchored to a specific new-side file line, keyed by step id and
  // real file line. Click a line number to add/edit; saved notes render as
  // view zones under their line. Only the shown (new/plain) side is supported.
  function currentStep() {
    return state.manifest && state.manifest.steps[state.idx];
  }

  function codeEditorFor(step) {
    return typeof step.oldCode === 'string'
      ? state.diffEditor.getModifiedEditor()
      : state.plainEditor;
  }

  function lineCommentsFor(id) {
    return state.lineComments[id] || {};
  }

  function measureDomHeight(dom, width) {
    const probe = document.createElement('div');
    probe.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;width:${Math.max(240, width)}px;`;
    probe.appendChild(dom.cloneNode(true));
    document.body.appendChild(probe);
    const h = probe.firstChild.offsetHeight;
    probe.remove();
    return h;
  }

  function attachGutterHandler(editor) {
    editor.onMouseDown((e) => {
      const t = e.target;
      const types = monaco.editor.MouseTargetType;
      if (!t || t.position == null) return;
      // Any part of the left gutter: line numbers, glyph margin, or the line
      // decorations lane (where the comment dot lives).
      const gutter =
        t.type === types.GUTTER_LINE_NUMBERS ||
        t.type === types.GUTTER_GLYPH_MARGIN ||
        t.type === types.GUTTER_LINE_DECORATIONS;
      if (!gutter) return;
      if (state.viewingFile) return; // no line comments in the raw full-file view
      const step = currentStep();
      if (!step || codeEditorFor(step) !== editor) return;
      const realLine = t.position.lineNumber + state.newOffset - 1;
      openLineModal(step, realLine);
    });
  }

  // Editing happens in a small modal OUTSIDE Monaco: interactive controls inside
  // a view zone can't reliably receive mouse events (Monaco intercepts them in a
  // capture-phase handler), so inline editing didn't work. View zones are used
  // only to display saved comments read-only.
  function openLineModal(step, realLine) {
    state.lineModal = { step, realLine };
    const existing = lineCommentsFor(step.id)[realLine] || '';
    $('lc-title').textContent = `Comment on ${step.file} · line ${realLine}`;
    $('lc-input').value = existing;
    $('lc-delete').hidden = !existing;
    $('line-comment-backdrop').hidden = false;
    setTimeout(() => $('lc-input').focus(), 0);
  }

  function closeLineModal() {
    state.lineModal = null;
    $('line-comment-backdrop').hidden = true;
  }

  function initLineModal() {
    $('lc-save').addEventListener('click', () => {
      const m = state.lineModal;
      if (m) saveLineComment(m.step, m.realLine, $('lc-input').value);
    });
    $('lc-delete').addEventListener('click', () => {
      const m = state.lineModal;
      if (m) saveLineComment(m.step, m.realLine, '');
    });
    $('lc-cancel').addEventListener('click', closeLineModal);
    $('lc-close').addEventListener('click', closeLineModal);
    $('line-comment-backdrop').addEventListener('click', (e) => {
      if (e.target === $('line-comment-backdrop')) closeLineModal();
    });
  }

  async function saveLineComment(step, realLine, text) {
    try {
      const res = await fetch(apiUrl('/api/line-comments'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: step.id, line: realLine, text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const forStep = { ...lineCommentsFor(step.id) };
      if (text.trim() === '') delete forStep[realLine];
      else forStep[realLine] = text;
      if (Object.keys(forStep).length) state.lineComments[step.id] = forStep;
      else delete state.lineComments[step.id];
    } catch (err) {
      showToast(`Line comment save failed: ${err.message}`, 'error');
      return;
    }
    closeLineModal();
    renderLineComments(codeEditorFor(step), step);
  }

  function renderLineComments(editor, step) {
    const byLine = lineCommentsFor(step.id);
    if (!editor.__lineZoneIds) editor.__lineZoneIds = [];
    const width = (editor.getLayoutInfo().contentWidth || 600) - 24;
    editor.changeViewZones((acc) => {
      for (const id of editor.__lineZoneIds) acc.removeZone(id);
      editor.__lineZoneIds = [];
      for (const [lineStr, text] of Object.entries(byLine)) {
        const realLine = Number(lineStr);
        const modelLine = realLine - state.newOffset + 1;
        if (modelLine < 1) continue;

        const dom = document.createElement('div');
        dom.className = 'lc-box';
        const bar = document.createElement('div');
        bar.className = 'lc-bar';
        const tag = document.createElement('span');
        tag.className = 'lc-tag';
        tag.textContent = `💬 line ${realLine}`;
        const hint = document.createElement('span');
        hint.className = 'lc-edit-hint';
        hint.textContent = 'click line number to edit';
        bar.append(tag, hint);
        const body = document.createElement('div');
        body.className = 'lc-body';
        body.textContent = text;
        dom.append(bar, body);

        const height = measureDomHeight(dom, width) + 8;
        const id = acc.addZone({ afterLineNumber: modelLine, heightInPx: height, domNode: dom });
        editor.__lineZoneIds.push(id);
      }
    });

    // Mark commented lines in the gutter (per-editor decorations collection).
    const decos = Object.keys(byLine)
      .map((lineStr) => Number(lineStr) - state.newOffset + 1)
      .filter((modelLine) => modelLine >= 1)
      .map((modelLine) => ({
        range: new monaco.Range(modelLine, 1, modelLine, 1),
        options: { isWholeLine: true, linesDecorationsClassName: 'lc-gutter-dot' },
      }));
    if (!editor.__lineDeco) editor.__lineDeco = editor.createDecorationsCollection(decos);
    else editor.__lineDeco.set(decos);
  }

  // ---------- description view zone ----------
  function descriptionHtml(step) {
    let html = `<div class="dz-desc">${escapeHtml(step.description)}</div>`;
    if (step.orderRationale) {
      html += `<div class="dz-rationale">Why this step is here: ${escapeHtml(step.orderRationale)}</div>`;
    }
    return html;
  }

  function measureHeight(html, width) {
    const probe = document.createElement('div');
    probe.className = 'desc-zone';
    probe.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;width:${Math.max(240, width)}px;`;
    probe.innerHTML = html;
    document.body.appendChild(probe);
    const h = probe.offsetHeight;
    probe.remove();
    return h;
  }

  function setZone(editor, html) {
    // Pin the description to the editor's *viewport* width via a sticky inner
    // wrapper, so it wraps within view (no horizontal scroll even when the code
    // scrolls) and its measured height matches the rendered height (no dead
    // space). Measuring at the same fixed width is what keeps the two in sync.
    const layout = editor.getLayoutInfo();
    const width = Math.max(
      240,
      (layout.contentWidth || layout.width) - (layout.verticalScrollbarWidth || 0) - 24
    );
    const inner = html ? `<div class="desc-sticky" style="width:${width}px">${html}</div>` : '';
    const height = inner ? measureHeight(inner, width) : 0;
    editor.changeViewZones((acc) => {
      const prev = state.zoneIds.get(editor);
      if (prev) acc.removeZone(prev);
      if (!inner) {
        state.zoneIds.delete(editor);
        return;
      }
      const domNode = document.createElement('div');
      domNode.className = 'desc-zone';
      domNode.innerHTML = inner;
      const id = acc.addZone({ afterLineNumber: 0, heightInPx: height + 8, domNode });
      state.zoneIds.set(editor, id);
    });
    return height + 8;
  }

  function setSpacerZone(editor, height) {
    editor.changeViewZones((acc) => {
      const prev = state.zoneIds.get(editor);
      if (prev) acc.removeZone(prev);
      const domNode = document.createElement('div');
      const id = acc.addZone({ afterLineNumber: 0, heightInPx: height, domNode });
      state.zoneIds.set(editor, id);
    });
  }

  // ---------- step rendering ----------
  function revealStep(editor, lineCount) {
    // Center short chunks; long chunks start from the top so the description
    // zone is visible.
    const range = new monaco.Range(1, 1, Math.max(1, lineCount), 1);
    const approxHeight = lineCount * (EDITOR_OPTS.fontSize + 6);
    if (approxHeight < editor.getLayoutInfo().height) {
      editor.revealRangeInCenter(range, monaco.editor.ScrollType.Immediate);
      editor.setScrollTop(0); // zone sits above line 1 — keep it in view
    } else {
      editor.setScrollTop(0);
    }
  }

  function showStep(i) {
    if (!state.manifest) return; // no active review (e.g. after deleting the last one)
    closeLineModal(); // drop any open line-comment editor from the previous step
    if (state.viewingFile) {
      // Leaving the full-file view; restore the step controls.
      state.viewingFile = null;
      state.fileCache = null;
      $('btn-back-to-review').hidden = true;
      $('comment-box').hidden = false;
      $('comment-resizer').hidden = false;
      $('reviewed-toggle').style.display = '';
    }
    const steps = state.manifest.steps;
    state.idx = Math.max(0, Math.min(i, steps.length - 1));
    const step = steps[state.idx];
    const hasOld = typeof step.oldCode === 'string';

    $('btn-prev').disabled = state.idx === 0;
    $('btn-next').disabled = state.idx === steps.length - 1;
    $('reviewed-check').checked = !!state.reviewed[step.id];
    updateProgress();
    $('step-file').textContent = step.file;
    $('step-lines').textContent =
      step.changeKind === 'deleted' ? '(file deleted)' : `L${step.startLine}–${step.endLine}`;
    const kind = step.changeKind || (hasOld ? 'modified' : 'added');
    const kindEl = $('step-kind');
    kindEl.textContent = kind;
    kindEl.className = `badge badge-${kind}`;
    $('step-symbol').textContent = step.symbol ? `· ${step.symbol}` : '';

    $('editor-plain').hidden = hasOld;
    $('editor-diff').hidden = !hasOld;
    $('diff-layout').hidden = !hasOld; // layout toggle only applies to diffs
    ensureEditors();

    // A context-expanded view overrides the base chunk code/offsets when present.
    const exp = state.overrides[step.id];
    const view = exp || {
      code: step.code,
      oldCode: step.oldCode,
      newStart: step.startLine,
      oldStart: step.oldStartLine || step.startLine,
      chunkFrom: 1,
      chunkTo: null, // null = whole model is the chunk
      above: 0,
      below: 0,
    };
    state.newOffset = view.newStart;

    // Context controls: available for everything except deleted files (no new side).
    const canExpand = kind !== 'deleted';
    $('context-bar').hidden = !canExpand;
    $('btn-ctx-reset').hidden = !exp;
    $('ctx-status').textContent = exp ? `showing +${view.above} above · +${view.below} below` : '';

    const lang = step.language || 'plaintext';
    if (hasOld) {
      const editor = state.diffEditor;
      const prev = editor.getModel();
      const original = monaco.editor.createModel(view.oldCode, lang);
      const modified = monaco.editor.createModel(view.code, lang);
      editor.setModel({ original, modified });
      if (prev) {
        // Defer disposal so an in-flight diff computation against the old
        // models can settle instead of rejecting with "no diff result".
        setTimeout(() => {
          prev.original?.dispose();
          prev.modified?.dispose();
        }, 1000);
      }
      editor.getOriginalEditor().updateOptions({ lineNumbers: lineNumberFn(view.oldStart) });
      editor.getModifiedEditor().updateOptions({ lineNumbers: lineNumberFn(view.newStart) });
      const h = setZone(editor.getModifiedEditor(), descriptionHtml(step));
      setSpacerZone(editor.getOriginalEditor(), h); // keep the two sides aligned
      revealStep(editor.getModifiedEditor(), modified.getLineCount());
      renderLineComments(editor.getModifiedEditor(), step);
    } else {
      const editor = state.plainEditor;
      const prev = editor.getModel();
      const model = monaco.editor.createModel(view.code, lang);
      editor.setModel(model);
      prev?.dispose();
      editor.updateOptions({ lineNumbers: lineNumberFn(view.newStart) });
      // A no-oldCode step is wholly new content — highlight the chunk region
      // (not the surrounding context) so additions read like the diff view.
      state.plainDecorations?.clear();
      if (kind === 'added') {
        const to = view.chunkTo || model.getLineCount();
        state.plainDecorations = editor.createDecorationsCollection([
          {
            range: new monaco.Range(view.chunkFrom, 1, Math.max(view.chunkFrom, to), 1),
            options: {
              isWholeLine: true,
              className: 'belair-added-line',
              linesDecorationsClassName: 'belair-added-gutter',
            },
          },
        ]);
      }
      setZone(editor, descriptionHtml(step));
      revealStep(editor, model.getLineCount());
      renderLineComments(editor, step);
    }

    const box = $('comment');
    box.value = state.comments[step.id] ?? '';
    $('save-state').textContent = '';

    for (const el of document.querySelectorAll('#sidebar .step-item')) {
      const active = Number(el.dataset.idx) === state.idx;
      el.classList.toggle('active', active);
      if (active) {
        // Expand the active step's group if it was collapsed, so it's visible.
        const group = el.closest('.file-group');
        if (group && group.classList.contains('collapsed')) {
          group.classList.remove('collapsed');
          state.collapsedFiles.delete(group.dataset.file);
          saveCollapsedFiles();
          updateCollapseAllLabel();
        }
        el.scrollIntoView({ block: 'nearest' });
      }
    }
    // In the Files view, highlight the row for this step's file.
    if (state.sidebarView === 'files') markActiveFileRow(step.file);
  }

  // ---------- sidebar ----------
  function buildSidebar() {
    const steps = state.manifest.steps;
    const byFile = new Map();
    steps.forEach((s, i) => {
      if (!byFile.has(s.file)) byFile.set(s.file, []);
      byFile.get(s.file).push(i);
    });

    const frag = document.createDocumentFragment();
    for (const [file, indices] of byFile) {
      const group = document.createElement('div');
      group.className = 'file-group';
      group.dataset.file = file;
      if (state.collapsedFiles.has(file)) group.classList.add('collapsed');

      const h = document.createElement('div');
      h.className = 'file-name mono';
      h.title = file;
      const chevron = document.createElement('span');
      chevron.className = 'file-chevron';
      chevron.textContent = '▾';
      const name = document.createElement('span');
      name.className = 'file-name-text';
      name.textContent = file;
      h.append(chevron, name);
      h.addEventListener('click', () => toggleFileGroup(group, file));
      group.appendChild(h);

      const stepsWrap = document.createElement('div');
      stepsWrap.className = 'file-steps';

      indices.sort((a, b) => steps[a].startLine - steps[b].startLine);
      for (const idx of indices) {
        const s = steps[idx];
        const item = document.createElement('div');
        item.className = 'step-item';
        if (state.reviewed[s.id]) item.classList.add('reviewed');
        item.dataset.idx = String(idx);
        if (s.orderRationale) item.dataset.rationale = s.orderRationale;

        const label = document.createElement('span');
        label.className = 'step-label';
        label.textContent =
          `#${idx + 1} · ` +
          (s.changeKind === 'deleted' ? 'deleted' : `L${s.startLine}–${s.endLine}`) +
          (s.symbol ? ` · ${s.symbol}` : '');
        item.appendChild(label);

        const icons = document.createElement('span');
        icons.className = 'step-icons';
        const reviewedMark = document.createElement('span');
        reviewedMark.className = 'icon-reviewed';
        reviewedMark.textContent = '✓';
        reviewedMark.title = 'Reviewed';
        reviewedMark.style.visibility = state.reviewed[s.id] ? 'visible' : 'hidden';
        icons.appendChild(reviewedMark);
        const commentDot = document.createElement('span');
        commentDot.className = 'icon-comment';
        commentDot.dataset.stepId = s.id;
        commentDot.textContent = '💬';
        commentDot.title = 'Has a comment';
        commentDot.style.visibility = state.comments[s.id] ? 'visible' : 'hidden';
        icons.appendChild(commentDot);

        if (s.orderRationale) {
          const info = document.createElement('span');
          info.className = 'icon-rationale';
          info.textContent = 'ⓘ';
          info.title = s.orderRationale; // hover
          info.addEventListener('click', (e) => {
            e.stopPropagation(); // click toggles the inline rationale
            let r = item.nextElementSibling;
            if (r && r.classList.contains('rationale-inline')) {
              r.remove();
            } else {
              r = document.createElement('div');
              r.className = 'rationale-inline';
              r.textContent = s.orderRationale;
              item.after(r);
            }
          });
          icons.appendChild(info);
        }
        item.appendChild(icons);
        item.addEventListener('click', () => showStep(idx));
        stepsWrap.appendChild(item);
      }
      group.appendChild(stepsWrap);
      frag.appendChild(group);
    }
    const list = $('steps-list');
    list.textContent = '';
    list.appendChild(frag);

    // The show/hide-all-info control only makes sense when notes exist.
    $('btn-toggle-info').hidden = !steps.some((s) => s.orderRationale);
    updateCollapseAllLabel();
  }

  // ---------- collapsible file groups ----------
  // The active sidebar container (Steps or Files); collapse operations are
  // scoped to it since both use .file-group.
  function activeListEl() {
    return state.sidebarView === 'files' ? $('files-list') : $('steps-list');
  }

  function toggleFileGroup(group, file) {
    const collapsed = group.classList.toggle('collapsed');
    if (collapsed) state.collapsedFiles.add(file);
    else state.collapsedFiles.delete(file);
    saveCollapsedFiles();
    updateCollapseAllLabel();
  }

  function saveCollapsedFiles() {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...state.collapsedFiles]));
    } catch {
      /* storage disabled */
    }
  }

  function updateCollapseAllLabel() {
    const groups = activeListEl().querySelectorAll('.file-group');
    const anyOpen = [...groups].some((g) => !g.classList.contains('collapsed'));
    $('btn-collapse-all').textContent = anyOpen ? 'Collapse all' : 'Expand all';
  }

  function toggleCollapseAll() {
    const groups = [...activeListEl().querySelectorAll('.file-group')];
    const collapse = groups.some((g) => !g.classList.contains('collapsed'));
    // Only touch keys for the active view; keep the other view's collapse state.
    for (const g of groups) {
      g.classList.toggle('collapsed', collapse);
      if (collapse) state.collapsedFiles.add(g.dataset.file);
      else state.collapsedFiles.delete(g.dataset.file);
    }
    saveCollapsedFiles();
    updateCollapseAllLabel();
  }

  // Expand or collapse every step's inline order-rationale note at once.
  function setAllInfo(show) {
    state.showAllInfo = show;
    const btn = $('btn-toggle-info');
    if (btn) btn.textContent = show ? 'Hide all info' : 'Show all info';
    const list = $('steps-list');
    for (const r of list.querySelectorAll('.rationale-inline')) r.remove();
    if (show) {
      for (const item of list.querySelectorAll('.step-item')) {
        if (!item.dataset.rationale) continue;
        const r = document.createElement('div');
        r.className = 'rationale-inline';
        r.textContent = item.dataset.rationale;
        item.after(r);
      }
    }
  }

  function refreshCommentDots() {
    for (const dot of document.querySelectorAll('#sidebar .icon-comment')) {
      dot.style.visibility = state.comments[dot.dataset.stepId] ? 'visible' : 'hidden';
    }
  }

  // ---------- comments ----------
  async function saveComment(id, text) {
    $('save-state').textContent = 'saving…';
    try {
      const res = await fetch(apiUrl('/api/comments'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, text }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (text.trim() === '') delete state.comments[id];
      else state.comments[id] = text;
      $('save-state').textContent = 'saved ✓';
      refreshCommentDots();
    } catch (err) {
      $('save-state').textContent = `save failed: ${err.message}`;
    }
  }

  // ---------- publish to PR ----------
  async function publishToPr() {
    if (!state.manifest) return;
    const btn = $('btn-publish');
    const count = Object.values(state.comments).filter((t) => t && t.trim()).length;
    if (count === 0) {
      showToast('No comments to publish yet.', 'error');
      return;
    }
    const target = (state.manifest.source && state.manifest.source.target) || 'the PR';
    if (
      !confirm(
        `Post ${count} comment(s) to ${target} as PR review comments?\nThis creates real comments on GitHub.`
      )
    ) {
      return;
    }
    const prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Publishing…';
    try {
      const res = await fetch(apiUrl('/api/publish'), { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const fileLevel = body.results.filter((r) => r.status === 'posted-file').length;
      let msg = `Published ${body.posted} comment(s) to ${body.target}.`;
      if (fileLevel) msg += `\n${fileLevel} posted at file level (line was outside the PR diff).`;
      if (body.failed) {
        msg += `\n${body.failed} failed — see the browser console for details.`;
        console.warn('Publish failures:', body.results.filter((r) => r.status === 'failed'));
      }
      showToast(msg, body.failed ? 'error' : 'success');
    } catch (err) {
      showToast(`Publish failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }

  // ---------- overall review summary (agent-generated, read-only) ----------
  function openSummary() {
    $('summary-backdrop').hidden = false;
  }

  function closeSummary() {
    $('summary-backdrop').hidden = true;
  }

  // Wire summary controls once.
  function initSummary() {
    $('btn-summary').addEventListener('click', openSummary);
    $('summary-close').addEventListener('click', closeSummary);
    $('summary-backdrop').addEventListener('click', (e) => {
      if (e.target === $('summary-backdrop')) closeSummary();
    });
  }

  // Reflect the current manifest's summary (called per review load).
  function refreshSummary() {
    const summary = (state.manifest && typeof state.manifest.summary === 'string'
      ? state.manifest.summary
      : ''
    ).trim();
    closeSummary();
    $('btn-summary').hidden = !summary;
    $('summary-body').textContent = summary;
  }

  // ---------- reviewed state & progress ----------
  function reviewedCount() {
    const ids = new Set(state.manifest.steps.map((s) => s.id));
    return Object.keys(state.reviewed).filter((id) => ids.has(id)).length;
  }

  function updateProgress() {
    const total = state.manifest.steps.length;
    const done = reviewedCount();
    $('progress').textContent = `Step ${state.idx + 1} of ${total} · ${done} reviewed`;
    $('progress-bar-fill').style.width = total ? `${(done / total) * 100}%` : '0';
    const btn = $('btn-next-unreviewed');
    if (btn) btn.disabled = done >= total;
  }

  async function setReviewed(id, reviewed) {
    if (!state.manifest) return;
    if (reviewed) state.reviewed[id] = true;
    else delete state.reviewed[id];
    // Reflect immediately; persistence is best-effort.
    refreshReviewedMarks();
    updateProgress();
    try {
      const res = await fetch(apiUrl('/api/reviewed'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, reviewed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      showToast(`Could not save reviewed state: ${err.message}`, 'error');
    }
  }

  function refreshReviewedMarks() {
    for (const el of document.querySelectorAll('#sidebar .step-item')) {
      const id = state.manifest.steps[Number(el.dataset.idx)].id;
      const done = !!state.reviewed[id];
      el.classList.toggle('reviewed', done);
      const mark = el.querySelector('.icon-reviewed');
      if (mark) mark.style.visibility = done ? 'visible' : 'hidden';
    }
  }

  function jumpToNextUnreviewed() {
    if (!state.manifest) return;
    const steps = state.manifest.steps;
    for (let k = 1; k <= steps.length; k++) {
      const j = (state.idx + k) % steps.length;
      if (!state.reviewed[steps[j].id]) {
        showStep(j);
        return;
      }
    }
    showToast('All steps are marked reviewed.', 'success');
  }

  // ---------- sidebar view (steps vs files) ----------
  // Both views stay mounted; switching just toggles visibility so the Files
  // tree isn't refetched/rebuilt each time. Each is built lazily once.
  function setSidebarView(view) {
    state.sidebarView = view === 'files' ? 'files' : 'steps';
    try {
      localStorage.setItem(SIDEBAR_VIEW_KEY, state.sidebarView);
    } catch {
      /* storage disabled */
    }
    for (const btn of document.querySelectorAll('#sidebar-view .seg-btn')) {
      btn.classList.toggle('active', btn.dataset.view === state.sidebarView);
    }
    const showFiles = state.sidebarView === 'files';
    $('steps-list').hidden = showFiles;
    $('files-list').hidden = !showFiles;
    // The show/hide-all-info control only applies to the steps view.
    $('btn-toggle-info').hidden = showFiles || !stepsHaveRationale();
    if (showFiles && !state.filesBuilt) {
      buildFilesView(); // builds once; sets the active-row highlight
    } else {
      updateCollapseAllLabel();
      if (showFiles) markActiveFileRow(state.viewingFile || (currentStep() && currentStep().file));
    }
  }

  function stepsHaveRationale() {
    return state.manifest && state.manifest.steps.some((s) => s.orderRationale);
  }

  // File tree: every file in the changed folders (from /api/tree). Changed files
  // jump to their step; other files load full in the code view. Built once and
  // cached; the tree is stable for the life of the review.
  async function buildFilesView() {
    const list = $('files-list');
    list.textContent = 'Loading files…';
    let tree;
    try {
      tree = await (await fetch(apiUrl('/api/tree'))).json();
      if (tree.error) throw new Error(tree.error);
    } catch (err) {
      list.textContent = '';
      showToast(`Could not load file tree: ${err.message}`, 'error');
      return;
    }

    const frag = document.createDocumentFragment();
    for (const folder of tree.folders) {
      const group = document.createElement('div');
      group.className = 'file-group';
      const dirKey = `dir:${folder.dir}`;
      group.dataset.file = dirKey;
      if (state.collapsedFiles.has(dirKey)) group.classList.add('collapsed');

      const h = document.createElement('div');
      h.className = 'file-name mono';
      h.title = folder.dir || '(repo root)';
      const chevron = document.createElement('span');
      chevron.className = 'file-chevron';
      chevron.textContent = '▾';
      const name = document.createElement('span');
      name.className = 'file-name-text';
      name.textContent = folder.dir || '(repo root)';
      h.append(chevron, name);
      h.addEventListener('click', () => toggleFileGroup(group, dirKey));
      group.appendChild(h);

      const wrap = document.createElement('div');
      wrap.className = 'file-steps';
      for (const f of folder.files) {
        const item = document.createElement('div');
        item.className = 'file-item' + (f.changed ? ' changed' : '');
        item.dataset.path = f.path;
        const label = document.createElement('span');
        label.className = 'step-label';
        label.textContent = f.name;
        item.appendChild(label);
        if (f.changed) {
          const badge = document.createElement('span');
          badge.className = 'file-changed-dot';
          badge.textContent = '●';
          badge.title = 'Has changes in this review';
          item.appendChild(badge);
          item.addEventListener('click', () => showStep(f.stepIdx));
        } else {
          item.title = 'Load full file (no changes in this review)';
          item.addEventListener('click', () => showFile(f.path));
        }
        wrap.appendChild(item);
      }
      group.appendChild(wrap);
      frag.appendChild(group);
    }
    list.textContent = '';
    list.appendChild(frag);
    state.filesBuilt = true;
    updateCollapseAllLabel();
    // Reflect whatever the code panel is currently showing.
    markActiveFileRow(state.viewingFile || (currentStep() && currentStep().file));
  }

  // Highlight the file row matching a path (or clear all when null). A file with
  // several steps still highlights once, by path.
  function markActiveFileRow(activePath) {
    for (const el of document.querySelectorAll('#sidebar .file-item')) {
      const active = activePath != null && el.dataset.path === activePath;
      el.classList.toggle('active', active);
      if (active) el.scrollIntoView({ block: 'nearest' });
    }
  }

  // ---------- full-file view in the code panel ----------
  const EXT_LANG = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown',
    css: 'css', scss: 'scss', html: 'html', xml: 'xml', svg: 'xml',
    py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
    sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'ini',
    ini: 'ini', sql: 'sql', swift: 'swift', kt: 'kotlin',
  };
  function guessLang(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    return EXT_LANG[ext] || 'plaintext';
  }

  async function fetchFileContent(filePath, side) {
    const res = await fetch(apiUrl('/api/file', { file: filePath, side }));
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);
    return d.content;
  }

  // Load an entire file into the code view. A modified file is shown as a
  // whole-file diff (full old vs full new) so add/remove highlights are kept;
  // an added file shows plain with the added-line wash; an unchanged file
  // browsed from the Files view shows plain. Content is cached to avoid
  // refetching on re-render (wrap/resize).
  async function showFile(filePath) {
    ensureEditors();
    const step = state.manifest.steps.find((s) => s.file === filePath);
    const changeKind = step
      ? step.changeKind || (typeof step.oldCode === 'string' ? 'modified' : 'added')
      : 'unchanged';
    const wantDiff = changeKind === 'modified';

    let cache = state.fileCache;
    if (!cache || cache.path !== filePath) {
      try {
        const newContent = await fetchFileContent(filePath, 'new');
        const oldContent = wantDiff ? await fetchFileContent(filePath, 'old') : null;
        cache = { path: filePath, newContent, oldContent, changeKind };
      } catch (err) {
        showToast(`Could not load ${filePath}: ${err.message}`, 'error');
        return;
      }
      state.fileCache = cache;
    }

    closeLineModal();
    state.viewingFile = filePath;

    // Header + step controls off (this is a file, not a review step).
    $('step-file').textContent = filePath;
    $('step-symbol').textContent = '';
    $('context-bar').hidden = true;
    $('comment-box').hidden = true;
    $('comment-resizer').hidden = true;
    $('reviewed-toggle').style.display = 'none';
    $('btn-back-to-review').hidden = false;
    state.newOffset = 1;

    const kindEl = $('step-kind');
    const lang = guessLang(filePath);

    if (wantDiff && cache.oldContent != null) {
      // Whole-file diff — keeps the add/remove highlights across the file.
      $('editor-plain').hidden = true;
      $('editor-diff').hidden = false;
      $('diff-layout').hidden = false;
      const lines = cache.newContent.split('\n').length;
      $('step-lines').textContent = `(full file · ${lines} lines)`;
      kindEl.textContent = 'modified';
      kindEl.className = 'badge badge-modified';

      const editor = state.diffEditor;
      const prev = editor.getModel();
      const original = monaco.editor.createModel(cache.oldContent, lang);
      const modified = monaco.editor.createModel(cache.newContent, lang);
      editor.setModel({ original, modified });
      if (prev) {
        setTimeout(() => {
          prev.original?.dispose();
          prev.modified?.dispose();
        }, 1000);
      }
      editor.getOriginalEditor().updateOptions({ lineNumbers: 'on' });
      editor.getModifiedEditor().updateOptions({ lineNumbers: 'on' });
      const me = editor.getModifiedEditor();
      me.__lineDeco?.clear();
      setZone(me, ''); // no description zone
      setSpacerZone(editor.getOriginalEditor(), 0);
      me.setScrollTop(0);
    } else {
      // Plain full file (added or unchanged) — added files get the green wash.
      $('editor-plain').hidden = false;
      $('editor-diff').hidden = true;
      $('diff-layout').hidden = true;
      $('step-lines').textContent = `(full file · ${cache.newContent.split('\n').length} lines)`;
      kindEl.textContent = changeKind === 'added' ? 'added' : 'file';
      kindEl.className = changeKind === 'added' ? 'badge badge-added' : 'badge';

      const editor = state.plainEditor;
      const prev = editor.getModel();
      const model = monaco.editor.createModel(cache.newContent, lang);
      editor.setModel(model);
      prev?.dispose();
      editor.updateOptions({ lineNumbers: 'on' });
      state.plainDecorations?.clear();
      if (changeKind === 'added') {
        state.plainDecorations = editor.createDecorationsCollection([
          {
            range: new monaco.Range(1, 1, Math.max(1, model.getLineCount()), 1),
            options: {
              isWholeLine: true,
              className: 'belair-added-line',
              linesDecorationsClassName: 'belair-added-gutter',
            },
          },
        ]);
      }
      editor.__lineDeco?.clear();
      editor.changeViewZones((acc) => {
        for (const id of editor.__lineZoneIds || []) acc.removeZone(id);
        editor.__lineZoneIds = [];
      });
      setZone(editor, ''); // no description zone
      editor.setScrollTop(0);
    }

    for (const el of document.querySelectorAll('#sidebar .step-item')) el.classList.remove('active');
    markActiveFileRow(filePath); // highlight the row in the Files view
  }

  function backToReview() {
    state.viewingFile = null;
    state.fileCache = null;
    $('btn-back-to-review').hidden = true;
    $('comment-box').hidden = false;
    $('comment-resizer').hidden = false;
    $('reviewed-toggle').style.display = '';
    showStep(state.idx);
  }

  // ---------- expand context on demand ----------
  const CONTEXT_STEP = 15;

  async function fetchContext(file, start, end, side) {
    if (start > end) return { lines: [] };
    const res = await fetch(
      apiUrl('/api/context', { file, start: String(start), end: String(end), side })
    );
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  function toLines(text) {
    const arr = String(text).split('\n');
    if (arr.length && arr[arr.length - 1] === '') arr.pop(); // drop trailing newline artifact
    return arr;
  }

  async function buildOverride(step, counts) {
    const hasOld = typeof step.oldCode === 'string';
    const newStart = step.startLine;
    const newEnd = step.endLine;
    const oldStart = step.oldStartLine || step.startLine;

    const aboveNew = await fetchContext(step.file, newStart - counts.above, newStart - 1, 'new');
    const belowNew = await fetchContext(step.file, newEnd + 1, newEnd + counts.below, 'new');
    const aCount = aboveNew.lines.length;
    const bCount = belowNew.lines.length;

    const chunkNew = toLines(step.code);
    const newLines = [...aboveNew.lines, ...chunkNew, ...belowNew.lines];

    let oldCode;
    let oldStartShown = newStart - aCount;
    if (hasOld) {
      const oldChunk = toLines(step.oldCode);
      const oldEnd = oldStart + oldChunk.length - 1;
      // Match the new-side context counts so unchanged context stays aligned.
      const aboveOld = await fetchContext(step.file, oldStart - aCount, oldStart - 1, 'old');
      const belowOld = await fetchContext(step.file, oldEnd + 1, oldEnd + bCount, 'old');
      oldCode = [...aboveOld.lines, ...oldChunk, ...belowOld.lines].join('\n');
      oldStartShown = oldStart - aboveOld.lines.length;
    }

    state.overrides[step.id] = {
      code: newLines.join('\n'),
      oldCode,
      newStart: newStart - aCount,
      oldStart: oldStartShown,
      chunkFrom: aCount + 1,
      chunkTo: aCount + chunkNew.length,
      above: aCount,
      below: bCount,
    };
  }

  async function expandContext(dir) {
    const step = currentStep();
    if (!step) return;
    if (dir === 'reset') {
      delete state.expand[step.id];
      delete state.overrides[step.id];
      showStep(state.idx);
      return;
    }
    const counts = state.expand[step.id] || { above: 0, below: 0 };
    if (dir === 'above') counts.above += CONTEXT_STEP;
    else if (dir === 'below') counts.below += CONTEXT_STEP;
    state.expand[step.id] = counts;
    $('ctx-status').textContent = 'loading…';
    try {
      await buildOverride(step, counts);
    } catch (err) {
      showToast(`Could not load context: ${err.message}`, 'error');
      return;
    }
    showStep(state.idx);
  }

  // ---------- init ----------
  async function init() {
    let storedTheme = 'auto';
    try {
      storedTheme = localStorage.getItem(THEME_KEY) || 'auto';
    } catch {
      /* storage disabled */
    }
    state.theme = THEMES[storedTheme] ? storedTheme : 'auto';
    applyTheme(state.theme);

    let storedLayout = null;
    try {
      storedLayout = localStorage.getItem(DIFF_LAYOUT_KEY);
    } catch {
      /* storage disabled */
    }
    state.diffLayout = storedLayout === 'inline' ? 'inline' : 'side-by-side';

    try {
      state.collapsedFiles = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'));
    } catch {
      state.collapsedFiles = new Set();
    }

    try {
      state.wordWrap = localStorage.getItem(WRAP_KEY) === '1';
    } catch {
      state.wordWrap = false;
    }

    try {
      state.sidebarView = localStorage.getItem(SIDEBAR_VIEW_KEY) === 'files' ? 'files' : 'steps';
    } catch {
      state.sidebarView = 'steps';
    }

    initResizers();
    initSummary();
    initLineModal();
    $('btn-publish').addEventListener('click', publishToPr);

    $('btn-toggle-info').addEventListener('click', () => setAllInfo(!state.showAllInfo));
    $('btn-collapse-all').addEventListener('click', toggleCollapseAll);
    for (const btn of document.querySelectorAll('#sidebar-view .seg-btn')) {
      btn.addEventListener('click', () => setSidebarView(btn.dataset.view));
    }
    $('btn-full-file').addEventListener('click', () => {
      const step = currentStep();
      if (step) showFile(step.file);
    });
    $('btn-back-to-review').addEventListener('click', backToReview);

    $('btn-prev').addEventListener('click', () => showStep(state.idx - 1));
    $('btn-next').addEventListener('click', () => showStep(state.idx + 1));
    $('btn-next-unreviewed').addEventListener('click', jumpToNextUnreviewed);
    $('btn-ctx-above').addEventListener('click', () => expandContext('above'));
    $('btn-ctx-below').addEventListener('click', () => expandContext('below'));
    $('btn-ctx-reset').addEventListener('click', () => expandContext('reset'));
    $('reviewed-check').addEventListener('change', (e) => {
      if (!state.manifest) return;
      setReviewed(state.manifest.steps[state.idx].id, e.target.checked);
    });

    for (const btn of document.querySelectorAll('#diff-layout .seg-btn')) {
      btn.addEventListener('click', () => setDiffLayout(btn.dataset.layout));
    }
    setDiffLayout(state.diffLayout, { rerender: false }); // reflect stored pref in the buttons
    $('btn-wrap').addEventListener('click', () => setWordWrap(!state.wordWrap));
    $('btn-wrap').classList.toggle('active', state.wordWrap); // reflect stored pref

    const themeSel = $('theme-select');
    for (const [id, t] of Object.entries(THEMES)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = t.label;
      themeSel.appendChild(opt);
    }
    themeSel.value = state.theme;
    themeSel.addEventListener('change', () => setThemeById(themeSel.value));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('summary-backdrop').hidden) {
        closeSummary();
        return;
      }
      if (e.key === 'Escape' && state.lineModal) {
        closeLineModal();
        return;
      }
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.key === 'ArrowRight' || e.key === 'j') showStep(state.idx + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'k') showStep(state.idx - 1);
      else if (e.key === 'u') jumpToNextUnreviewed();
      else if (e.key === 'w') setWordWrap(!state.wordWrap);
      else if (e.key === 'r') {
        if (!state.manifest) return;
        const check = $('reviewed-check');
        check.checked = !check.checked;
        setReviewed(state.manifest.steps[state.idx].id, check.checked);
      }
    });

    // The description zone's width is fixed in px, so re-render on resize to
    // re-measure it against the new viewport width.
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        rerenderCurrent();
      }, 150);
    });

    $('comment').addEventListener('input', () => {
      if (!state.manifest || state.viewingFile) return;
      const step = state.manifest.steps[state.idx];
      $('save-state').textContent = 'unsaved…';
      clearTimeout(state.saveTimer);
      const value = $('comment').value;
      state.saveTimer = setTimeout(() => saveComment(step.id, value), 600);
    });
    // Flush pending edits when leaving the field.
    $('comment').addEventListener('blur', () => {
      if (!state.manifest || state.viewingFile) return;
      const step = state.manifest.steps[state.idx];
      clearTimeout(state.saveTimer);
      saveComment(step.id, $('comment').value);
    });

    $('review-select').addEventListener('change', () => loadReview($('review-select').value));
    $('btn-delete-review').addEventListener('click', deleteCurrentReview);

    await initReviews();
  }

  // ---------- review picker (multiple diffs in one server) ----------
  const LAST_ACTIVE_KEY = 'belair.lastActive';

  function reviewLabel(r) {
    const label = r.target || r.key || '(review)';
    return r.steps ? `${label} · ${r.steps} steps` : label;
  }

  function populateReviewPicker(reviews) {
    const sel = $('review-select');
    sel.textContent = '';
    for (const r of reviews) {
      const opt = document.createElement('option');
      opt.value = r.key;
      opt.textContent = reviewLabel(r);
      sel.appendChild(opt);
    }
    const has = reviews.length > 0;
    sel.hidden = !has;
    $('btn-delete-review').hidden = !has;
  }

  async function initReviews() {
    const data = await fetchJsonSafe('/api/reviews', { reviews: [], active: '' });
    if (!data.reviews.length) {
      populateReviewPicker([]);
      showError('No reviews found. Generate one (skill or bin/generate-manifest.js), then refresh.');
      $('progress').textContent = 'no reviews';
      return;
    }
    populateReviewPicker(data.reviews);
    const sel = $('review-select');

    const keys = data.reviews.map((r) => r.key);
    let stored = null;
    let lastActive = null;
    try {
      stored = localStorage.getItem(REVIEW_KEY);
      lastActive = localStorage.getItem(LAST_ACTIVE_KEY);
    } catch {
      /* storage disabled */
    }
    // A freshly generated/changed active review wins (so new diffs show up on
    // refresh); otherwise keep the user's manual selection.
    let chosen;
    if (data.active !== lastActive && keys.includes(data.active)) chosen = data.active;
    else if (stored != null && keys.includes(stored)) chosen = stored;
    else chosen = keys.includes(data.active) ? data.active : keys[0];
    try {
      localStorage.setItem(LAST_ACTIVE_KEY, data.active ?? '');
    } catch {
      /* storage disabled */
    }

    sel.value = chosen;
    await loadReview(chosen);
  }

  // Load a review's manifest + saved state and render it. Reused when switching
  // reviews via the picker.
  async function loadReview(key) {
    state.review = key;
    state.manifest = null; // inert until the new manifest loads (guards handlers)
    try {
      localStorage.setItem(REVIEW_KEY, key);
    } catch {
      /* storage disabled */
    }
    $('error-banner').hidden = true;

    let manifest;
    try {
      const res = await fetch(apiUrl('/api/manifest'));
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      manifest = body;
    } catch (err) {
      showError(`Could not load manifest: ${err.message}`);
      $('progress').textContent = 'no manifest';
      return;
    }
    if (!Array.isArray(manifest.steps) || manifest.steps.length === 0) {
      showError('This review has no steps.');
      $('progress').textContent = 'empty review';
      return;
    }
    state.manifest = manifest;
    state.comments = await fetchJsonSafe(apiUrl('/api/comments'), {});
    state.lineComments = await fetchJsonSafe(apiUrl('/api/line-comments'), {});
    state.reviewed = await fetchJsonSafe(apiUrl('/api/reviewed'), {});

    // Reset per-review view state.
    state.idx = 0;
    state.overrides = {};
    state.expand = {};
    state.viewingFile = null;
    state.fileCache = null;
    state.filesBuilt = false;
    $('files-list').textContent = '';
    $('btn-back-to-review').hidden = true;
    $('comment-box').hidden = false;
    $('comment-resizer').hidden = false;
    $('reviewed-toggle').style.display = '';

    const target = manifest.source
      ? `${manifest.source.mode ?? ''} — ${manifest.source.target ?? ''}`
      : '';
    $('target-info').textContent = target;
    $('target-info').title = manifest.generatedAt ? `generated ${manifest.generatedAt}` : '';
    $('btn-publish').hidden = !(manifest.source && manifest.source.mode === 'pr');

    refreshSummary();
    buildSidebar();
    showStep(0);
    setSidebarView(state.sidebarView);
  }

  // Delete the currently selected review (its manifest + all saved comments),
  // then switch to another review or show the empty state.
  async function deleteCurrentReview() {
    if (state.review == null) return;
    const label = $('review-select').selectedOptions[0]?.textContent || state.review || 'this review';
    if (
      !confirm(
        `Delete the review "${label}"?\n` +
          'This removes its manifest and all comments/notes for it, and cannot be undone.'
      )
    ) {
      return;
    }
    let data;
    try {
      const res = await fetch(apiUrl('/api/review'), { method: 'DELETE' });
      data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, 'error');
      return;
    }
    showToast('Review deleted.', 'success');
    try {
      localStorage.removeItem(REVIEW_KEY);
    } catch {
      /* storage disabled */
    }

    populateReviewPicker(data.reviews);
    if (!data.reviews.length) {
      state.review = null;
      state.manifest = null;
      $('steps-list').textContent = '';
      $('files-list').textContent = '';
      $('progress').textContent = 'no reviews';
      $('target-info').textContent = '';
      showError('No reviews left. Generate one, then refresh.');
      return;
    }
    const next = data.reviews.some((r) => r.key === data.active) ? data.active : data.reviews[0].key;
    $('review-select').value = next;
    await loadReview(next);
  }

  window.__startApp = init;
  if (window.__monacoReady) init();
})();
