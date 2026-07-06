// BelAir review viewer. Plain JS on top of the Monaco AMD build served by
// server.js. One editor (plain or diff) is reused across steps; the step's
// description is rendered as a Monaco view zone anchored above the code, so it
// participates in normal scroll flow instead of floating over it.
'use strict';

(function () {
  const state = {
    manifest: null,
    comments: {},
    idx: 0,
    plainEditor: null,
    diffEditor: null,
    zoneIds: new Map(), // editor → view zone id
    plainDecorations: null, // added-line highlight in the plain editor
    diffLayout: 'side-by-side', // 'side-by-side' | 'inline'; persisted
    saveTimer: null,
  };

  const DIFF_LAYOUT_KEY = 'belair.diffLayout';
  const SIDEBAR_W_KEY = 'belair.sidebarWidth';
  const COMMENT_H_KEY = 'belair.commentHeight';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

  // ---------- theme ----------
  // Custom themes strengthen the diff add/remove backgrounds (both the whole
  // line and the inline character ranges) so changes are unmistakable in the
  // side-by-side view; they inherit everything else from the stock vs themes.
  let themesDefined = false;
  function defineThemes() {
    if (themesDefined || !window.monaco) return;
    monaco.editor.defineTheme('belair-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        // Green matches the added-file wash (.belair-added-line, rgba(22,163,74,0.13));
        // line and inline-char share one value so inserts aren't over-saturated.
        'diffEditor.insertedLineBackground': '#16a34a21',
        'diffEditor.removedLineBackground': '#dc262620',
        'diffEditor.insertedTextBackground': '#16a34a21',
        'diffEditor.removedTextBackground': '#dc26264d',
        'diffEditorGutter.insertedLineBackground': '#16a34a40',
        'diffEditorGutter.removedLineBackground': '#dc262640',
        'diffEditorOverview.insertedForeground': '#16a34aaa',
        'diffEditorOverview.removedForeground': '#dc2626aa',
        'diffEditor.diagonalFill': '#00000014',
      },
    });
    monaco.editor.defineTheme('belair-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        // Green matches the added-file wash (body.dark .belair-added-line, rgba(34,197,94,0.16)).
        'diffEditor.insertedLineBackground': '#22c55e29',
        'diffEditor.removedLineBackground': '#ef444426',
        'diffEditor.insertedTextBackground': '#22c55e29',
        'diffEditor.removedTextBackground': '#ef444459',
        'diffEditorGutter.insertedLineBackground': '#22c55e4d',
        'diffEditorGutter.removedLineBackground': '#ef44444d',
        'diffEditorOverview.insertedForeground': '#22c55eaa',
        'diffEditorOverview.removedForeground': '#ef4444aa',
        'diffEditor.diagonalFill': '#ffffff17',
      },
    });
    themesDefined = true;
  }

  function applyTheme() {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.body.classList.toggle('dark', dark);
    if (window.monaco) {
      defineThemes();
      monaco.editor.setTheme(dark ? 'belair-dark' : 'belair-light');
    }
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

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
    if (!state.plainEditor) {
      state.plainEditor = monaco.editor.create($('editor-plain'), { ...EDITOR_OPTS });
    }
    if (!state.diffEditor) {
      state.diffEditor = monaco.editor.createDiffEditor($('editor-diff'), {
        ...EDITOR_OPTS,
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
    // Re-render the current step so view-zone alignment matches the new layout.
    if (rerender && state.manifest) showStep(state.idx);
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
        if (state.manifest) showStep(state.idx);
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
    const layout = editor.getLayoutInfo();
    const width = (layout.contentWidth || layout.width) - 16;
    const height = html ? measureHeight(html, width) : 0;
    editor.changeViewZones((acc) => {
      const prev = state.zoneIds.get(editor);
      if (prev) acc.removeZone(prev);
      if (!html && !height) {
        state.zoneIds.delete(editor);
        return;
      }
      const domNode = document.createElement('div');
      domNode.className = 'desc-zone';
      domNode.innerHTML = html;
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
    const steps = state.manifest.steps;
    state.idx = Math.max(0, Math.min(i, steps.length - 1));
    const step = steps[state.idx];
    const hasOld = typeof step.oldCode === 'string';

    $('progress').textContent = `Step ${state.idx + 1} of ${steps.length}`;
    $('btn-prev').disabled = state.idx === 0;
    $('btn-next').disabled = state.idx === steps.length - 1;
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

    const lang = step.language || 'plaintext';
    if (hasOld) {
      const editor = state.diffEditor;
      const prev = editor.getModel();
      const original = monaco.editor.createModel(step.oldCode, lang);
      const modified = monaco.editor.createModel(step.code, lang);
      editor.setModel({ original, modified });
      if (prev) {
        // Defer disposal so an in-flight diff computation against the old
        // models can settle instead of rejecting with "no diff result".
        setTimeout(() => {
          prev.original?.dispose();
          prev.modified?.dispose();
        }, 1000);
      }
      const oldStart = step.oldStartLine || step.startLine;
      editor.getOriginalEditor().updateOptions({ lineNumbers: lineNumberFn(oldStart) });
      editor.getModifiedEditor().updateOptions({ lineNumbers: lineNumberFn(step.startLine) });
      const h = setZone(editor.getModifiedEditor(), descriptionHtml(step));
      setSpacerZone(editor.getOriginalEditor(), h); // keep the two sides aligned
      revealStep(editor.getModifiedEditor(), modified.getLineCount());
    } else {
      const editor = state.plainEditor;
      const prev = editor.getModel();
      const model = monaco.editor.createModel(step.code, lang);
      editor.setModel(model);
      prev?.dispose();
      editor.updateOptions({ lineNumbers: lineNumberFn(step.startLine) });
      // A no-oldCode step is wholly new content — mark every line as added so
      // additions are highlighted here too, matching the diff view.
      state.plainDecorations?.clear();
      if (kind === 'added') {
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
      setZone(editor, descriptionHtml(step));
      revealStep(editor, model.getLineCount());
    }

    const box = $('comment');
    box.value = state.comments[step.id] ?? '';
    $('save-state').textContent = '';

    for (const el of document.querySelectorAll('#sidebar .step-item')) {
      const active = Number(el.dataset.idx) === state.idx;
      el.classList.toggle('active', active);
      if (active) el.scrollIntoView({ block: 'nearest' });
    }
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
      const h = document.createElement('div');
      h.className = 'file-name mono';
      h.textContent = file;
      h.title = file;
      group.appendChild(h);

      indices.sort((a, b) => steps[a].startLine - steps[b].startLine);
      for (const idx of indices) {
        const s = steps[idx];
        const item = document.createElement('div');
        item.className = 'step-item';
        item.dataset.idx = String(idx);

        const label = document.createElement('span');
        label.className = 'step-label';
        label.textContent =
          `#${idx + 1} · ` +
          (s.changeKind === 'deleted' ? 'deleted' : `L${s.startLine}–${s.endLine}`) +
          (s.symbol ? ` · ${s.symbol}` : '');
        item.appendChild(label);

        const icons = document.createElement('span');
        icons.className = 'step-icons';
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
        group.appendChild(item);
      }
      frag.appendChild(group);
    }
    const sidebar = $('sidebar');
    sidebar.textContent = '';
    sidebar.appendChild(frag);
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
      const res = await fetch('/api/comments', {
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

  // ---------- init ----------
  async function init() {
    applyTheme();

    let storedLayout = null;
    try {
      storedLayout = localStorage.getItem(DIFF_LAYOUT_KEY);
    } catch {
      /* storage disabled */
    }
    state.diffLayout = storedLayout === 'inline' ? 'inline' : 'side-by-side';

    let manifest;
    try {
      const res = await fetch('/api/manifest');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      manifest = body;
    } catch (err) {
      showError(`Could not load manifest: ${err.message}`);
      $('progress').textContent = 'no manifest';
      return;
    }
    if (!Array.isArray(manifest.steps) || manifest.steps.length === 0) {
      showError('Manifest has no steps.');
      return;
    }
    state.manifest = manifest;

    try {
      state.comments = await (await fetch('/api/comments')).json();
    } catch {
      state.comments = {};
    }

    const target = manifest.source
      ? `${manifest.source.mode ?? ''} — ${manifest.source.target ?? ''}`
      : '';
    $('target-info').textContent = target;
    $('target-info').title = manifest.generatedAt ? `generated ${manifest.generatedAt}` : '';

    buildSidebar();
    initResizers();

    $('btn-prev').addEventListener('click', () => showStep(state.idx - 1));
    $('btn-next').addEventListener('click', () => showStep(state.idx + 1));

    for (const btn of document.querySelectorAll('#diff-layout .seg-btn')) {
      btn.addEventListener('click', () => setDiffLayout(btn.dataset.layout));
    }
    setDiffLayout(state.diffLayout, { rerender: false }); // reflect stored pref in the buttons

    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      if (e.key === 'ArrowRight' || e.key === 'j') showStep(state.idx + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'k') showStep(state.idx - 1);
    });

    $('comment').addEventListener('input', () => {
      const step = state.manifest.steps[state.idx];
      $('save-state').textContent = 'unsaved…';
      clearTimeout(state.saveTimer);
      const value = $('comment').value;
      state.saveTimer = setTimeout(() => saveComment(step.id, value), 600);
    });
    // Flush pending edits when leaving the field.
    $('comment').addEventListener('blur', () => {
      const step = state.manifest.steps[state.idx];
      clearTimeout(state.saveTimer);
      saveComment(step.id, $('comment').value);
    });

    showStep(0);
  }

  window.__startApp = init;
  if (window.__monacoReady) init();
})();
