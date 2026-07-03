// Ported from playwriter (MIT) src/diff-utils.ts.
import { structuredPatch } from 'diff';

export interface SmartDiffResult {
  type: 'diff' | 'full' | 'no-change';
  content: string;
}

export interface CreateSmartDiffOptions {
  oldContent: string;
  newContent: string;
  /** Change ratio (0-1) above which full content is returned instead of a diff. Default 0.5. */
  threshold?: number;
  /** Label used in the diff header. */
  label?: string;
}

// When more than `threshold` of lines changed (or the diff is longer than the
// content itself), a diff is not useful — return the full new content instead.
export function createSmartDiff(options: CreateSmartDiffOptions): SmartDiffResult {
  const { oldContent, newContent, threshold = 0.5, label = 'content' } = options;

  const patch = structuredPatch(label, label, oldContent, newContent, 'previous', 'current', {
    context: 3,
  });

  let addedLines = 0;
  let removedLines = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) addedLines++;
      else if (line.startsWith('-')) removedLines++;
    }
  }

  if (addedLines === 0 && removedLines === 0) {
    return { type: 'no-change', content: newContent };
  }

  // A replacement counts as both an add and a remove, so use max() to keep the
  // ratio in the 0-1 range.
  const maxLines = Math.max(oldContent.split('\n').length, newContent.split('\n').length, 1);
  const changeRatio = Math.min(Math.max(addedLines, removedLines) / maxLines, 1);

  const diffLines: string[] = [`--- ${label} (previous)`, `+++ ${label} (current)`];
  for (const hunk of patch.hunks) {
    diffLines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    diffLines.push(...hunk.lines);
  }
  const diffString = diffLines.join('\n');

  if (changeRatio >= threshold || diffString.length >= newContent.length) {
    return { type: 'full', content: newContent };
  }

  return { type: 'diff', content: diffString };
}

/**
 * Return lines matching `search` (string or regex), each with `contextLines` of
 * surrounding context; non-contiguous sections are separated by `---`.
 * At most 10 matching lines are considered.
 */
export function searchLinesWithContext(
  content: string,
  search: string | RegExp,
  options?: { contextLines?: number; caseInsensitive?: boolean },
): string {
  const contextLines = options?.contextLines ?? 5;
  const lines = content.split('\n');
  const matchIndices: number[] = [];
  const isRegExp = typeof search === 'object' && search !== null && typeof (search as RegExp).test === 'function';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isMatch = isRegExp
      ? (search as RegExp).test(line)
      : options?.caseInsensitive
        ? line.toLowerCase().includes((search as string).toLowerCase())
        : line.includes(search as string);
    if (isMatch) {
      matchIndices.push(i);
      if (matchIndices.length >= 10) break;
    }
  }

  if (matchIndices.length === 0) return 'No matches found';

  const includedLines = new Set<number>();
  for (const idx of matchIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(lines.length - 1, idx + contextLines);
    for (let i = start; i <= end; i++) includedLines.add(i);
  }

  const sortedIndices = [...includedLines].sort((a, b) => a - b);
  const result: string[] = [];
  for (let i = 0; i < sortedIndices.length; i++) {
    const lineIdx = sortedIndices[i];
    if (i > 0 && sortedIndices[i - 1] !== lineIdx - 1) result.push('---');
    result.push(lines[lineIdx]);
  }
  return result.join('\n');
}
