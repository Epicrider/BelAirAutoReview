// Manifest schema: build (chunks + review notes → manifest) and validate.
//
// Manifest shape (the viewer's contract):
// {
//   "steps": [{
//     "id": string, "file": string, "startLine": int, "endLine": int,
//     "code": string, "oldCode"?: string, "description": string,
//     "language": string, "orderRationale"?: string,
//     // extras carried through for the viewer: oldStartLine, symbol, changeKind
//   }]
// }

/**
 * Merge a chunks document with review notes ({order, annotations}) into a manifest.
 * @returns {{manifest: object|null, errors: string[]}}
 */
export function buildManifest(chunksDoc, notes) {
  const errors = [];
  if (!chunksDoc || !Array.isArray(chunksDoc.chunks)) {
    return { manifest: null, errors: ['chunks file is malformed (missing "chunks" array)'] };
  }
  if (!notes || !Array.isArray(notes.order)) {
    return { manifest: null, errors: ['notes file is malformed (missing "order" array)'] };
  }
  const annotations = notes.annotations || {};
  const chunkById = new Map(chunksDoc.chunks.map((c) => [c.id, c]));

  const seen = new Set();
  for (const id of notes.order) {
    if (!chunkById.has(id)) errors.push(`order references unknown chunk id: ${id}`);
    if (seen.has(id)) errors.push(`duplicate chunk id in order: ${id}`);
    seen.add(id);
  }
  for (const id of chunkById.keys()) {
    if (!seen.has(id)) errors.push(`chunk missing from order: ${id}`);
  }

  const steps = [];
  for (const id of notes.order) {
    const c = chunkById.get(id);
    if (!c) continue;
    const a = annotations[id] || {};
    const description = String(a.description ?? '').trim();
    if (!description) errors.push(`missing description for chunk: ${id}`);

    const step = {
      id: c.id,
      file: c.file,
      startLine: c.startLine,
      endLine: c.endLine,
      code: c.code,
    };
    if (typeof c.oldCode === 'string') {
      step.oldCode = c.oldCode;
      if (c.oldStartLine) step.oldStartLine = c.oldStartLine;
    }
    step.description = description;
    step.language = c.language || 'plaintext';
    const rationale = String(a.orderRationale ?? '').trim();
    if (rationale) step.orderRationale = rationale;
    if (c.symbol) step.symbol = c.symbol;
    if (c.changeKind) step.changeKind = c.changeKind;
    steps.push(step);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: { mode: chunksDoc.mode, target: chunksDoc.target },
    steps,
  };
  return { manifest: errors.length ? null : manifest, errors };
}

/** @returns {string[]} validation errors (empty when valid) */
export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || !Array.isArray(manifest.steps)) {
    return ['manifest must be an object with a "steps" array'];
  }
  const ids = new Set();
  manifest.steps.forEach((s, i) => {
    const where = `steps[${i}]${s && s.id ? ` (${s.id})` : ''}`;
    if (!s || typeof s !== 'object') {
      errors.push(`${where}: not an object`);
      return;
    }
    if (typeof s.id !== 'string' || !s.id) errors.push(`${where}: missing string "id"`);
    else if (ids.has(s.id)) errors.push(`${where}: duplicate id`);
    else ids.add(s.id);
    if (typeof s.file !== 'string' || !s.file) errors.push(`${where}: missing string "file"`);
    if (!Number.isInteger(s.startLine) || s.startLine < 1)
      errors.push(`${where}: "startLine" must be an integer >= 1`);
    if (!Number.isInteger(s.endLine) || s.endLine < s.startLine)
      errors.push(`${where}: "endLine" must be an integer >= startLine`);
    if (typeof s.code !== 'string') errors.push(`${where}: missing string "code"`);
    if (typeof s.description !== 'string' || !s.description.trim())
      errors.push(`${where}: missing non-empty "description"`);
    if (typeof s.language !== 'string' || !s.language)
      errors.push(`${where}: missing string "language"`);
    if (s.oldCode !== undefined && typeof s.oldCode !== 'string')
      errors.push(`${where}: "oldCode" must be a string when present`);
    if (s.orderRationale !== undefined && typeof s.orderRationale !== 'string')
      errors.push(`${where}: "orderRationale" must be a string when present`);
  });
  return errors;
}
