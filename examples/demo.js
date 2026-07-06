// Demo module used only to exercise the BelAir review viewer's publish flow.
// Not part of the tool; safe to delete.

export function greet(name) {
  const who = String(name || '').trim() || 'world';
  return `Hello, ${who}!`;
}

export function add(a, b) {
  return Number(a) + Number(b);
}

export function summarize(items) {
  if (!Array.isArray(items) || items.length === 0) return 'nothing to summarize';
  return `${items.length} item(s): ${items.join(', ')}`;
}
