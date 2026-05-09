/**
 * Translate a Cedar-style glob into a regex.
 * - `**` matches anything (including / and :)
 * - `*`  matches a single segment (no / and no :)
 * Everything else is treated literally (regex-escaped).
 */
export function globToRegex(glob: string): RegExp | null {
  const STAR2 = " DOUBLESTAR ";
  const STAR1 = " SINGLESTAR ";
  const placeheld = glob.replace(/\*\*/g, STAR2).replace(/\*/g, STAR1);
  const escaped = placeheld.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped
    .replace(new RegExp(STAR2, "g"), ".*")
    .replace(new RegExp(STAR1, "g"), "[^/:]*");
  try {
    return new RegExp("^" + pattern + "$");
  } catch {
    return null;
  }
}
