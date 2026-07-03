// Ported from playwriter (MIT) src/clean-html.ts + htmlrewrite.ts. The
// transformation pipeline is identical, but it runs inside the page on a
// detached DOM clone (the browser is the HTML parser) instead of pulling in
// posthtml on the Node side, so it works over both CDP paths.
import { createSmartDiff, searchLinesWithContext } from './smart-diff.js';

export interface GetCleanHTMLOptions {
  /** CSS selector of the root element. Defaults to 'body'. */
  selector?: string;
  search?: string | RegExp;
  showDiffSinceLastCall?: boolean;
  includeStyles?: boolean;
  maxAttrLen?: number;
  maxContentLen?: number;
}

interface CleanHtmlPageOptions {
  selector: string;
  keepStyles: boolean;
  maxAttrLen: number;
  maxContentLen: number;
}

// The tsconfig has no DOM lib (this package is Node-side); the function below
// executes in the browser only, so document is declared loosely here.
declare const document: any;
type DomNode = any;

// Runs inside the page. Must stay fully self-contained (no outer-scope
// references) because it is serialized with String() and injected.
function cleanHtmlPageFunction(opts: {
  selector: string;
  keepStyles: boolean;
  maxAttrLen: number;
  maxContentLen: number;
}): string {
  const TAGS_TO_REMOVE = ['hint', 'style', 'link', 'script', 'meta', 'noscript', 'svg', 'head'];
  const ATTRIBUTES_TO_KEEP = [
    'label', 'title', 'alt', 'href', 'name', 'value', 'checked', 'placeholder', 'type', 'role', 'target',
    'aria-label', 'aria-placeholder', 'aria-valuetext', 'aria-roledescription',
    'aria-hidden', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-disabled', 'aria-pressed',
    'aria-required', 'aria-current',
    'testid', 'test-id', 'tid', 'qa', 'qa-id', 'e2e', 'e2e-id', 'automation-id', 'automationid', 'selenium',
    'pw', 'vimium-label',
  ];
  if (opts.keepStyles) ATTRIBUTES_TO_KEEP.push('style', 'class');
  const ACTIONABLE_TAGS = ['button', 'a', 'input', 'select', 'textarea'];
  const MEANINGFUL_ATTRS = ['aria-label', 'title', 'alt', 'value', 'placeholder', 'href', 'name'];
  const FORM_TAGS = ['input', 'select', 'textarea'];
  const SEMANTIC_TAGS = ['html', 'body', 'main', 'header', 'footer', 'nav', 'section', 'article', 'aside'];
  const VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'];

  const truncate = (str: string, maxLen: number): string => {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + `...${str.length - maxLen} more characters`;
  };

  const root = document.querySelector(opts.selector);
  if (!root) return '(element not found)';
  const clone = root.cloneNode(true) as DomNode;

  // Pass 1: drop unwanted tags and comments, filter+truncate attributes.
  const stripPass = (el: DomNode): void => {
    for (const child of [...el.childNodes]) {
      if (child.nodeType === 8) {
        child.remove();
      } else if (child.nodeType === 1) {
        const childEl = child as DomNode;
        if (TAGS_TO_REMOVE.includes(childEl.tagName.toLowerCase())) childEl.remove();
        else stripPass(childEl);
      }
    }
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('data-') || ATTRIBUTES_TO_KEEP.includes(attr.name)) {
        const truncated = truncate(attr.value, opts.maxAttrLen);
        if (truncated !== attr.value) el.setAttribute(attr.name, truncated);
      } else {
        el.removeAttribute(attr.name);
      }
    }
  };
  stripPass(clone);

  // Pass 2: remove aria-hidden="true" subtrees (hidden from assistive tech).
  for (const el of [...clone.querySelectorAll('[aria-hidden="true"]')]) el.remove();
  if (clone.getAttribute('aria-hidden') === 'true') return '(element is aria-hidden)';

  // Pass 3: remove purely decorative images (empty or missing alt).
  for (const img of [...clone.querySelectorAll('img')]) {
    if (!img.getAttribute('alt')) img.remove();
  }

  // Pass 4: remove decorative subtrees with no text and no actionable elements.
  const hasUsefulContent = (node: DomNode): boolean => {
    if (node.nodeType === 3) return (node.textContent || '').trim().length > 0;
    if (node.nodeType !== 1) return false;
    const el = node as DomNode;
    const tag = el.tagName.toLowerCase();
    if (FORM_TAGS.includes(tag)) return true;
    if (tag === 'img' && (el.getAttribute('alt') || '').trim().length > 0) return true;
    if (ACTIONABLE_TAGS.includes(tag)) {
      for (const attr of MEANINGFUL_ATTRS) {
        if ((el.getAttribute(attr) || '').trim().length > 0) return true;
      }
    }
    for (const child of el.childNodes) {
      if (hasUsefulContent(child)) return true;
    }
    return false;
  };
  const decorativePass = (el: DomNode): void => {
    for (const child of [...el.children]) decorativePass(child);
    if (SEMANTIC_TAGS.includes(el.tagName.toLowerCase())) return;
    if (el !== clone && !hasUsefulContent(el)) el.remove();
  };
  decorativePass(clone);

  // Pass 5: repeatedly remove empty elements (no attrs, no non-blank content).
  let removed = true;
  while (removed) {
    removed = false;
    for (const el of [...clone.querySelectorAll('*')]) {
      const hasAttrs = el.attributes.length > 0;
      const hasContent = [...el.childNodes].some((c) =>
        c.nodeType === 3 ? (c.textContent || '').trim().length > 0 : true,
      );
      if (!hasAttrs && !hasContent) {
        el.remove();
        removed = true;
      }
    }
  }

  // Pass 6: repeatedly unwrap attribute-less wrappers with a single element child.
  let unwrapped = true;
  while (unwrapped) {
    unwrapped = false;
    for (const el of [...clone.querySelectorAll('*')]) {
      if (el.attributes.length > 0) continue;
      const meaningful = [...el.childNodes].filter(
        (c) => !(c.nodeType === 3 && (c.textContent || '').trim().length === 0),
      );
      if (meaningful.length === 1 && meaningful[0].nodeType === 1) {
        el.replaceWith(meaningful[0]);
        unwrapped = true;
      }
    }
  }

  // Serialize with 1-space indentation.
  const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttr = (s: string): string => escapeText(s).replace(/"/g, '&quot;');
  const serialize = (node: DomNode, depth: number, out: string[]): void => {
    const indent = ' '.repeat(depth);
    if (node.nodeType === 3) {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) out.push(indent + escapeText(truncate(text, opts.maxContentLen)));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as DomNode;
    const tag = el.tagName.toLowerCase();
    const attrs = [...el.attributes].map((a) => (a.value === '' ? ` ${a.name}` : ` ${a.name}="${escapeAttr(a.value)}"`)).join('');
    if (VOID_TAGS.includes(tag)) {
      out.push(`${indent}<${tag}${attrs}>`);
      return;
    }
    const children = [...el.childNodes].filter(
      (c) => c.nodeType === 1 || (c.nodeType === 3 && (c.textContent || '').trim().length > 0),
    );
    if (children.length === 0) {
      out.push(`${indent}<${tag}${attrs}></${tag}>`);
      return;
    }
    // Single short text child stays inline for readability.
    if (children.length === 1 && children[0].nodeType === 3) {
      const text = escapeText(truncate((children[0].textContent || '').replace(/\s+/g, ' ').trim(), opts.maxContentLen));
      if (indent.length + tag.length * 2 + attrs.length + text.length + 5 <= 120) {
        out.push(`${indent}<${tag}${attrs}>${text}</${tag}>`);
        return;
      }
    }
    out.push(`${indent}<${tag}${attrs}>`);
    for (const child of children) serialize(child, depth + 1, out);
    out.push(`${indent}</${tag}>`);
  };
  const out: string[] = [];
  serialize(clone, 0, out);
  return out.join('\n');
}

export function buildCleanHtmlExpression(opts: CleanHtmlPageOptions): string {
  return `(${String(cleanHtmlPageFunction)})(${JSON.stringify(opts)})`;
}

/**
 * Extract a deeply cleaned, LLM-friendly version of the page (or a subtree):
 * scripts/styles/svg removed, noise attributes stripped, decorative subtrees
 * pruned, wrappers unwrapped, long values truncated, 1-space indentation.
 */
export async function getCleanHTML(
  evaluateJs: (expression: string) => Promise<unknown>,
  snapshots: Map<string, string>,
  options?: GetCleanHTMLOptions,
  scope = '',
): Promise<string> {
  const {
    selector = 'body',
    search,
    showDiffSinceLastCall = !search,
    includeStyles = false,
    maxAttrLen = 200,
    maxContentLen = 500,
  } = options ?? {};

  const raw = await evaluateJs(
    buildCleanHtmlExpression({ selector, keepStyles: includeStyles, maxAttrLen, maxContentLen }),
  );
  let html = typeof raw === 'string' ? raw : String(raw);
  html = (html as string & { toWellFormed?: () => string }).toWellFormed?.() ?? html;

  // Scope keys per page/target so a tab switch never diffs across pages
  // (upstream keys snapshots by WeakMap<Page> for the same reason).
  const snapshotKey = `${scope}:html:${selector}`;
  const previous = snapshots.get(snapshotKey);
  snapshots.set(snapshotKey, html);

  if (showDiffSinceLastCall && previous !== undefined) {
    const diffResult = createSmartDiff({ oldContent: previous, newContent: html, label: 'html' });
    if (diffResult.type === 'no-change') {
      return 'No changes since last call. Use showDiffSinceLastCall: false to see full content.';
    }
    return diffResult.content;
  }

  if (search) return searchLinesWithContext(html, search);
  return html;
}
