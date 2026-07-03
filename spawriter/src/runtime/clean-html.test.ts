import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getCleanHTML, buildCleanHtmlExpression } from './clean-html.js';

describe('buildCleanHtmlExpression', () => {
  it('serializes to a self-contained IIFE with the options inlined', () => {
    const expr = buildCleanHtmlExpression({ selector: '#app', keepStyles: true, maxAttrLen: 50, maxContentLen: 99 });
    assert.ok(expr.includes('"selector":"#app"'));
    assert.ok(expr.includes('"keepStyles":true'));
    assert.ok(expr.includes('"maxAttrLen":50'));
    assert.ok(expr.includes('"maxContentLen":99'));
    // Must not capture outer-scope module bindings (it is injected standalone).
    assert.ok(!expr.includes('createSmartDiff'));
    assert.ok(expr.trimStart().startsWith('('));
  });
});

describe('getCleanHTML', () => {
  it('threads selector and options into the page expression and returns the HTML', async () => {
    let seenExpression = '';
    const html = await getCleanHTML(
      async (expression) => {
        seenExpression = expression;
        return '<main>\n <p>hello</p>\n</main>';
      },
      new Map(),
      { selector: '#root', includeStyles: true, maxAttrLen: 10, maxContentLen: 20, showDiffSinceLastCall: false },
    );
    assert.ok(seenExpression.includes('"selector":"#root"'));
    assert.ok(seenExpression.includes('"keepStyles":true'));
    assert.equal(html, '<main>\n <p>hello</p>\n</main>');
  });

  it('diffs against the previous call by default', async () => {
    const snapshots = new Map<string, string>();
    const long = Array.from({ length: 30 }, (_, i) => `<p>row ${i}</p>`).join('\n');
    const first = await getCleanHTML(async () => long, snapshots);
    assert.equal(first, long);
    const changed = long.replace('<p>row 7</p>', '<p>row seven</p>');
    const second = await getCleanHTML(async () => changed, snapshots);
    assert.ok(second.includes('+<p>row seven</p>'));
    assert.ok(second.includes('-<p>row 7</p>'));
  });

  it('reports no-change without repeating the content', async () => {
    const snapshots = new Map<string, string>();
    await getCleanHTML(async () => '<div>same</div>', snapshots);
    const second = await getCleanHTML(async () => '<div>same</div>', snapshots);
    assert.ok(second.includes('No changes since last call'));
  });

  it('keeps per-selector diff state separate', async () => {
    const snapshots = new Map<string, string>();
    await getCleanHTML(async () => '<div>A</div>', snapshots, { selector: '#a' });
    const other = await getCleanHTML(async () => '<div>B</div>', snapshots, { selector: '#b' });
    assert.equal(other, '<div>B</div>');
  });

  it('keeps diff state separate per page scope (tab switches never cross-diff)', async () => {
    const snapshots = new Map<string, string>();
    await getCleanHTML(async () => '<div>page one</div>', snapshots, undefined, 'tab-1');
    const onOtherTab = await getCleanHTML(async () => '<div>page two</div>', snapshots, undefined, 'tab-2');
    assert.equal(onOtherTab, '<div>page two</div>');
    const backOnFirst = await getCleanHTML(async () => '<div>page one</div>', snapshots, undefined, 'tab-1');
    assert.ok(backOnFirst.includes('No changes since last call'));
  });

  it('search disables diffing and returns matching lines with context', async () => {
    const snapshots = new Map<string, string>();
    const content = Array.from({ length: 30 }, (_, i) => `<p>row ${i}</p>`).join('\n');
    await getCleanHTML(async () => content, snapshots);
    const result = await getCleanHTML(async () => content, snapshots, { search: 'row 15' });
    assert.ok(result.includes('<p>row 15</p>'));
    assert.ok(!result.includes('No changes'));
  });
});
