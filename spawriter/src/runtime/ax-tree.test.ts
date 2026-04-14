/**
 * Tests for runtime/ax-tree.ts — accessibility tree formatting utilities.
 * Imports directly from production code.
 *
 * Run: npx tsx --test spawriter/src/runtime/ax-tree.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type AXNode,
  type RefInfo,
  type LabeledElement,
  stripRefPrefixes,
  getInteractiveElements,
  formatAXTreeAsText,
  computeSnapshotDiff,
  searchSnapshot,
  formatInteractiveSnapshot,
  buildLabelInjectionScript,
  REMOVE_LABELS_SCRIPT,
  formatLabelLegend,
} from './ax-tree.js';

// ---------------------------------------------------------------------------
// stripRefPrefixes
// ---------------------------------------------------------------------------
describe('stripRefPrefixes', () => {
  it('removes @N prefixes from lines', () => {
    assert.equal(stripRefPrefixes('@1 button "OK"'), 'button "OK"');
    assert.equal(stripRefPrefixes('  @12 link "Go"'), '  link "Go"');
  });

  it('preserves lines without ref prefixes', () => {
    assert.equal(stripRefPrefixes('heading "Title"'), 'heading "Title"');
  });

  it('handles multiline input', () => {
    const input = '@1 button "A"\n  @2 link "B"\ntext "C"';
    const expected = 'button "A"\n  link "B"\ntext "C"';
    assert.equal(stripRefPrefixes(input), expected);
  });

  it('handles empty string', () => {
    assert.equal(stripRefPrefixes(''), '');
  });
});

// ---------------------------------------------------------------------------
// getInteractiveElements
// ---------------------------------------------------------------------------
describe('getInteractiveElements', () => {
  it('returns only interactive role nodes', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'string', value: 'OK' }, backendDOMNodeId: 10 },
      { nodeId: '2', role: { type: 'role', value: 'heading' }, name: { type: 'string', value: 'Title' }, backendDOMNodeId: 20 },
      { nodeId: '3', role: { type: 'role', value: 'link' }, name: { type: 'string', value: 'Home' }, backendDOMNodeId: 30 },
    ];
    const result = getInteractiveElements(nodes);
    assert.equal(result.length, 2);
    assert.equal(result[0].role, 'button');
    assert.equal(result[1].role, 'link');
  });

  it('assigns sequential indices', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'textbox' }, name: { type: 'string', value: 'Name' }, backendDOMNodeId: 10 },
      { nodeId: '2', role: { type: 'role', value: 'checkbox' }, name: { type: 'string', value: 'Agree' }, backendDOMNodeId: 20 },
    ];
    const result = getInteractiveElements(nodes);
    assert.equal(result[0].index, 1);
    assert.equal(result[1].index, 2);
  });

  it('skips ignored nodes', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'string', value: 'OK' }, backendDOMNodeId: 10, ignored: true },
    ];
    assert.equal(getInteractiveElements(nodes).length, 0);
  });

  it('skips nodes without backendDOMNodeId', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'string', value: 'OK' } },
    ];
    assert.equal(getInteractiveElements(nodes).length, 0);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(getInteractiveElements([]), []);
  });

  it('uses empty string for missing name', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'button' }, backendDOMNodeId: 10 },
    ];
    assert.equal(getInteractiveElements(nodes)[0].name, '');
  });
});

// ---------------------------------------------------------------------------
// formatAXTreeAsText
// ---------------------------------------------------------------------------
describe('formatAXTreeAsText', () => {
  it('formats a simple tree', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'heading' }, name: { type: 'string', value: 'Hello' } },
    ];
    const result = formatAXTreeAsText(nodes);
    assert.ok(result.includes('WebArea'));
    assert.ok(result.includes('heading "Hello"'));
  });

  it('assigns ref numbers when assignRefs is true', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', role: { type: 'role', value: 'button' }, name: { type: 'string', value: 'OK' }, backendDOMNodeId: 10 },
    ];
    const refCache = new Map<number, RefInfo>();
    const result = formatAXTreeAsText(nodes, true, refCache);
    assert.ok(result.includes('@1 button "OK"'));
    assert.equal(refCache.size, 1);
    assert.equal(refCache.get(1)!.role, 'button');
  });

  it('returns empty tree message for empty input', () => {
    assert.equal(formatAXTreeAsText([]), '(empty accessibility tree)');
  });

  it('skips ignored nodes but renders their children', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'WebArea' }, childIds: ['2'] },
      { nodeId: '2', parentId: '1', ignored: true, childIds: ['3'] },
      { nodeId: '3', parentId: '2', role: { type: 'role', value: 'button' }, name: { type: 'string', value: 'Go' }, backendDOMNodeId: 5 },
    ];
    const result = formatAXTreeAsText(nodes);
    assert.ok(result.includes('button "Go"'));
  });

  it('formats properties correctly', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'checkbox' }, name: { type: 'string', value: 'Accept' },
        properties: [
          { name: 'checked', value: { type: 'tristate', value: 'true' } },
          { name: 'focusable', value: { type: 'boolean', value: true } },
        ],
      },
    ];
    const result = formatAXTreeAsText(nodes);
    assert.ok(result.includes('[checked=true]'));
    assert.ok(!result.includes('focusable'));
  });

  it('clears ref cache on each call when assignRefs is true', () => {
    const nodes: AXNode[] = [
      { nodeId: '1', role: { type: 'role', value: 'button' }, name: { type: 'string', value: 'A' }, backendDOMNodeId: 10 },
    ];
    const cache = new Map<number, RefInfo>();
    formatAXTreeAsText(nodes, true, cache);
    assert.equal(cache.size, 1);
    formatAXTreeAsText(nodes, true, cache);
    assert.equal(cache.size, 1);
  });
});

// ---------------------------------------------------------------------------
// computeSnapshotDiff
// ---------------------------------------------------------------------------
describe('computeSnapshotDiff', () => {
  it('detects no changes', () => {
    assert.ok(computeSnapshotDiff('button "A"', 'button "A"').includes('No changes'));
  });

  it('detects added lines', () => {
    const diff = computeSnapshotDiff('button "A"', 'button "A"\nlink "B"');
    assert.ok(diff.includes('Added (1)'));
    assert.ok(diff.includes('+ link "B"'));
  });

  it('detects removed lines', () => {
    const diff = computeSnapshotDiff('button "A"\nlink "B"', 'button "A"');
    assert.ok(diff.includes('Removed (1)'));
    assert.ok(diff.includes('- link "B"'));
  });

  it('detects both added and removed', () => {
    const diff = computeSnapshotDiff('button "A"', 'link "B"');
    assert.ok(diff.includes('Removed'));
    assert.ok(diff.includes('Added'));
  });

  it('strips ref prefixes before diffing', () => {
    const diff = computeSnapshotDiff('@1 button "A"', '@2 button "A"');
    assert.ok(diff.includes('No changes'));
  });
});

// ---------------------------------------------------------------------------
// searchSnapshot
// ---------------------------------------------------------------------------
describe('searchSnapshot', () => {
  it('finds matching lines', () => {
    const snapshot = 'heading "Title"\nbutton "Submit"\nlink "Home"';
    const result = searchSnapshot(snapshot, 'button');
    assert.ok(result.includes('>>> button "Submit"'));
    assert.ok(result.includes('1 matches'));
  });

  it('is case-insensitive', () => {
    const result = searchSnapshot('Button "OK"', 'button');
    assert.ok(result.includes('>>> Button "OK"'));
  });

  it('returns no matches message', () => {
    const result = searchSnapshot('heading "Title"', 'nonexistent');
    assert.equal(result, 'No matches found');
  });

  it('includes context lines', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const result = searchSnapshot(lines.join('\n'), 'line10');
    assert.ok(result.includes('line10'));
    assert.ok(result.includes('line7') || result.includes('line8'));
  });

  it('limits to 20 matches', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `match${i}`);
    const result = searchSnapshot(lines.join('\n'), 'match');
    assert.ok(result.includes('20 matches'));
  });

  it('separates non-contiguous regions', () => {
    const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p'];
    const result = searchSnapshot(lines.join('\n'), 'a');
    assert.ok(result.includes('1 matches'));
  });
});

// ---------------------------------------------------------------------------
// formatInteractiveSnapshot
// ---------------------------------------------------------------------------
describe('formatInteractiveSnapshot', () => {
  it('formats elements with refs', () => {
    const elements: LabeledElement[] = [
      { index: 1, role: 'button', name: 'OK', backendDOMNodeId: 10 },
      { index: 2, role: 'link', name: '', backendDOMNodeId: 20 },
    ];
    const result = formatInteractiveSnapshot(elements);
    assert.ok(result.includes('@1 [button] "OK"'));
    assert.ok(result.includes('@2 [link]'));
    assert.ok(result.includes('Interactive elements (2)'));
  });

  it('returns message for empty elements', () => {
    assert.ok(formatInteractiveSnapshot([]).includes('No interactive elements'));
  });
});

// ---------------------------------------------------------------------------
// buildLabelInjectionScript
// ---------------------------------------------------------------------------
describe('buildLabelInjectionScript', () => {
  it('creates script with container div', () => {
    const script = buildLabelInjectionScript([]);
    assert.ok(script.includes('__spawriter_labels__'));
    assert.ok(script.includes('z-index:2147483647'));
  });

  it('creates label elements for each input', () => {
    const labels = [
      { index: 1, x: 10, y: 20, width: 100, height: 50 },
      { index: 2, x: 30, y: 40, width: 80, height: 30 },
    ];
    const script = buildLabelInjectionScript(labels);
    assert.ok(script.includes("textContent='1'"));
    assert.ok(script.includes("textContent='2'"));
    assert.ok(script.includes('left:10px'));
    assert.ok(script.includes('left:30px'));
  });

  it('enforces minimum dimensions', () => {
    const labels = [{ index: 1, x: 0, y: 0, width: 5, height: 3 }];
    const script = buildLabelInjectionScript(labels);
    assert.ok(script.includes('width:14px'));
    assert.ok(script.includes('height:14px'));
  });
});

// ---------------------------------------------------------------------------
// REMOVE_LABELS_SCRIPT
// ---------------------------------------------------------------------------
describe('REMOVE_LABELS_SCRIPT', () => {
  it('references the correct container id', () => {
    assert.ok(REMOVE_LABELS_SCRIPT.includes('__spawriter_labels__'));
  });

  it('calls remove on the element', () => {
    assert.ok(REMOVE_LABELS_SCRIPT.includes('.remove()'));
  });
});

// ---------------------------------------------------------------------------
// formatLabelLegend
// ---------------------------------------------------------------------------
describe('formatLabelLegend', () => {
  it('formats legend with numbered entries', () => {
    const elements: LabeledElement[] = [
      { index: 1, role: 'button', name: 'OK', backendDOMNodeId: 10 },
      { index: 2, role: 'link', name: 'Home', backendDOMNodeId: 20 },
    ];
    const result = formatLabelLegend(elements);
    assert.ok(result.includes('[1] button "OK"'));
    assert.ok(result.includes('[2] link "Home"'));
    assert.ok(result.includes('Interactive elements (2)'));
  });

  it('handles element without name', () => {
    const elements: LabeledElement[] = [
      { index: 1, role: 'button', name: '', backendDOMNodeId: 10 },
    ];
    const result = formatLabelLegend(elements);
    assert.ok(result.includes('[1] button'));
    assert.ok(!result.includes('""'));
  });

  it('returns message for empty elements', () => {
    assert.ok(formatLabelLegend([]).includes('No interactive elements'));
  });
});
