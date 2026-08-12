/**
 * Path canonicalization.
 *
 * A path reported by the pull-request API (`./package.json`) and a path recorded
 * in `graph.json` (`package.json`) describe the same file, so both sides are
 * reduced to the same form before they are compared. Without this, a declaration
 * site would silently fail to match and impact would be under-reported.
 */

/** Normalize a repo-relative path: strip `./`, collapse `\` to `/`, drop leading `/`. */
export function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}
