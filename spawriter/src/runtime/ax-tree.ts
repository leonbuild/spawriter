export interface AXNode {
  nodeId: string;
  parentId?: string;
  backendDOMNodeId?: number;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
  ignored?: boolean;
}

export interface RefInfo { backendDOMNodeId: number; role: string; name: string }

export interface LabeledElement {
  index: number;
  role: string;
  name: string;
  backendDOMNodeId: number;
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'tab', 'treeitem', 'row',
]);

export function stripRefPrefixes(text: string): string {
  return text.replace(/^(\s*)@\d+\s+/gm, '$1');
}

export function getInteractiveElements(nodes: AXNode[]): LabeledElement[] {
  const elements: LabeledElement[] = [];
  let idx = 1;
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value;
    if (!role || !INTERACTIVE_ROLES.has(role)) continue;
    if (!node.backendDOMNodeId) continue;
    elements.push({
      index: idx++,
      role,
      name: node.name?.value ?? '',
      backendDOMNodeId: node.backendDOMNodeId,
    });
  }
  return elements;
}

export function formatAXTreeAsText(
  nodes: AXNode[],
  assignRefs: boolean = false,
  refCache?: Map<number, RefInfo>,
): string {
  const cache = refCache ?? new Map<number, RefInfo>();
  if (assignRefs) cache.clear();

  const interactiveNodeIds = assignRefs ? new Set(
    getInteractiveElements(nodes).map(e => e.backendDOMNodeId)
  ) : new Set<number>();

  const nodeMap = new Map<string, AXNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
  }

  const lines: string[] = [];
  let refIdx = 1;

  function walk(nodeId: string, depth: number) {
    const node = nodeMap.get(nodeId);
    if (!node) return;
    if (node.ignored) {
      for (const childId of node.childIds ?? []) {
        walk(childId, depth);
      }
      return;
    }

    const role = node.role?.value ?? '';
    const name = node.name?.value ?? '';

    const props: string[] = [];
    for (const prop of node.properties ?? []) {
      const v = prop.value?.value;
      if (v === undefined || v === false || v === '') continue;
      if (prop.name === 'focusable') continue;
      props.push(`${prop.name}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }

    const indent = '  '.repeat(depth);
    const nameStr = name ? ` "${name}"` : '';
    const propsStr = props.length > 0 ? ` [${props.join(', ')}]` : '';

    const isInteractive = assignRefs && node.backendDOMNodeId && interactiveNodeIds.has(node.backendDOMNodeId);
    let refPrefix = '';
    if (isInteractive && node.backendDOMNodeId) {
      refPrefix = `@${refIdx} `;
      cache.set(refIdx, {
        backendDOMNodeId: node.backendDOMNodeId,
        role,
        name,
      });
      refIdx++;
    }

    if (role || name) {
      lines.push(`${indent}${refPrefix}${role}${nameStr}${propsStr}`);
    }

    for (const childId of node.childIds ?? []) {
      walk(childId, depth + 1);
    }
  }

  const rootNode = nodes.find((n) => !n.parentId);
  if (rootNode) {
    walk(rootNode.nodeId, 0);
  }

  return lines.join('\n') || '(empty accessibility tree)';
}

export function computeSnapshotDiff(oldSnap: string, newSnap: string): string {
  const oldLines = stripRefPrefixes(oldSnap).split('\n');
  const newLines = stripRefPrefixes(newSnap).split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const added = newLines.filter(l => !oldSet.has(l));
  const removed = oldLines.filter(l => !newSet.has(l));

  if (added.length === 0 && removed.length === 0) {
    return 'No changes since last snapshot.';
  }

  const parts: string[] = [];
  if (removed.length > 0) {
    parts.push(`Removed (${removed.length}):\n${removed.map(l => `- ${l}`).join('\n')}`);
  }
  if (added.length > 0) {
    parts.push(`Added (${added.length}):\n${added.map(l => `+ ${l}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

export function searchSnapshot(snapshot: string, query: string): string {
  const lines = snapshot.split('\n');
  const lowerQuery = query.toLowerCase();
  const matchIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      matchIndices.push(i);
      if (matchIndices.length >= 20) break;
    }
  }

  if (matchIndices.length === 0) return 'No matches found';

  const CONTEXT_LINES = 3;
  const included = new Set<number>();
  for (const idx of matchIndices) {
    for (let i = Math.max(0, idx - CONTEXT_LINES); i <= Math.min(lines.length - 1, idx + CONTEXT_LINES); i++) {
      included.add(i);
    }
  }

  const sorted = [...included].sort((a, b) => a - b);
  const result: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i - 1] !== sorted[i] - 1) result.push('---');
    const line = lines[sorted[i]];
    const isMatch = line.toLowerCase().includes(lowerQuery);
    result.push(isMatch ? `>>> ${line}` : `    ${line}`);
  }

  return `Search results for "${query}" (${matchIndices.length} matches):\n${result.join('\n')}`;
}

export function formatInteractiveSnapshot(elements: LabeledElement[]): string {
  if (elements.length === 0) return 'No interactive elements found.';
  const lines = elements.map(e =>
    `@${e.index} [${e.role}]${e.name ? ` "${e.name}"` : ''}`
  );
  return `Interactive elements (${elements.length}):\n${lines.join('\n')}\n\n(Note: @ref numbers are display-only in this mode. Use accessibility_snapshot without interactive_only for full tree with actionable refs.)`;
}

export function buildLabelInjectionScript(labels: Array<{ index: number; x: number; y: number; width: number; height: number }>): string {
  return `(function() {
    var container = document.createElement('div');
    container.id = '__spawriter_labels__';
    container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';
    ${labels.map(l => `
    (function(){
      var d=document.createElement('div');
      d.textContent='${l.index}';
      d.style.cssText='position:absolute;left:${l.x}px;top:${l.y}px;width:${Math.max(l.width, 14)}px;height:${Math.max(l.height, 14)}px;border:2px solid #e11d48;border-radius:3px;font-size:10px;font-weight:bold;color:#fff;background:rgba(225,29,72,0.85);display:flex;align-items:center;justify-content:center;line-height:1;pointer-events:none;';
      container.appendChild(d);
    })();`).join('')}
    document.body.appendChild(container);
  })()`;
}

export const REMOVE_LABELS_SCRIPT = `(function() {
  var el = document.getElementById('__spawriter_labels__');
  if (el) el.remove();
})()`;

export function formatLabelLegend(elements: LabeledElement[]): string {
  if (elements.length === 0) return 'No interactive elements found.';
  const lines = elements.map(e => `[${e.index}] ${e.role}${e.name ? ` "${e.name}"` : ''}`);
  return `Interactive elements (${elements.length}):\n${lines.join('\n')}`;
}
