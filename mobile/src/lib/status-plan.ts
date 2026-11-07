// Pure rules for the host's status list editor. They mirror public.set_status_definitions, which
// silently skips a label that is empty, longer than 30 characters or "Emergency"; the editor
// reports those instead so nothing the host typed disappears without a message.

/** Same limit as the status_definitions.label check constraint. */
export const STATUS_LABEL_MAX = 30;

export type StatusLabelsResult =
  | { ok: true; labels: string[] }
  | { ok: false; error: 'tooLong' | 'emergency' | 'duplicate'; label: string };

/** Length as Postgres char_length counts it (code points), so an emoji counts once, not twice. */
export function statusLabelLength(label: string): number {
  return [...label].length;
}

/**
 * Trimmed labels in the host's order, ready for set_status_definitions. Blank rows are dropped.
 * A label over STATUS_LABEL_MAX, a label named Emergency (it is always included and cannot be
 * edited), or a repeated label (case-insensitive) is an error.
 */
export function normalizeStatusLabels(rows: readonly string[]): StatusLabelsResult {
  const labels: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const label = row.trim();
    if (!label) continue;
    if (statusLabelLength(label) > STATUS_LABEL_MAX) return { ok: false, error: 'tooLong', label };
    const key = label.toLowerCase();
    if (key === 'emergency') return { ok: false, error: 'emergency', label };
    if (seen.has(key)) return { ok: false, error: 'duplicate', label };
    seen.add(key);
    labels.push(label);
  }
  return { ok: true, labels };
}

/** Saved labels that the new list no longer contains. Members who chose one of them lose that status. */
export function removedStatusLabels(saved: readonly string[], next: readonly string[]): string[] {
  const keep = new Set(next);
  return saved.filter((label) => !keep.has(label));
}

/** Whether saving would change anything (labels or their order). */
export function statusLabelsChanged(saved: readonly string[], next: readonly string[]): boolean {
  return saved.length !== next.length || saved.some((label, i) => label !== next[i]);
}
