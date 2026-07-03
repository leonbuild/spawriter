// Ported from playwriter (MIT) src/page-markdown.ts. Injects Mozilla
// Readability (pre-bundled into dist/assets/readability.js) and extracts the
// main article content, like Firefox Reader View.
import { getClientBundle } from './client-bundles.js';
import { createSmartDiff, searchLinesWithContext } from './smart-diff.js';

export interface PageMarkdownResult {
  content: string;
  title: string | null;
  author: string | null;
  excerpt: string | null;
  siteName: string | null;
  lang: string | null;
  publishedTime: string | null;
  wordCount: number;
  _notReadable?: boolean;
}

export interface GetPageMarkdownOptions {
  /** String or regex to filter content (returns matching lines with context). */
  search?: string | RegExp;
  /** Return diff since last call. Defaults to true unless search is given. */
  showDiffSinceLastCall?: boolean;
}

const EXTRACT_EXPRESSION = `(() => {
  const readability = globalThis.__readability;
  if (!readability) throw new Error('Readability not loaded');
  const fallback = (notReadable) => ({
    content: document.body ? document.body.innerText : '',
    title: document.title || null,
    author: null,
    excerpt: null,
    siteName: null,
    lang: document.documentElement ? (document.documentElement.lang || null) : null,
    publishedTime: null,
    wordCount: (document.body ? document.body.innerText : '').split(/\\s+/).filter(Boolean).length,
    _notReadable: notReadable,
  });
  const documentClone = document.cloneNode(true);
  if (!readability.isProbablyReaderable(documentClone)) return JSON.stringify(fallback(true));
  const article = new readability.Readability(documentClone).parse();
  if (!article) return JSON.stringify(fallback(true));
  const content = article.textContent || '';
  return JSON.stringify({
    content,
    title: article.title || null,
    author: article.byline || null,
    excerpt: article.excerpt || null,
    siteName: article.siteName || null,
    lang: article.lang || null,
    publishedTime: article.publishedTime || null,
    wordCount: content.split(/\\s+/).filter(Boolean).length,
  });
})()`;

// spawriter's extension prefixes document.title with a tab-status dot
// (🟢 claimed / 🔵 idle, legacy 🟡/🔴); Readability picks it up. Strip it
// defensively so extracted titles stay clean.
const TAB_STATUS_MARKER_RE = /^(?:\s*(?:\u{1F7E2}|\u{1F535}|\u{1F7E1}|\u{1F534})\s*)+/u;

export function formatMarkdownResult(result: PageMarkdownResult): string {
  const lines: string[] = [];
  const title = result.title?.replace(TAB_STATUS_MARKER_RE, '');
  if (title) {
    lines.push(`# ${title}`, '');
  }
  const metadata: string[] = [];
  if (result.author) metadata.push(`Author: ${result.author}`);
  if (result.siteName) metadata.push(`Site: ${result.siteName}`);
  if (result.publishedTime) metadata.push(`Published: ${result.publishedTime}`);
  if (metadata.length > 0) {
    lines.push(metadata.join(' | '), '');
  }
  if (result.excerpt && result.excerpt !== result.content.slice(0, result.excerpt.length)) {
    lines.push(`> ${result.excerpt}`, '');
  }
  lines.push(result.content);
  let markdown = lines.join('\n').trim();
  markdown = (markdown as string & { toWellFormed?: () => string }).toWellFormed?.() ?? markdown;
  return markdown;
}

/**
 * Extract the page's main content as readable text with title/author/site
 * metadata, dramatically cheaper in tokens than raw HTML or innerText. Falls
 * back to body.innerText for non-article pages.
 */
export async function getPageMarkdown(
  evaluateJs: (expression: string) => Promise<unknown>,
  snapshots: Map<string, string>,
  options?: GetPageMarkdownOptions,
  scope = '',
): Promise<string> {
  const { search, showDiffSinceLastCall = !search } = options ?? {};

  const hasReadability = await evaluateJs('!!globalThis.__readability');
  if (!hasReadability) {
    await evaluateJs(getClientBundle('readability'));
  }

  const raw = await evaluateJs(EXTRACT_EXPRESSION);
  const result = (typeof raw === 'string' ? JSON.parse(raw) : raw) as PageMarkdownResult;
  const markdown = formatMarkdownResult(result);

  // Scope keys per page/target so a tab switch never diffs across pages
  // (upstream keys snapshots by WeakMap<Page> for the same reason).
  const snapshotKey = `${scope}:markdown`;
  const previous = snapshots.get(snapshotKey);
  snapshots.set(snapshotKey, markdown);

  if (showDiffSinceLastCall && previous !== undefined) {
    const diffResult = createSmartDiff({ oldContent: previous, newContent: markdown, label: 'content' });
    if (diffResult.type === 'no-change') {
      return 'No changes since last call. Use showDiffSinceLastCall: false to see full content.';
    }
    return diffResult.content;
  }

  if (search) return searchLinesWithContext(markdown, search, { caseInsensitive: true });
  return markdown;
}
