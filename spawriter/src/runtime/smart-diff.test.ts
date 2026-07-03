import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSmartDiff, searchLinesWithContext } from './smart-diff.js';

describe('createSmartDiff', () => {
  it('returns no-change for identical content', () => {
    const result = createSmartDiff({ oldContent: 'a\nb\nc', newContent: 'a\nb\nc' });
    assert.equal(result.type, 'no-change');
    assert.equal(result.content, 'a\nb\nc');
  });

  it('returns a unified diff for small changes', () => {
    const oldContent = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const newContent = oldContent.replace('line 20', 'line twenty');
    const result = createSmartDiff({ oldContent, newContent, label: 'html' });
    assert.equal(result.type, 'diff');
    assert.ok(result.content.includes('--- html (previous)'));
    assert.ok(result.content.includes('-line 20'));
    assert.ok(result.content.includes('+line twenty'));
    assert.ok(result.content.includes('@@'));
  });

  it('returns full content when more than half the lines changed', () => {
    const oldContent = 'a\nb\nc\nd';
    const newContent = 'w\nx\ny\nz';
    const result = createSmartDiff({ oldContent, newContent });
    assert.equal(result.type, 'full');
    assert.equal(result.content, newContent);
  });

  it('returns full content when the diff would be longer than the content', () => {
    const result = createSmartDiff({ oldContent: 'a', newContent: 'b' });
    assert.equal(result.type, 'full');
    assert.equal(result.content, 'b');
  });

  it('respects a custom threshold', () => {
    const oldContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const changed = oldContent.split('\n');
    for (let i = 0; i < 20; i++) changed[i] = `changed ${i}`;
    const strict = createSmartDiff({ oldContent, newContent: changed.join('\n'), threshold: 0.1 });
    assert.equal(strict.type, 'full');
    const lax = createSmartDiff({ oldContent, newContent: changed.join('\n'), threshold: 0.5 });
    assert.equal(lax.type, 'diff');
  });
});

describe('searchLinesWithContext', () => {
  const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');

  it('returns matching lines with surrounding context', () => {
    const result = searchLinesWithContext(content, 'line 15');
    assert.ok(result.includes('line 10'));
    assert.ok(result.includes('line 15'));
    assert.ok(result.includes('line 20'));
    assert.ok(!result.includes('line 9\n'));
  });

  it('separates non-contiguous sections with ---', () => {
    const result = searchLinesWithContext(content, /^line (2|25)$/);
    assert.ok(result.includes('---'));
  });

  it('returns "No matches found" for a miss', () => {
    assert.equal(searchLinesWithContext(content, 'nope'), 'No matches found');
  });

  it('supports case-insensitive string search', () => {
    assert.ok(searchLinesWithContext(content, 'LINE 15', { caseInsensitive: true }).includes('line 15'));
    assert.equal(searchLinesWithContext(content, 'LINE 15'), 'No matches found');
  });

  it('caps at 10 matching lines', () => {
    const many = Array.from({ length: 100 }, (_, i) => `match ${i}`).join('\n');
    const result = searchLinesWithContext(many, 'match', { contextLines: 0 });
    assert.equal(result.split('\n').filter((l) => l.startsWith('match')).length, 10);
  });
});
