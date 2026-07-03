import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPageMarkdown, formatMarkdownResult, type PageMarkdownResult } from './page-markdown.js';

function extractionResult(overrides?: Partial<PageMarkdownResult>): string {
  return JSON.stringify({
    content: 'Body of the article.',
    title: 'The Title',
    author: 'Jane Doe',
    excerpt: 'A short excerpt.',
    siteName: 'Example News',
    lang: 'en',
    publishedTime: '2026-01-01',
    wordCount: 4,
    ...overrides,
  });
}

/** Fake evaluator: reports readability as present, then serves extraction results. */
function fakeEvaluator(results: string[]): (expression: string) => Promise<unknown> {
  return async (expression: string) => {
    if (expression === '!!globalThis.__readability') return true;
    const next = results.shift();
    if (next === undefined) throw new Error('unexpected extra evaluate call');
    return next;
  };
}

describe('formatMarkdownResult', () => {
  it('renders title, metadata line, excerpt and content', () => {
    const markdown = formatMarkdownResult(JSON.parse(extractionResult()) as PageMarkdownResult);
    assert.ok(markdown.startsWith('# The Title'));
    assert.ok(markdown.includes('Author: Jane Doe | Site: Example News | Published: 2026-01-01'));
    assert.ok(markdown.includes('> A short excerpt.'));
    assert.ok(markdown.endsWith('Body of the article.'));
  });

  it('omits empty metadata', () => {
    const markdown = formatMarkdownResult(
      JSON.parse(extractionResult({ title: null, author: null, excerpt: null, siteName: null, publishedTime: null })) as PageMarkdownResult,
    );
    assert.equal(markdown, 'Body of the article.');
  });

  it('skips the excerpt when it merely repeats the content head', () => {
    const markdown = formatMarkdownResult(
      JSON.parse(extractionResult({ content: 'A short excerpt. And more.', excerpt: 'A short excerpt.' })) as PageMarkdownResult,
    );
    assert.ok(!markdown.includes('>'));
  });

  it('strips spawriter tab-status markers from the title', () => {
    for (const marked of ['\u{1F7E2} The Title', '\u{1F535}The Title', '\u{1F7E2} \u{1F535} The Title']) {
      const markdown = formatMarkdownResult(JSON.parse(extractionResult({ title: marked })) as PageMarkdownResult);
      assert.ok(markdown.startsWith('# The Title'), `expected clean title for ${JSON.stringify(marked)}`);
    }
  });

  it('drops the title line entirely when it was only a marker', () => {
    const markdown = formatMarkdownResult(JSON.parse(extractionResult({ title: '\u{1F535} ' })) as PageMarkdownResult);
    assert.ok(!markdown.includes('#'));
  });
});

describe('getPageMarkdown', () => {
  it('returns formatted markdown on first call', async () => {
    const markdown = await getPageMarkdown(fakeEvaluator([extractionResult()]), new Map());
    assert.ok(markdown.startsWith('# The Title'));
  });

  it('injects the readability bundle only when missing', async () => {
    const expressions: string[] = [];
    let injected = false;
    const markdown = await getPageMarkdown(async (expression: string) => {
      expressions.push(expression);
      if (expression === '!!globalThis.__readability') return injected;
      if (expression.includes('globalThis.__readability = ')) {
        injected = true;
        return undefined;
      }
      return extractionResult();
    }, new Map());
    assert.ok(markdown.startsWith('# The Title'));
    assert.ok(expressions.some((e) => e.includes('globalThis.__readability = ')), 'bundle should be injected');
  });

  it('diffs by default on repeat calls', async () => {
    const snapshots = new Map<string, string>();
    const first = extractionResult({ content: Array.from({ length: 30 }, (_, i) => `para ${i}`).join('\n') });
    const second = extractionResult({ content: Array.from({ length: 30 }, (_, i) => (i === 5 ? 'para five' : `para ${i}`)).join('\n') });
    await getPageMarkdown(fakeEvaluator([first]), snapshots);
    const diff = await getPageMarkdown(fakeEvaluator([second]), snapshots);
    assert.ok(diff.includes('+para five'));
    assert.ok(diff.includes('-para 5'));
  });

  it('search returns matching lines case-insensitively', async () => {
    const content = Array.from({ length: 30 }, (_, i) => `paragraph ${i}`).join('\n');
    const result = await getPageMarkdown(fakeEvaluator([extractionResult({ content, title: null, excerpt: null })]), new Map(), {
      search: 'PARAGRAPH 12',
    });
    assert.ok(result.includes('paragraph 12'));
  });

  it('keeps diff state separate per page scope (tab switches never cross-diff)', async () => {
    const snapshots = new Map<string, string>();
    await getPageMarkdown(fakeEvaluator([extractionResult({ content: 'first tab article' })]), snapshots, undefined, 'tab-1');
    const otherTab = await getPageMarkdown(
      fakeEvaluator([extractionResult({ content: 'second tab article' })]),
      snapshots,
      undefined,
      'tab-2',
    );
    assert.ok(otherTab.includes('second tab article'));
    assert.ok(!otherTab.includes('No changes'));
    const backOnFirst = await getPageMarkdown(fakeEvaluator([extractionResult({ content: 'first tab article' })]), snapshots, undefined, 'tab-1');
    assert.ok(backOnFirst.includes('No changes since last call'));
  });
});
