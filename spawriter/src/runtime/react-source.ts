// Ported from playwriter (MIT) src/react-source.ts, adapted from Locator-based
// targeting to spawriter's snapshot-@ref / CSS-selector targeting. Reads React
// fibers via bippy (pre-bundled into dist/assets/bippy.js) to map a DOM
// element back to its component name, source file:line and props.
import { getClientBundle } from './client-bundles.js';

export interface ReactSourceLocation {
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  componentName: string | null;
}

export type ReactSerializedProp =
  | string
  | number
  | boolean
  | null
  | ReactSerializedProp[]
  | { [key: string]: ReactSerializedProp };

export interface ReactComponentHierarchyItem {
  componentName: string | null;
  source: Omit<ReactSourceLocation, 'componentName'> | null;
  props: ReactSerializedProp;
}

export interface ReactComponentInfo {
  componentName: string | null;
  source: Omit<ReactSourceLocation, 'componentName'> | null;
  hierarchy: ReactComponentHierarchyItem[];
  props: ReactSerializedProp;
}

/** Element target: a snapshot @ref number or a CSS selector. */
export type ReactElementTarget = number | string;

export type CdpSender = (method: string, params?: Record<string, unknown>, timeout?: number) => Promise<unknown>;
export type RefToBackendNodeId = (ref: number) => number | undefined;

// Runs inside the page with `el` bound to the inspected element. Self-contained:
// serialized with String() and injected via Runtime.callFunctionOn.
async function pageGetReactSource(el: unknown): Promise<Record<string, unknown>> {
  const bippy = (globalThis as any).__bippy;
  if (!bippy) throw new Error('bippy not loaded');

  // bippy.normalizeFileName strips "/app-pages-browser/" but not the
  // parenthesized "(app-pages-browser)" form Next.js webpack actually uses;
  // strip all webpack layer prefixes like (ssr), (rsc), etc.
  const cleanName = (name: string): string => {
    let f = bippy.normalizeFileName(name);
    f = f.replace(/^\/?\([-\w]+\)\//, '');
    f = f.replace(/^\.\//, '');
    return f;
  };

  const fiber = bippy.getFiberFromHostInstance(el);
  if (!fiber) return { _notFound: 'fiber' };

  const source = await bippy.getSource(fiber);
  if (source) {
    return {
      fileName: source.fileName ? cleanName(source.fileName) : null,
      lineNumber: source.lineNumber ?? null,
      columnNumber: source.columnNumber ?? null,
      componentName: source.functionName ?? bippy.getDisplayName(fiber.type) ?? null,
    };
  }

  const ownerStack = await bippy.getOwnerStack(fiber);
  for (const frame of ownerStack) {
    if (frame.fileName && bippy.isSourceFile(frame.fileName)) {
      return {
        fileName: cleanName(frame.fileName),
        lineNumber: frame.lineNumber ?? null,
        columnNumber: frame.columnNumber ?? null,
        componentName: frame.functionName ?? null,
      };
    }
  }
  return { _notFound: 'source' };
}

// Runs inside the page with `el` bound to the inspected element.
async function pageGetReactComponentInfo(el: unknown): Promise<Record<string, unknown> | null> {
  const bippy = (globalThis as any).__bippy;
  if (!bippy) throw new Error('bippy not loaded');

  const cleanName = (name: string): string => {
    let f = bippy.normalizeFileName(name);
    f = f.replace(/^\/?\([-\w]+\)\//, '');
    f = f.replace(/^\.\//, '');
    return f;
  };

  const serializeReactValue = (value: any, options: { depth: number; seen: WeakSet<object> }): any => {
    if (value === null) return null;
    if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…[truncated]` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'undefined') return '[undefined]';
    if (typeof value === 'function') return '[function]';
    if (typeof value === 'symbol') return '[symbol]';
    if (typeof value === 'bigint') return `${value.toString()}n`;
    if (typeof value !== 'object') return `[${typeof value}]`;
    const objectTag = Object.prototype.toString.call(value);
    if (objectTag.includes('Element]') || objectTag === '[object Window]' || objectTag === '[object Document]') {
      return '[dom-node]';
    }
    if (options.seen.has(value)) return '[circular]';
    if (options.depth >= 3) return '[max-depth]';
    options.seen.add(value);
    if (Array.isArray(value)) {
      const items = value.slice(0, 20).map((item) => serializeReactValue(item, { depth: options.depth + 1, seen: options.seen }));
      if (value.length > 20) items.push(`…[${value.length - 20} more]`);
      options.seen.delete(value);
      return items;
    }
    const entries = Object.entries(value).slice(0, 20);
    const result: Record<string, any> = {};
    for (const [key, childValue] of entries) {
      result[key] = serializeReactValue(childValue, { depth: options.depth + 1, seen: options.seen });
    }
    const totalKeys = Object.keys(value).length;
    if (totalKeys > 20) result['…'] = `[${totalKeys - 20} more keys]`;
    options.seen.delete(value);
    return result;
  };

  const getSourceForFiber = async (fiber: any): Promise<Record<string, unknown> | null> => {
    try {
      const source = await bippy.getSource(fiber);
      if (source?.fileName) {
        return {
          fileName: cleanName(source.fileName),
          lineNumber: source.lineNumber ?? null,
          columnNumber: source.columnNumber ?? null,
        };
      }
      const ownerStack = await bippy.getOwnerStack(fiber);
      const frame = ownerStack.find((f: any) => (f.fileName ? bippy.isSourceFile(f.fileName) : false));
      if (frame?.fileName) {
        return {
          fileName: cleanName(frame.fileName),
          lineNumber: frame.lineNumber ?? null,
          columnNumber: frame.columnNumber ?? null,
        };
      }
    } catch {
      return null;
    }
    return null;
  };

  let fiber: any = null;
  try {
    fiber = bippy.getFiberFromHostInstance(el);
  } catch {
    return null;
  }
  if (!fiber) return null;

  const componentFibers: any[] = [];
  let current: any = fiber;
  while (current && componentFibers.length < 20) {
    try {
      if (bippy.isCompositeFiber(current)) componentFibers.push(current);
    } catch {
      // Ignore malformed fibers and keep walking upward.
    }
    current = current.return;
  }
  if (componentFibers.length === 0) return null;

  const hierarchy: Record<string, unknown>[] = [];
  for (const componentFiber of componentFibers) {
    let componentName: string | null = null;
    try {
      componentName = componentFiber.type ? bippy.getDisplayName(componentFiber.type) : null;
    } catch {
      componentName = null;
    }
    hierarchy.push({
      componentName,
      source: await getSourceForFiber(componentFiber),
      props: serializeReactValue(componentFiber.memoizedProps, { depth: 0, seen: new WeakSet<object>() }),
    });
  }

  const nearest = hierarchy[0];
  return {
    componentName: nearest.componentName,
    source: nearest.source,
    hierarchy,
    props: nearest.props,
  };
}

async function ensureBippy(cdp: CdpSender): Promise<void> {
  const check = (await cdp('Runtime.evaluate', {
    expression: '!!globalThis.__bippy',
    returnByValue: true,
  })) as any;
  if (check?.result?.value === true) return;
  await cdp('Runtime.evaluate', { expression: getClientBundle('bippy') });
}

/** Resolve a @ref or CSS selector to a Runtime objectId. */
export async function resolveElementObjectId(
  cdp: CdpSender,
  target: ReactElementTarget,
  refToBackendNodeId: RefToBackendNodeId,
): Promise<string> {
  if (typeof target === 'number') {
    const backendNodeId = refToBackendNodeId(target);
    if (backendNodeId === undefined) {
      throw new Error(`Unknown ref @${target}. Run snapshot() first to populate refs.`);
    }
    if (backendNodeId < 0) {
      throw new Error(`Ref @${target} has no CDP node id (snapshot ran without a CDP session). Re-run snapshot() or pass a CSS selector.`);
    }
    const resolved = (await cdp('DOM.resolveNode', { backendNodeId })) as any;
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw new Error(`Could not resolve ref @${target} to a live element (node may be gone).`);
    return objectId;
  }

  const evaluated = (await cdp('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(target)})`,
    returnByValue: false,
  })) as any;
  const objectId = evaluated?.result?.objectId;
  if (!objectId || evaluated?.result?.subtype === 'null') {
    throw new Error(`No element matches selector: ${target}`);
  }
  return objectId;
}

async function callOnElement(cdp: CdpSender, objectId: string, pageFn: (el: unknown) => Promise<unknown>): Promise<unknown> {
  const result = (await cdp('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() { return (${String(pageFn)})(this); }`,
    awaitPromise: true,
    returnByValue: true,
  })) as any;
  if (result?.exceptionDetails) {
    throw new Error(`React inspection failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  }
  return result?.result?.value;
}

/**
 * Map a DOM element (snapshot @ref or CSS selector) to the React component
 * that rendered it: component name + source file:line:column. Requires a
 * React dev build for file locations; falls back to owner-stack frames.
 */
export async function getReactSource(
  cdp: CdpSender,
  target: ReactElementTarget,
  refToBackendNodeId: RefToBackendNodeId,
): Promise<ReactSourceLocation | { error: string }> {
  await ensureBippy(cdp);
  const objectId = await resolveElementObjectId(cdp, target, refToBackendNodeId);
  const value = (await callOnElement(cdp, objectId, pageGetReactSource)) as Record<string, unknown> | null;
  if (value && value._notFound === 'fiber') {
    return { error: 'No React fiber found on this element — is this a React-rendered node?' };
  }
  if (value && value._notFound === 'source') {
    return { error: 'React fiber found but no source location — production builds strip debug source; use a dev build.' };
  }
  return value as unknown as ReactSourceLocation;
}

/**
 * Full component inspection for a DOM element: nearest component, its props
 * (safely serialized) and the composite-component hierarchy above it.
 */
export async function getReactComponentInfo(
  cdp: CdpSender,
  target: ReactElementTarget,
  refToBackendNodeId: RefToBackendNodeId,
): Promise<ReactComponentInfo | { error: string }> {
  await ensureBippy(cdp);
  const objectId = await resolveElementObjectId(cdp, target, refToBackendNodeId);
  const value = (await callOnElement(cdp, objectId, pageGetReactComponentInfo)) as ReactComponentInfo | null;
  if (!value) {
    return { error: 'No React component found for this element — is this page rendered by React?' };
  }
  return value;
}
