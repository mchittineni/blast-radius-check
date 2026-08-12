/**
 * Markdown escaping for untrusted values.
 *
 * Artifact names, file paths and version ranges are read out of arbitrary
 * repository content and then rendered into a pull-request comment. Without
 * escaping, a crafted `package.json` name could break out of a table cell or
 * inject HTML into the comment body.
 */

/** Escape a value for use inside an inline code span in a table cell. */
export function escapeInlineCode(value: string): string {
  const collapsed = value.replace(/[\r\n]+/g, ' ').trim();
  // Backticks would close the span; pipes would start a new table cell.
  const neutralized = collapsed.replace(/`/g, 'ˋ').replace(/\|/g, '\\|');
  return neutralized === '' ? '(empty)' : neutralized;
}
