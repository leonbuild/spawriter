import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import * as vm from 'node:vm';
import * as util from 'node:util';
import * as crypto from 'node:crypto';
import { getCdpUrl, getRelayPort, getRelayToken, log, error } from './utils.js';
import {
  type AXNode,
  type RefInfo,
  formatAXTreeAsText,
  computeSnapshotDiff,
  searchSnapshot,
  getInteractiveElements,
  formatInteractiveSnapshot,
  buildLabelInjectionScript,
  REMOVE_LABELS_SCRIPT,
  formatLabelLegend,
  stripRefPrefixes,
} from './runtime/ax-tree.js';
import {
  resolveImageProfile,
  captureWithSizeGuarantee,
  type CdpSender,
} from './runtime/labeled-screenshot.js';
import {
  buildDashboardStateCode,
  buildOverrideCode,
  buildAppActionCode,
  detectOverrideChanges,
  importPageOverrides,
  type OverrideState,
} from './runtime/spa-helpers.js';
import {
  NetworkMonitor,
  formatConsoleLogs as fmtConsole,
  formatNetworkEntries as fmtNetwork,
} from './runtime/network-monitor.js';
import { ScopedFS } from './runtime/scoped-fs.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Allowed modules for sandboxed require (matches upstream playwriter)
// ---------------------------------------------------------------------------

export const ALLOWED_MODULES = new Set([
  'path', 'node:path', 'url', 'node:url', 'querystring', 'node:querystring',
  'punycode', 'node:punycode', 'crypto', 'node:crypto', 'buffer', 'node:buffer',
  'string_decoder', 'node:string_decoder', 'util', 'node:util', 'assert', 'node:assert',
  'events', 'node:events', 'timers', 'node:timers', 'stream', 'node:stream',
  'zlib', 'node:zlib', 'http', 'node:http', 'https', 'node:https',
  'http2', 'node:http2', 'os', 'node:os', 'fs', 'node:fs',
]);

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export class CodeExecutionTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Code execution timed out after ${timeout}ms`);
    this.name = 'CodeExecutionTimeoutError';
  }
}

export interface ExecuteScreenshot {
  path: string;
  base64: string;
  mimeType: 'image/png' | 'image/webp' | 'image/jpeg';
  snapshot: string;
  labelCount: number;
}

export interface ExecuteResult {
  text: string;
  isError: boolean;
  images: Array<{ data: string; mimeType: string }>;
  screenshots: ExecuteScreenshot[];
}

export interface StructuredError {
  error: string;
  hint?: string;
  recovery?: string;
}

export function formatError(err: StructuredError): string {
  const parts = [`Error: ${err.error}`];
  if (err.hint) parts.push(`Hint: ${err.hint}`);
  if (err.recovery) parts.push(`Recovery: call "${err.recovery}" tool`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Auto-return detection
// ---------------------------------------------------------------------------

export function isPlaywrightChannelOwner(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as any)._type === 'string' &&
    typeof (value as any)._guid === 'string'
  );
}

export function getAutoReturnExpression(code: string): string | null {
  const trimmed = code.replace(/;+\s*$/, '').trim();
  if (!trimmed) return null;
  if (/^\s*(const|let|var|function|class|if|for|while|do|switch|try|throw|import|export)\b/.test(trimmed)) return null;
  if (/^\s*return\b/.test(trimmed)) return null;
  const lines = trimmed.split('\n');
  if (lines.length > 1) {
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped.endsWith(';') || stripped.endsWith('{') || stripped.endsWith('}')) return null;
    }
  }
  try {
    new Function(`return async function() { return (${trimmed}) }`);
    return trimmed;
  } catch {
    return null;
  }
}

export function wrapCode(code: string): string {
  const expr = getAutoReturnExpression(code);
  if (expr !== null) return `(async () => { return await (${expr}) })()`;
  return `(async () => { ${code} })()`;
}

// ---------------------------------------------------------------------------
// Useful globals injected into VM sandbox
// ---------------------------------------------------------------------------

const usefulGlobals = {
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  URL,
  URLSearchParams,
  fetch,
  Buffer,
  TextEncoder,
  TextDecoder,
  AbortController,
  AbortSignal,
  structuredClone,
  crypto,
} as const;

// ---------------------------------------------------------------------------
// Timeout utility
// ---------------------------------------------------------------------------

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`"${label}" timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// CDP command timeout config
// ---------------------------------------------------------------------------

const SLOW_CDP_COMMANDS = new Set([
  'Accessibility.getFullAXTree',
  'Page.captureScreenshot',
  'Page.reload',
  'Page.navigate',
]);

function getCommandTimeout(method: string): number {
  return SLOW_CDP_COMMANDS.has(method) ? 60000 : 30000;
}

// ---------------------------------------------------------------------------
// Tab title prefix (used by MCP for lease state indicator)
// ---------------------------------------------------------------------------

const TITLE_PREFIX_RE = /^(?:🟢 |🟡 |🔴 |🔵 )+/;

export function buildSetTabTitlePrefixCode(prefix: string | null): string {
  const reSrc = '^(?:🟢 |🟡 |🔴 |🔵 )+';
  return prefix
    ? `(() => { document.title = ${JSON.stringify(prefix)} + document.title.replace(new RegExp(${JSON.stringify(reSrc)}), ''); })()`
    : `(() => { document.title = document.title.replace(new RegExp(${JSON.stringify(reSrc)}), ''); })()`;
}

export { TITLE_PREFIX_RE };

// ---------------------------------------------------------------------------
// Dynamic class regex for filtering CSS classes
// ---------------------------------------------------------------------------

export const DYNAMIC_CLASS_RE = /^(?:css|sc|emotion|styled|jss|makeStyles)-[a-zA-Z0-9_-]+$|^[a-z]{5,8}$/;

// ---------------------------------------------------------------------------
// Debugger state management
// ---------------------------------------------------------------------------

interface DebuggerState {
  enabled: boolean;
  paused: boolean;
  currentCallFrameId: string | null;
  breakpoints: Map<string, { id: string; file: string; line: number }>;
  knownScripts: Map<string, { scriptId: string; url: string }>;
}

function createDebuggerState(): DebuggerState {
  return {
    enabled: false,
    paused: false,
    currentCallFrameId: null,
    breakpoints: new Map(),
    knownScripts: new Map(),
  };
}

// ---------------------------------------------------------------------------
// PlaywrightExecutor — the shared execution engine
// ---------------------------------------------------------------------------

export interface ExecutorLogger {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export type RelayCdpSender = (method: string, params?: Record<string, unknown>, timeout?: number) => Promise<unknown>;

export class PlaywrightExecutor {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private userState: Record<string, unknown> = {};
  private isConnected = false;
  private activeAbortController: AbortController | null = null;
  private customGlobals: Record<string, unknown> = {};
  private pagesWithListeners = new WeakSet<Page>();

  private networkMonitor = new NetworkMonitor();
  private debugger: DebuggerState = createDebuggerState();
  private lastSnapshot: string | null = null;
  private refCacheByTab: Map<string, Map<number, RefInfo>> = new Map();
  private savedOverrides: OverrideState = {};

  private logger: ExecutorLogger;
  relaySendCdp: RelayCdpSender | null = null;
  private scopedFs: ScopedFS;
  private sandboxedRequire: NodeRequire;
  private warningEvents: Array<{ id: number; message: string }> = [];
  private nextWarningEventId = 0;

  constructor(logger?: ExecutorLogger, cwd?: string) {
    this.logger = logger || { log, error };
    const sessionCwd = cwd ? path.resolve(cwd) : null;
    this.scopedFs = new ScopedFS(
      sessionCwd ? [sessionCwd, '/tmp', os.tmpdir()] : undefined,
      sessionCwd || undefined,
    );
    this.sandboxedRequire = this.createSandboxedRequire();
  }

  private createSandboxedRequire(): NodeRequire {
    const scopedFs = this.scopedFs;
    const nodeRequire = createRequire(import.meta.url);
    const sandboxedRequire = ((id: string) => {
      if (!ALLOWED_MODULES.has(id)) {
        const error = new Error(
          `Module "${id}" is not allowed in the sandbox. ` +
          `Only safe Node.js built-ins are permitted: ${[...ALLOWED_MODULES].filter((m) => !m.startsWith('node:')).join(', ')}`,
        );
        error.name = 'ModuleNotAllowedError';
        throw error;
      }
      if (id === 'fs' || id === 'node:fs') return scopedFs;
      return nodeRequire(id);
    }) as NodeRequire;
    sandboxedRequire.resolve = nodeRequire.resolve;
    sandboxedRequire.cache = nodeRequire.cache;
    sandboxedRequire.extensions = nodeRequire.extensions;
    sandboxedRequire.main = nodeRequire.main;
    return sandboxedRequire;
  }

  private enqueueWarning(message: string): void {
    this.nextWarningEventId += 1;
    this.warningEvents.push({ id: this.nextWarningEventId, message });
  }

  private beginWarningScope(): { cursor: number } {
    return { cursor: this.warningEvents.length };
  }

  private flushWarningsForScope(scope: { cursor: number }): string[] {
    const warnings = this.warningEvents.slice(scope.cursor).map(w => w.message);
    this.warningEvents.splice(scope.cursor);
    return warnings;
  }

  setGlobals(globals: Record<string, unknown>): void {
    this.customGlobals = { ...this.customGlobals, ...globals };
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  async ensureConnection(): Promise<{ page: Page; context: BrowserContext; browser: Browser }> {
    if (this.isConnected && this.browser && this.page && !this.page.isClosed()) {
      return { page: this.page, context: this.context!, browser: this.browser };
    }

    await this.closeQuietly();

    const port = getRelayPort();
    const clientId = `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cdpUrl = getCdpUrl(port, clientId);

    this.logger.log('Connecting Playwright over CDP:', cdpUrl);

    const browser = await Promise.race([
      chromium.connectOverCDP(cdpUrl),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('CDP connection timeout (15s)')), 15000)),
    ]);

    browser.on('disconnected', () => {
      this.logger.log('Playwright browser disconnected');
      this.clearConnectionState();
    });

    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(15000);

    const pages = context.pages().filter(p => !p.isClosed());
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    this.setupPageListeners(page);

    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    } catch { /* best-effort stabilization */ }

    this.browser = browser;
    this.context = context;
    this.page = page;
    this.isConnected = true;

    return { page, context, browser };
  }

  // -----------------------------------------------------------------------
  // Page lifecycle management (matches upstream setupPageListeners)
  // -----------------------------------------------------------------------

  private setupPageListeners(page: Page): void {
    if (this.pagesWithListeners.has(page)) return;
    this.pagesWithListeners.add(page);

    page.on('close', () => {
      if (this.page === page) {
        this.logger.log('Active page closed, looking for replacement...');
        const stateKeys = Object.keys(this.userState);
        const stateNote = stateKeys.length > 0 ? ` State keys preserved: ${stateKeys.join(', ')}` : '';
        this.enqueueWarning(`Page closed during execution.${stateNote} A replacement page will be used if available.`);
        const pages = this.context?.pages().filter(p => !p.isClosed()) ?? [];
        this.page = pages.length > 0 ? pages[0] : null;
        if (this.page) {
          this.setupPageListeners(this.page);
          this.logger.log('Switched to replacement page:', this.page.url());
        } else {
          this.logger.log('No replacement page available');
          this.enqueueWarning('No replacement page available after page close.');
        }
      }
    });

    page.on('popup', (popup: Page) => {
      this.enqueueWarning(`Popup detected: ${popup.url() || '(about:blank)'}`);
      this.setupPageListeners(popup);
    });

    page.on('console', (msg) => {
      try {
        this.networkMonitor.addConsoleLog({
          level: msg.type(),
          text: msg.text(),
          timestamp: Date.now(),
          url: msg.location()?.url,
          lineNumber: msg.location()?.lineNumber,
        });
      } catch { /* ignore */ }
    });

    page.on('request', (req) => {
      try {
        this.networkMonitor.addNetworkRequest({
          requestId: req.url() + '-' + Date.now(),
          request: {
            url: req.url(),
            method: req.method(),
            headers: req.headers(),
            postData: req.postData() ?? undefined,
            hasPostData: !!req.postData(),
          },
          type: req.resourceType(),
        });
      } catch { /* ignore */ }
    });

    page.on('response', (resp) => {
      try {
        const reqUrl = resp.url();
        const entries = this.networkMonitor.getNetworkEntries({ count: 500 });
        const match = entries.reverse().find(e => e.url === reqUrl && !e.status);
        if (match) {
          this.networkMonitor.setNetworkResponse({
            requestId: match.requestId,
            response: {
              status: resp.status(),
              statusText: resp.statusText(),
              headers: resp.headers(),
              mimeType: resp.headers()['content-type'] || '',
            },
          });
          this.networkMonitor.setNetworkFinished({
            requestId: match.requestId,
            encodedDataLength: 0,
          });
        }
      } catch { /* ignore */ }
    });

    page.on('requestfailed', (req) => {
      try {
        const reqUrl = req.url();
        const entries = this.networkMonitor.getNetworkEntries({ count: 500 });
        const match = entries.reverse().find(e => e.url === reqUrl && !e.status && !e.error);
        if (match) {
          this.networkMonitor.setNetworkFailed({
            requestId: match.requestId,
            errorText: req.failure()?.errorText || 'unknown',
          });
        }
      } catch { /* ignore */ }
    });
  }

  // -----------------------------------------------------------------------
  // CDP session for direct protocol commands
  // -----------------------------------------------------------------------

  private async getCDPSession(page: Page): Promise<any> {
    try {
      return await page.context().newCDPSession(page);
    } catch {
      return null;
    }
  }

  private async sendCdp(cdpSession: any, method: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown> {
    if (!cdpSession) throw new Error(`CDP session not available (required for ${method})`);
    const ms = timeout || getCommandTimeout(method);
    return withTimeout(cdpSession.send(method, params || {}), ms, method);
  }

  // -----------------------------------------------------------------------
  // Core execute
  // -----------------------------------------------------------------------

  cancelActiveExecution(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  async execute(code: string, timeout = 30000, retryOnContextError = true): Promise<ExecuteResult> {
    const consoleLogs: Array<{ method: string; args: unknown[] }> = [];
    const screenshots: ExecuteScreenshot[] = [];
    const images: Array<{ data: string; mimeType: string }> = [];
    const warningScope = this.beginWarningScope();

    this.cancelActiveExecution();
    const abortController = new AbortController();
    this.activeAbortController = abortController;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    try {
      const { page, context, browser } = await this.ensureConnection();
      const cdpSession = await this.getCDPSession(page);

      const prevDefaultTimeout = 30000;
      page.setDefaultTimeout(Math.min(timeout, prevDefaultTimeout));
      page.setDefaultNavigationTimeout(Math.min(timeout, 15000));

      const customConsole = {
        log: (...args: unknown[]) => consoleLogs.push({ method: 'log', args }),
        info: (...args: unknown[]) => consoleLogs.push({ method: 'info', args }),
        warn: (...args: unknown[]) => consoleLogs.push({ method: 'warn', args }),
        error: (...args: unknown[]) => consoleLogs.push({ method: 'error', args }),
        debug: (...args: unknown[]) => consoleLogs.push({ method: 'debug', args }),
      };

      // Warm up execution context
      try {
        await Promise.race([
          page.evaluate('1'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Warmup timeout')), 3000)),
        ]);
      } catch { /* best-effort */ }

      const self = this;
      const sendCdpCmd: CdpSender = (method, params, cmdTimeout) =>
        self.sendCdp(cdpSession, method, params, cmdTimeout) as Promise<any>;

      const vmContextObj: Record<string, unknown> = {
        page,
        context,
        browser,
        state: this.userState,
        console: customConsole,
        ...usefulGlobals,
        ...this.buildVmGlobals(page, cdpSession, sendCdpCmd, screenshots, images),
        ...this.customGlobals,
      };

      const vmContext = vm.createContext(vmContextObj);
      const autoReturnExpr = getAutoReturnExpression(code);
      const wrappedCode = autoReturnExpr !== null
        ? `(async () => { return await (${autoReturnExpr}) })()`
        : `(async () => { ${code} })()`;
      const hasExplicitReturn = autoReturnExpr !== null || /\breturn\b/.test(code);

      const result = await Promise.race([
        vm.runInContext(wrappedCode, vmContext, { timeout, displayErrors: true }),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new CodeExecutionTimeoutError(timeout)), timeout);
        }),
        new Promise((_, reject) => {
          abortController.signal.addEventListener('abort', () => reject(new CodeExecutionTimeoutError(timeout)));
        }),
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);

      page.setDefaultTimeout(prevDefaultTimeout);
      page.setDefaultNavigationTimeout(15000);

      let responseText = PlaywrightExecutor.formatConsoleLogs(consoleLogs);

      if (hasExplicitReturn && result !== undefined && !isPlaywrightChannelOwner(result)) {
        const formatted = typeof result === 'string'
          ? result
          : util.inspect(result, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000, breakLength: 80 });
        if (formatted.trim()) {
          responseText += `[return value] ${formatted}\n`;
        }
      }

      if (!responseText.trim()) {
        responseText = 'Code executed successfully (no output)';
      }

      const MAX_LENGTH = 10000;
      let finalText = responseText.trim();
      if (finalText.length > MAX_LENGTH) {
        finalText = finalText.slice(0, MAX_LENGTH) + `\n\n[Truncated to ${MAX_LENGTH} characters]`;
      }

      const warnings = this.flushWarningsForScope(warningScope);
      if (warnings.length > 0) {
        finalText += `\n\n[Warnings]\n${warnings.map(w => `⚠ ${w}`).join('\n')}`;
      }

      return { text: finalText, isError: false, images, screenshots };
    } catch (err: unknown) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const e = err as Error;
      const isTimeoutError = e instanceof CodeExecutionTimeoutError || e.name === 'TimeoutError' || e.name === 'AbortError';
      const isRecoverableContextError =
        /Execution context was destroyed/i.test(e.message) || /Cannot find context with specified id/i.test(e.message);

      if (retryOnContextError && isRecoverableContextError) {
        this.logger.log('Playwright execution context stale, retrying once...');
        await new Promise(resolve => setTimeout(resolve, 150));
        return this.execute(code, timeout, false);
      }

      this.logger.error('Error in playwright execute:', e.stack || e.message);

      if (isTimeoutError) {
        try {
          if (this.page && !this.page.isClosed()) {
            await Promise.race([
              this.page.evaluate('1'),
              new Promise((_, reject) => setTimeout(() => reject(new Error('post-timeout check')), 3000)),
            ]).catch(() => {});
          }
        } catch { /* ignore */ }
      }

      const logsText = PlaywrightExecutor.formatConsoleLogs(consoleLogs, 'Console output (before error)');
      const resetHint = isTimeoutError
        ? '\n\n[HINT: Execution timed out. The operation may still be running in the browser. Use reset if the browser is in a bad state.]'
        : '\n\n[HINT: If this is a Playwright connection error, call reset to reconnect.]';
      const errorText = isTimeoutError ? e.message : (e.stack || e.message);

      return {
        text: `${logsText}\nError executing code: ${errorText}${resetHint}`,
        isError: true,
        images,
        screenshots,
      };
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Build all VM globals (the core of the shared executor)
  // -----------------------------------------------------------------------

  private buildVmGlobals(
    page: Page,
    cdpSession: any,
    sendCdpCmd: CdpSender,
    screenshots: ExecuteScreenshot[],
    images: Array<{ data: string; mimeType: string }>,
  ): Record<string, unknown> {
    const self = this;

    const evaluateJs = async (expression: string, evalTimeout = 30000): Promise<unknown> => {
      if (cdpSession) {
        const result = await sendCdpCmd('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
          timeout: evalTimeout,
        }, evalTimeout + 5000) as any;
        if (result.exceptionDetails) throw new Error(`JS error: ${result.exceptionDetails.text}`);
        return result.result?.value;
      }
      return page.evaluate(expression);
    };

    const captureScreenshotFallback = async (): Promise<string> => {
      if (self.relaySendCdp) {
        const result = await self.relaySendCdp('Page.captureScreenshot', { format: 'png' }) as any;
        return result?.data || result;
      }
      const buf = await page.screenshot({ type: 'png' });
      return buf.toString('base64');
    };

    // Relay CDP fallback: sends CDP commands through the relay's extension connection
    // when Playwright CDPSession is unavailable
    const relayCdp = async (method: string, params?: Record<string, unknown>, timeout?: number): Promise<unknown> => {
      if (cdpSession) return sendCdpCmd(method, params, timeout);
      if (self.relaySendCdp) return self.relaySendCdp(method, params, timeout);
      throw new Error(`CDP session not available (required for ${method})`);
    };

    const globals: Record<string, unknown> = {
      // --- Accessibility snapshot ---
      snapshot: async (options?: { search?: string; diff?: boolean; interactive_only?: boolean }) => {
        if (cdpSession) {
          await sendCdpCmd('Accessibility.enable', undefined, getCommandTimeout('Accessibility.enable'));
          const axResult = await sendCdpCmd('Accessibility.getFullAXTree', undefined, getCommandTimeout('Accessibility.getFullAXTree')) as any;
          const axNodes: AXNode[] = axResult.nodes ?? [];

          if (options?.interactive_only) {
            const interactive = getInteractiveElements(axNodes);
            const text = formatInteractiveSnapshot(interactive);
            self.lastSnapshot = text;
            return text;
          }

          const targetId = (page as any)._guid || 'default';
          const fullText = formatAXTreeAsText(axNodes, true, self.getRefCache(targetId));
          if (options?.search) {
            self.lastSnapshot = fullText;
            return searchSnapshot(fullText, options.search);
          }
          const shouldDiff = options?.diff !== false && self.lastSnapshot !== null;
          if (shouldDiff && self.lastSnapshot) {
            const diffText = computeSnapshotDiff(self.lastSnapshot, fullText);
            self.lastSnapshot = fullText;
            return diffText;
          }
          self.lastSnapshot = fullText;
          return fullText;
        }
        try {
          const ariaText = await (page.locator('body') as any).ariaSnapshot();
          if (ariaText) {
            // Build a lightweight ref cache from interactive elements in the aria text
            const targetId = (page as any)._guid || 'default';
            const refCache = self.getRefCache(targetId);
            refCache.clear();
            let refIdx = 0;
            const interactiveRoles = /- (link|button|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|spinbutton|searchbox)/;
            const lines = ariaText.split('\n');
            const annotatedLines: string[] = [];
            for (const line of lines) {
              const match = line.match(/- (link|button|textbox|checkbox|radio|combobox|menuitem|tab|switch|slider|spinbutton|searchbox)\s+"?([^":\n]*)"?/);
              if (match) {
                const role = match[1];
                const name = match[2]?.trim() || '';
                refCache.set(refIdx, { backendDOMNodeId: -1, role, name });
                annotatedLines.push(line.replace(/^(\s*- )/, `$1@${refIdx} `));
                refIdx++;
              } else {
                annotatedLines.push(line);
              }
            }
            const annotated = annotatedLines.join('\n');
            self.lastSnapshot = annotated;
            if (options?.search) {
              return searchSnapshot(annotated, options.search);
            }
            return annotated;
          }
        } catch { /* ariaSnapshot not available in this Playwright version */ }
        return '(accessibility snapshot requires CDP session — not available through relay connection)';
      },

      refToLocator: (optsOrRef: { ref: number } | number) => {
        const ref = typeof optsOrRef === 'number' ? optsOrRef : optsOrRef.ref;
        const targetId = (page as any)._guid || 'default';
        const refCache = self.getRefCache(targetId);
        const info = refCache.get(ref);
        if (!info) return null;
        return { backendDOMNodeId: info.backendDOMNodeId, role: info.role, name: info.name };
      },

      // --- Screenshot with labels ---
      screenshotWithLabels: async (options?: { quality?: string; model?: string }) => {
        const tier = options?.quality || 'medium';
        const profile = resolveImageProfile(tier, options?.model);

        if (cdpSession) {
          await sendCdpCmd('Accessibility.enable', undefined, getCommandTimeout('Accessibility.enable'));
          await sendCdpCmd('DOM.enable', undefined, getCommandTimeout('DOM.enable'));
          const axResult = await sendCdpCmd('Accessibility.getFullAXTree', undefined, getCommandTimeout('Accessibility.getFullAXTree')) as any;
          const interactive = getInteractiveElements(axResult.nodes ?? []);

          const labelPositions: Array<{ index: number; x: number; y: number; width: number; height: number }> = [];
          for (const el of interactive) {
            try {
              const boxModel = await sendCdpCmd('DOM.getBoxModel', { backendNodeId: el.backendDOMNodeId }) as any;
              if (boxModel?.model) {
                const b = boxModel.model.border;
                const x = Math.min(b[0], b[2], b[4], b[6]);
                const y = Math.min(b[1], b[3], b[5], b[7]);
                const maxX = Math.max(b[0], b[2], b[4], b[6]);
                const maxY = Math.max(b[1], b[3], b[5], b[7]);
                labelPositions.push({ index: el.index, x, y, width: maxX - x, height: maxY - y });
              }
            } catch { /* element not visible */ }
          }

          if (labelPositions.length > 0) {
            await evaluateJs(buildLabelInjectionScript(labelPositions));
          }

          const capture = await captureWithSizeGuarantee(sendCdpCmd, profile);

          if (labelPositions.length > 0) {
            await evaluateJs(REMOVE_LABELS_SCRIPT).catch(() => {});
          }

          const legend = formatLabelLegend(interactive);
          const targetId = (page as any)._guid || 'default';
          const snapshotText = formatAXTreeAsText(axResult.nodes ?? [], true, self.getRefCache(targetId));

          images.push({ data: capture.data, mimeType: capture.mimeType });
          screenshots.push({
            path: '',
            base64: capture.data,
            mimeType: capture.mimeType as 'image/png' | 'image/webp' | 'image/jpeg',
            snapshot: snapshotText,
            labelCount: interactive.length,
          });

          return legend + (capture.compressed
            ? `\n(auto-compressed to fit ${(profile.effectiveLimit / 1_000_000).toFixed(0)}MB limit)`
            : '');
        }

        // Playwright fallback: use in-page JS to find interactive elements and their bounding boxes
        const findInteractiveCode = `(() => {
          var selectors = ['a[href]','button','input','select','textarea','[role="button"]','[role="link"]','[role="textbox"]','[role="checkbox"]','[role="radio"]','[role="combobox"]','[role="menuitem"]','[role="tab"]','[role="switch"]','[role="slider"]','[role="spinbutton"]','[role="searchbox"]','[onclick]','[tabindex]:not([tabindex="-1"])'];
          var seen = new Set();
          var results = [];
          var idx = 0;
          for (var s of selectors) {
            for (var el of document.querySelectorAll(s)) {
              if (seen.has(el)) continue;
              seen.add(el);
              var rect = el.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) continue;
              var role = el.getAttribute('role') || el.tagName.toLowerCase();
              var name = el.getAttribute('aria-label') || el.innerText?.slice(0, 80) || '';
              results.push({ index: idx++, role: role, name: name.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height });
            }
          }
          return JSON.stringify(results);
        })()`;
        const rawInteractive = await evaluateJs(findInteractiveCode);
        const interactiveData: Array<{ index: number; role: string; name: string; x: number; y: number; width: number; height: number }> =
          typeof rawInteractive === 'string' ? JSON.parse(rawInteractive) : [];

        const labelPositions = interactiveData.map(el => ({
          index: el.index, x: el.x, y: el.y, width: el.width, height: el.height,
        }));

        if (labelPositions.length > 0) {
          await evaluateJs(buildLabelInjectionScript(labelPositions));
        }

        const data = await captureScreenshotFallback();

        if (labelPositions.length > 0) {
          await evaluateJs(REMOVE_LABELS_SCRIPT).catch(() => {});
        }

        const legendLines = interactiveData.map(el =>
          `@${el.index} [${el.role}]${el.name ? ` "${el.name}"` : ''}`
        );
        const legend = legendLines.length > 0
          ? `Interactive elements (${legendLines.length}):\n${legendLines.join('\n')}`
          : 'No interactive elements found.';

        const snapshotText = self.lastSnapshot || '';
        images.push({ data, mimeType: 'image/png' });
        screenshots.push({
          path: '',
          base64: data,
          mimeType: 'image/png',
          snapshot: snapshotText,
          labelCount: interactiveData.length,
        });

        return legend + ' (via relay CDP)';
      },

      screenshot: async (options?: { quality?: string; model?: string; labels?: boolean }) => {
        if (options?.labels) {
          return (globals.screenshotWithLabels as Function)(options);
        }
        if (cdpSession) {
          const tier = options?.quality || 'medium';
          const profile = resolveImageProfile(tier, options?.model);
          const capture = await captureWithSizeGuarantee(sendCdpCmd, profile);
          images.push({ data: capture.data, mimeType: capture.mimeType });
          return capture.compressed
            ? `Screenshot captured (auto-compressed to fit ${(profile.effectiveLimit / 1_000_000).toFixed(0)}MB limit)`
            : 'Screenshot captured';
        }
        const data = await captureScreenshotFallback();
        images.push({ data, mimeType: 'image/png' });
        return 'Screenshot captured (via relay CDP)';
      },

      // --- Console logs (browser persistent) ---
      getLatestLogs: (options?: { level?: string; count?: number; search?: string; clear?: boolean }) => {
        const logs = self.networkMonitor.getConsoleLogs({
          count: options?.count,
          level: options?.level,
          search: options?.search,
        });
        const text = fmtConsole(logs, self.networkMonitor.consoleLogCount);
        if (options?.clear) self.networkMonitor.clearConsoleLogs();
        return text;
      },

      clearAllLogs: () => {
        self.networkMonitor.clearConsoleLogs();
        return 'All console logs cleared.';
      },

      consoleLogs: async (options?: { level?: string; count?: number; search?: string; clear?: boolean }) => {
        const logs = self.networkMonitor.getConsoleLogs({
          count: options?.count,
          level: options?.level,
          search: options?.search,
        });
        const text = fmtConsole(logs, self.networkMonitor.consoleLogCount);
        if (options?.clear) self.networkMonitor.clearConsoleLogs();
        return text;
      },

      // --- Network monitoring ---
      networkLog: async (options?: { status_filter?: string; url_filter?: string; count?: number; clear?: boolean }) => {
        const entries = self.networkMonitor.getNetworkEntries({
          count: options?.count,
          urlFilter: options?.url_filter,
          statusFilter: options?.status_filter,
        });
        const text = fmtNetwork(entries, self.networkMonitor.networkEntryCount);
        if (options?.clear) self.networkMonitor.clearNetworkLog();
        return text;
      },

      networkDetail: async (requestId: string, options?: { include?: string; max_body_size?: number }) => {
        const entry = self.networkMonitor.getNetworkDetail(requestId);
        if (!entry) return `Request "${requestId}" not found. Use networkLog() to list available requests.`;

        const includeStr = (options?.include || 'all').toLowerCase();
        const sections = includeStr === 'all'
          ? ['request_headers', 'request_body', 'response_headers', 'response_body']
          : includeStr.split(',').map(s => s.trim());
        const maxBodySize = options?.max_body_size ?? 10000;

        const parts: string[] = [];
        const dur = entry.endTime && entry.startTime ? `${entry.endTime - entry.startTime}ms` : 'pending';
        parts.push(`Request: ${entry.method} ${entry.url}`);
        parts.push(`Status: ${entry.status ?? '(pending)'} ${entry.statusText || ''}`);
        parts.push(`Type: ${entry.resourceType || 'unknown'} | MIME: ${entry.mimeType || 'unknown'} | Duration: ${dur} | Size: ${entry.size ? `${(entry.size / 1024).toFixed(1)}KB` : 'unknown'}`);
        if (entry.error) parts.push(`Error: ${entry.error}`);

        if (sections.includes('request_headers') && entry.requestHeaders) {
          const hdrs = Object.entries(entry.requestHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n');
          parts.push(`\nRequest Headers:\n${hdrs}`);
        }
        if (sections.includes('request_body')) {
          if (entry.postData) {
            let bodyText = entry.postData;
            if (bodyText.length > maxBodySize && maxBodySize > 0) bodyText = bodyText.slice(0, maxBodySize) + `\n[Truncated to ${maxBodySize} chars]`;
            parts.push(`\nRequest Body:\n${bodyText}`);
          } else if (entry.hasPostData) {
            try {
              const result = await sendCdpCmd('Network.getRequestPostData', { requestId }) as any;
              if (result?.postData) {
                let bodyText = result.base64Encoded ? Buffer.from(result.postData, 'base64').toString('utf-8') : result.postData;
                if (bodyText.length > maxBodySize && maxBodySize > 0) bodyText = bodyText.slice(0, maxBodySize) + `\n[Truncated to ${maxBodySize} chars]`;
                parts.push(`\nRequest Body:\n${bodyText}`);
              } else {
                parts.push('\nRequest Body: (not available)');
              }
            } catch {
              parts.push('\nRequest Body: (not available - request may have been evicted from buffer)');
            }
          } else {
            parts.push('\nRequest Body: (none - GET or no body)');
          }
        }
        if (sections.includes('response_headers') && entry.responseHeaders) {
          const hdrs = Object.entries(entry.responseHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n');
          parts.push(`\nResponse Headers:\n${hdrs}`);
        }
        if (sections.includes('response_body') && maxBodySize > 0) {
          try {
            const result = await sendCdpCmd('Network.getResponseBody', { requestId }) as any;
            if (result?.body !== undefined) {
              let bodyText = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf-8') : result.body;
              if (bodyText.length > maxBodySize) bodyText = bodyText.slice(0, maxBodySize) + `\n[Truncated to ${maxBodySize} chars]`;
              parts.push(`\nResponse Body:\n${bodyText}`);
            } else {
              parts.push('\nResponse Body: (empty)');
            }
          } catch {
            parts.push('\nResponse Body: (not available - may have been evicted from browser buffer)');
          }
        }
        return parts.join('\n');
      },

      clearNetworkLog: () => {
        self.networkMonitor.clearNetworkLog();
        return 'Network log cleared.';
      },

      // --- Network interception ---
      networkIntercept: {
        enable: async (urlPattern?: string) => {
          if (cdpSession) {
            const patterns = [{ urlPattern: urlPattern || '*', requestStage: 'Request' }];
            await sendCdpCmd('Fetch.enable', { patterns });
          }
          self.networkMonitor.enableIntercept();
          return `Network interception enabled. ${self.networkMonitor.listInterceptRules().length} rules active.${!cdpSession ? ' (using Playwright page.route — add rules then they will be applied)' : ''}`;
        },
        disable: async () => {
          if (cdpSession) {
            await sendCdpCmd('Fetch.disable');
          }
          await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
          self.networkMonitor.disableIntercept();
          return 'Network interception disabled.';
        },
        listRules: () => {
          const rules = self.networkMonitor.listInterceptRules();
          if (rules.length === 0) return `No intercept rules. Interception is ${self.networkMonitor.isInterceptEnabled ? 'enabled' : 'disabled'}.`;
          const lines = rules.map(r => {
            const parts = [`[${r.id}] pattern="${r.urlPattern}"`];
            if (r.resourceType) parts.push(`type=${r.resourceType}`);
            if (r.block) parts.push('→ BLOCK');
            else if (r.mockStatus !== undefined) parts.push(`→ mock ${r.mockStatus}`);
            return parts.join(' ');
          });
          return `Intercept rules (${rules.length}, ${self.networkMonitor.isInterceptEnabled ? 'enabled' : 'disabled'}):\n${lines.join('\n')}`;
        },
        addRule: (rule: { url_pattern: string; mock_status?: number; mock_headers?: string; mock_body?: string; block?: boolean; resource_type?: string }) => {
          const newRule = self.networkMonitor.addInterceptRule({
            urlPattern: rule.url_pattern,
            resourceType: rule.resource_type,
            block: rule.block,
            mockStatus: rule.mock_status,
            mockHeaders: rule.mock_headers ? JSON.parse(rule.mock_headers) : undefined,
            mockBody: rule.mock_body,
          });
          return `Rule added: ${newRule.id} (pattern="${newRule.urlPattern}"${newRule.block ? ', block' : ''}${newRule.mockStatus !== undefined ? `, mock ${newRule.mockStatus}` : ''})`;
        },
        removeRule: (ruleId: string) => {
          const removed = self.networkMonitor.removeInterceptRule(ruleId);
          return removed ? `Rule ${ruleId} removed.` : `Rule ${ruleId} not found.`;
        },
      },

      // --- Single-spa management ---
      singleSpa: {
        status: async (appName?: string) => {
          const code = buildDashboardStateCode(appName);
          const value = await evaluateJs(code);
          return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        },
        override: async (action: string, appName?: string, url?: string) => {
          const { code, error: err } = buildOverrideCode(action, appName, url);
          if (err) return err;
          const value = await evaluateJs(code);
          const resultText = typeof value === 'string' ? value : JSON.stringify(value);
          let reloaded = false;
          try {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            if (parsed?.success) {
              if (cdpSession) {
                await sendCdpCmd('Page.reload', { ignoreCache: true }, getCommandTimeout('Page.reload'));
              } else {
                await page.evaluate('window.location.reload()');
              }
              await new Promise(r => setTimeout(r, 2000));
              reloaded = true;
            }
          } catch { /* skip reload */ }
          return reloaded ? resultText + ' (page reloaded)' : resultText;
        },
        mount: async (appName: string) => {
          const code = buildAppActionCode('mount', appName);
          const value = await evaluateJs(code);
          return typeof value === 'string' ? value : JSON.stringify(value);
        },
        unmount: async (appName: string) => {
          const code = buildAppActionCode('unmount', appName);
          const value = await evaluateJs(code);
          return typeof value === 'string' ? value : JSON.stringify(value);
        },
        unload: async (appName: string) => {
          const code = buildAppActionCode('unload', appName);
          const value = await evaluateJs(code);
          return typeof value === 'string' ? value : JSON.stringify(value);
        },
        detectOverrideChanges: (pageOverrides: OverrideState) => {
          return detectOverrideChanges(pageOverrides, self.savedOverrides);
        },
        importPageOverrides: (pageOverrides: OverrideState) => {
          self.savedOverrides = importPageOverrides(pageOverrides, self.savedOverrides);
          return self.savedOverrides;
        },
      },

      // --- CSS inspect ---
      cssInspect: async (selector: string, properties?: string) => {
        const requestedProps = (properties || '').split(',').map(p => p.trim()).filter(Boolean);
        const defaultProps = [
          'display', 'position', 'width', 'height', 'margin', 'padding',
          'color', 'background-color', 'font-size', 'font-weight', 'font-family',
          'border', 'border-radius', 'opacity', 'visibility', 'overflow',
          'flex-direction', 'justify-content', 'align-items', 'gap',
          'z-index', 'box-shadow', 'text-align',
        ];
        const propsToGet = requestedProps.length > 0 ? requestedProps : defaultProps;
        const code = `(function() {
          var el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return JSON.stringify({ error: 'Element not found: ' + ${JSON.stringify(selector)} });
          var cs = getComputedStyle(el);
          var result = {};
          ${JSON.stringify(propsToGet)}.forEach(function(p) { result[p] = cs.getPropertyValue(p); });
          result.__tagName = el.tagName.toLowerCase();
          result.__className = el.className || '';
          result.__id = el.id || '';
          var rect = el.getBoundingClientRect();
          result.__bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
          return JSON.stringify(result);
        })()`;
        const value = await evaluateJs(code);
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (parsed?.error) return parsed.error;
        const tag = parsed.__tagName;
        const id = parsed.__id ? `#${parsed.__id}` : '';
        const cls = parsed.__className ? `.${parsed.__className.split(' ').join('.')}` : '';
        const bounds = parsed.__bounds;
        const header = `Element: <${tag}${id}${cls}> (${bounds.width}x${bounds.height} at ${bounds.x},${bounds.y})`;
        delete parsed.__tagName; delete parsed.__className; delete parsed.__id; delete parsed.__bounds;
        const propLines = Object.entries(parsed)
          .filter(([, v]) => v !== '' && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== 'visible' && v !== '0px')
          .map(([k, v]) => `  ${k}: ${v}`);
        return `${header}\n\nComputed styles:\n${propLines.join('\n') || '  (no non-default styles)'}`;
      },

      // --- Debugger ---
      dbg: {
        enable: async () => {
          await relayCdp('Debugger.enable');
          await relayCdp('Runtime.enable');
          self.debugger.enabled = true;
          return 'Debugger enabled. Scripts will be parsed and breakpoints can be set.';
        },
        disable: async () => {
          if (self.debugger.enabled) {
            await relayCdp('Debugger.disable').catch(() => {});
          }
          self.debugger.enabled = false;
          self.debugger.paused = false;
          self.debugger.currentCallFrameId = null;
          self.debugger.breakpoints.clear();
          self.debugger.knownScripts.clear();
          return 'Debugger disabled.';
        },
        resume: async () => {
          if (!self.debugger.paused) return 'Debugger is not paused.';
          await relayCdp('Debugger.resume');
          return 'Resumed execution.';
        },
        stepOver: async () => {
          if (!self.debugger.paused) return 'Debugger is not paused.';
          await relayCdp('Debugger.stepOver');
          return 'Stepped over.';
        },
        stepInto: async () => {
          if (!self.debugger.paused) return 'Debugger is not paused.';
          await relayCdp('Debugger.stepInto');
          return 'Stepped into.';
        },
        stepOut: async () => {
          if (!self.debugger.paused) return 'Debugger is not paused.';
          await relayCdp('Debugger.stepOut');
          return 'Stepped out.';
        },
        setBreakpoint: async (file: string, line: number, condition?: string) => {
          if (!file || !line) return 'Error: set_breakpoint requires file and line';
          if (!self.debugger.enabled) { await relayCdp('Debugger.enable'); await relayCdp('Runtime.enable'); self.debugger.enabled = true; }
          const result = await relayCdp('Debugger.setBreakpointByUrl', {
            lineNumber: line - 1,
            urlRegex: file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            columnNumber: 0,
            ...(condition ? { condition } : {}),
          }) as any;
          self.debugger.breakpoints.set(result.breakpointId, { id: result.breakpointId, file, line });
          return `Breakpoint set: ${result.breakpointId} at ${file}:${line}${condition ? ` (condition: ${condition})` : ''}`;
        },
        removeBreakpoint: async (breakpointId: string) => {
          if (!breakpointId) return 'Error: remove_breakpoint requires breakpointId';
          await relayCdp('Debugger.removeBreakpoint', { breakpointId });
          self.debugger.breakpoints.delete(breakpointId);
          return `Breakpoint removed: ${breakpointId}`;
        },
        listBreakpoints: () => {
          const bps = Array.from(self.debugger.breakpoints.values());
          if (bps.length === 0) return 'No active breakpoints.';
          const lines = bps.map(bp => `${bp.id}: ${bp.file}:${bp.line}`);
          return `Active breakpoints (${bps.length}):\n${lines.join('\n')}`;
        },
        inspectVariables: async () => {
          if (!self.debugger.paused || !self.debugger.currentCallFrameId) return 'Debugger is not paused at a breakpoint.';
          const evalResult = await relayCdp('Debugger.evaluateOnCallFrame', {
            callFrameId: self.debugger.currentCallFrameId,
            expression: '(function(){ var __r = {}; try { var __s = arguments.callee.caller; } catch(e) {} return JSON.stringify(__r); })()',
            returnByValue: true,
          }) as any;
          return evalResult?.result?.value ?? 'Unable to inspect variables (try using evaluate action instead)';
        },
        evaluate: async (expression: string) => {
          if (!expression) return 'Error: evaluate requires expression';
          let evalResult;
          if (self.debugger.paused && self.debugger.currentCallFrameId) {
            evalResult = await relayCdp('Debugger.evaluateOnCallFrame', {
              callFrameId: self.debugger.currentCallFrameId, expression, returnByValue: true, generatePreview: true,
            }) as any;
          } else {
            evalResult = await relayCdp('Runtime.evaluate', {
              expression, returnByValue: true, awaitPromise: true,
            }) as any;
          }
          const val = evalResult?.result?.value;
          return val !== undefined ? (typeof val === 'string' ? val : JSON.stringify(val, null, 2)) : (evalResult?.result?.description || 'undefined');
        },
        listScripts: async (search?: string) => {
          if (!self.debugger.enabled) { await relayCdp('Debugger.enable'); await relayCdp('Runtime.enable'); self.debugger.enabled = true; await new Promise(r => setTimeout(r, 200)); }
          const searchStr = (search || '').toLowerCase();
          let scripts = Array.from(self.debugger.knownScripts.values());
          if (searchStr) scripts = scripts.filter(s => s.url.toLowerCase().includes(searchStr));
          scripts = scripts.slice(0, 30);
          if (scripts.length === 0) return 'No scripts found.';
          const scriptLines = scripts.map(s => `${s.scriptId}: ${s.url}`);
          return `Scripts (${scripts.length}):\n${scriptLines.join('\n')}`;
        },
        pauseOnExceptions: async (state: 'none' | 'uncaught' | 'all') => {
          if (!self.debugger.enabled) { await relayCdp('Debugger.enable'); self.debugger.enabled = true; }
          await relayCdp('Debugger.setPauseOnExceptions', { state });
          return `Pause on exceptions: ${state}`;
        },
      },

      // --- Browser fetch ---
      browserFetch: async (url: string, options?: { method?: string; headers?: string; body?: string; max_body_size?: number }) => {
        const method = options?.method || 'GET';
        const headers = options?.headers;
        const body = options?.body;
        const rawMax = options?.max_body_size;
        const maxSize = Math.max(1, Math.min(Number.isFinite(rawMax as number) ? (rawMax as number) : 10000, 100000));
        const fetchCode = `(async () => {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 30000);
            const resp = await fetch(${JSON.stringify(url)}, {
              method: ${JSON.stringify(method)},
              ${headers ? `headers: JSON.parse(${JSON.stringify(headers)}),` : ''}
              ${body ? `body: ${JSON.stringify(body)},` : ''}
              credentials: 'include',
              signal: controller.signal
            });
            clearTimeout(timer);
            const text = await resp.text();
            return JSON.stringify({
              status: resp.status, statusText: resp.statusText,
              headers: Object.fromEntries(resp.headers.entries()),
              body: text.slice(0, ${maxSize}),
              truncated: text.length > ${maxSize}
            });
          } catch (e) {
            return JSON.stringify({ error: e.name === 'AbortError' ? 'Request timed out after 30s' : e.message });
          }
        })()`;
        const result = await evaluateJs(fetchCode);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },

      // --- Storage ---
      storage: async (action: string, options?: Record<string, unknown>) => {
        const opts = options || {};
        switch (action) {
          case 'get_cookies': {
            if (cdpSession) {
              const result = await sendCdpCmd('Network.getCookies') as any;
              const cookies = result?.cookies || [];
              if (cookies.length === 0) return 'No cookies found.';
              const lines = cookies.map((c: any) =>
                `${c.name}=${String(c.value).slice(0, 80)}${String(c.value).length > 80 ? '...' : ''} (domain=${c.domain}, path=${c.path}, secure=${c.secure}, httpOnly=${c.httpOnly}, sameSite=${c.sameSite || 'None'})`
              );
              return `Cookies (${cookies.length}):\n${lines.join('\n')}`;
            }
            const cookies = await page.context().cookies();
            if (cookies.length === 0) return 'No cookies found.';
            const lines = cookies.map((c) =>
              `${c.name}=${String(c.value).slice(0, 80)}${String(c.value).length > 80 ? '...' : ''} (domain=${c.domain}, path=${c.path}, secure=${c.secure}, httpOnly=${c.httpOnly}, sameSite=${c.sameSite || 'None'})`
            );
            return `Cookies (${cookies.length}):\n${lines.join('\n')}`;
          }
          case 'set_cookie': {
            const name = opts.name as string;
            const value = opts.value as string;
            if (!name || value === undefined) return 'Error: set_cookie requires name and value';
            if (cdpSession) {
              const params: Record<string, unknown> = { name, value };
              if (opts.domain) params.domain = opts.domain;
              if (opts.url) params.url = opts.url;
              if (opts.path) params.path = opts.path;
              if (opts.secure !== undefined) params.secure = opts.secure;
              if (opts.httpOnly !== undefined) params.httpOnly = opts.httpOnly;
              if (opts.sameSite) params.sameSite = opts.sameSite;
              if (opts.expires) params.expires = opts.expires;
              if (!params.url && !params.domain) params.url = await evaluateJs('window.location.href');
              const result = await sendCdpCmd('Network.setCookie', params) as any;
              return result?.success ? `Cookie "${name}" set.` : `Failed to set cookie "${name}".`;
            }
            const cookieObj: Record<string, unknown> = { name, value };
            if (opts.domain) {
              cookieObj.domain = opts.domain;
              cookieObj.path = (opts.path as string) || '/';
            } else {
              cookieObj.url = (opts.url as string) || page.url();
            }
            if (opts.secure !== undefined) cookieObj.secure = opts.secure;
            if (opts.httpOnly !== undefined) cookieObj.httpOnly = opts.httpOnly;
            if (opts.sameSite) cookieObj.sameSite = opts.sameSite;
            if (typeof opts.expires === 'number') cookieObj.expires = opts.expires;
            await page.context().addCookies([cookieObj as any]);
            return `Cookie "${name}" set.`;
          }
          case 'delete_cookie': {
            const name = opts.name as string;
            if (!name) return 'Error: delete_cookie requires name';
            if (cdpSession) {
              const params: Record<string, unknown> = { name };
              if (opts.domain) params.domain = opts.domain;
              if (opts.url) params.url = opts.url;
              if (opts.path) params.path = opts.path;
              if (!params.url && !params.domain) params.url = await evaluateJs('window.location.href');
              await sendCdpCmd('Network.deleteCookies', params);
              return `Cookie "${name}" deleted.`;
            }
            const delDomain = (opts.domain as string) || undefined;
            if (delDomain) {
              await page.context().clearCookies({ name, domain: delDomain });
            } else {
              const currentOrigin = new URL(await evaluateJs('window.location.href') as string);
              await page.context().clearCookies({ name, domain: currentOrigin.hostname });
            }
            return `Cookie "${name}" deleted.`;
          }
          case 'get_local_storage':
          case 'get_session_storage': {
            const isLocal = action === 'get_local_storage';
            const storageType = isLocal ? 'localStorage' : 'sessionStorage';
            const key = opts.key as string | undefined;
            if (key) {
              const val = await evaluateJs(`${storageType}.getItem(${JSON.stringify(key)})`);
              return val !== null ? `${storageType}[${key}] = ${String(val)}` : `${storageType}[${key}] = (not set)`;
            }
            const result = await evaluateJs(`JSON.stringify(Object.fromEntries(Object.entries(${storageType})))`);
            const parsed = typeof result === 'string' ? JSON.parse(result) : {};
            const entries = Object.entries(parsed);
            if (entries.length === 0) return `${storageType} is empty.`;
            const lines = entries.map(([k, v]) => {
              const vs = String(v);
              return `  ${k}: ${vs.slice(0, 200)}${vs.length > 200 ? '...' : ''}`;
            });
            return `${storageType} (${entries.length} entries):\n${lines.join('\n')}`;
          }
          case 'set_local_storage': {
            const key = opts.key as string;
            const val = opts.value as string;
            if (!key || val === undefined) return 'Error: set_local_storage requires key and value';
            await evaluateJs(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(val)})`);
            return `localStorage[${key}] set.`;
          }
          case 'remove_local_storage': {
            const key = opts.key as string;
            if (!key) return 'Error: remove_local_storage requires key';
            await evaluateJs(`localStorage.removeItem(${JSON.stringify(key)})`);
            return `localStorage[${key}] removed.`;
          }
          case 'clear_storage': {
            const origin = (opts.origin as string) || await evaluateJs('window.location.origin') as string;
            const types = opts.storage_types as string;
            if (!types) return 'Error: clear_storage requires storage_types parameter';
            if (cdpSession) {
              await sendCdpCmd('Storage.clearDataForOrigin', { origin, storageTypes: types });
              return `Storage cleared for ${origin} (types: ${types}).`;
            }
            const cleared: string[] = [];
            if (types.includes('local_storage')) { await evaluateJs('localStorage.clear()'); cleared.push('localStorage'); }
            if (types.includes('session_storage')) { await evaluateJs('sessionStorage.clear()'); cleared.push('sessionStorage'); }
            if (types.includes('cookies')) {
              const originUrl = new URL(origin);
              const allCookies = await page.context().cookies();
              const originCookies = allCookies.filter((c: any) => {
                const cd = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
                return originUrl.hostname === cd || originUrl.hostname.endsWith('.' + cd);
              });
              for (const c of originCookies) await page.context().clearCookies({ name: c.name, domain: c.domain });
              cleared.push(`cookies (${originCookies.length} for ${origin})`);
            }
            return cleared.length > 0
              ? `Storage cleared for ${origin}: ${cleared.join(', ')}. (Some storage types require CDP for full clearing.)`
              : `Cannot clear "${types}" without CDP session.`;
          }
          case 'get_storage_usage': {
            const origin = (opts.origin as string) || await evaluateJs('window.location.origin') as string;
            const result = await relayCdp('Storage.getUsageAndQuota', { origin }) as any;
            const total = `Usage: ${(result.usage / 1024).toFixed(1)}KB / ${(result.quota / (1024 * 1024)).toFixed(1)}MB (${((result.usage / result.quota) * 100).toFixed(1)}%)`;
            const breakdown = (result.usageBreakdown || [])
              .filter((b: any) => b.usage > 0)
              .map((b: any) => `  ${b.storageType}: ${(b.usage / 1024).toFixed(1)}KB`)
              .join('\n');
            return `${total}${breakdown ? '\n\nBreakdown:\n' + breakdown : ''}`;
          }
          default:
            return `Unknown storage action: ${action}`;
        }
      },

      // --- Emulation ---
      emulation: async (action: string, options?: Record<string, unknown>) => {
        const opts = options || {};
        switch (action) {
          case 'set_device': {
            const width = (opts.width as number) || 375;
            const height = (opts.height as number) || 812;
            const dpr = (opts.device_scale_factor as number) || 1;
            const mobile = (opts.mobile as boolean) ?? false;
            try {
              await relayCdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
              return `Device emulation: ${width}x${height} @${dpr}x${mobile ? ' (mobile)' : ''}`;
            } catch {
              await page.setViewportSize({ width, height });
              return `Device emulation: ${width}x${height} (viewport only, DPR/mobile requires CDP)`;
            }
          }
          case 'set_user_agent': {
            const ua = opts.user_agent as string;
            if (!ua) return 'Error: set_user_agent requires user_agent';
            await relayCdp('Emulation.setUserAgentOverride', { userAgent: ua });
            return 'User agent set.';
          }
          case 'set_geolocation': {
            const lat = opts.latitude as number;
            const lng = opts.longitude as number;
            if (lat === undefined || lng === undefined) return 'Error: set_geolocation requires latitude and longitude';
            try {
              await relayCdp('Emulation.setGeolocationOverride', { latitude: lat, longitude: lng, accuracy: (opts.accuracy as number) || 1 });
            } catch {
              await page.context().setGeolocation({ latitude: lat, longitude: lng, accuracy: (opts.accuracy as number) || 1 });
            }
            return `Geolocation: ${lat}, ${lng}`;
          }
          case 'set_timezone': {
            const tz = opts.timezone_id as string;
            if (!tz) return 'Error: set_timezone requires timezone_id';
            await relayCdp('Emulation.setTimezoneOverride', { timezoneId: tz });
            return `Timezone: ${tz}`;
          }
          case 'set_locale': {
            const loc = opts.locale as string;
            if (!loc) return 'Error: set_locale requires locale';
            await relayCdp('Emulation.setLocaleOverride', { locale: loc });
            return `Locale: ${loc}`;
          }
          case 'set_network_conditions': {
            const presets: Record<string, any> = {
              'offline': { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
              'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
              'fast-3g': { offline: false, latency: 562, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024 },
              '4g': { offline: false, latency: 170, downloadThroughput: 1.5 * 1024 * 1024, uploadThroughput: 750 * 1024 },
              'wifi': { offline: false, latency: 28, downloadThroughput: 30 * 1024 * 1024, uploadThroughput: 15 * 1024 * 1024 },
            };
            const preset = opts.preset as string;
            const params = preset && presets[preset]
              ? presets[preset]
              : { offline: false, latency: (opts.latency as number) || 0, downloadThroughput: (opts.download as number) || -1, uploadThroughput: (opts.upload as number) || -1 };
            await relayCdp('Network.emulateNetworkConditions', params);
            return `Network: ${preset || 'custom'} (latency=${params.latency}ms, down=${params.downloadThroughput > 0 ? (params.downloadThroughput / 1024).toFixed(0) + 'KB/s' : 'unlimited'}, up=${params.uploadThroughput > 0 ? (params.uploadThroughput / 1024).toFixed(0) + 'KB/s' : 'unlimited'})`;
          }
          case 'set_media': {
            const features = ((opts.features as string) || '').split(',').filter(f => f.includes(':')).map(f => {
              const [n, v] = f.trim().split(':');
              return { name: n.trim(), value: v.trim() };
            });
            await relayCdp('Emulation.setEmulatedMedia', { features });
            return `Media features: ${features.map(f => `${f.name}:${f.value}`).join(', ') || '(cleared)'}`;
          }
          case 'clear_all':
          case 'reset': {
            await relayCdp('Emulation.clearDeviceMetricsOverride');
            await relayCdp('Emulation.setEmulatedMedia', { features: [] });
            try { await relayCdp('Emulation.clearGeolocationOverride'); } catch { /* ok */ }
            try { await relayCdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); } catch { /* ok */ }
            return 'All emulations cleared.';
          }
          default:
            return `Unknown emulation action: ${action}. Available: set_device, set_geolocation, set_timezone, set_locale, set_network_conditions, set_media, clear_all/reset`;
        }
      },

      // --- Performance ---
      performance: async (action?: string) => {
        const act = action || 'get_metrics';
        switch (act) {
          case 'get_metrics': {
            await relayCdp('Performance.enable');
            const result = await relayCdp('Performance.getMetrics') as any;
            await relayCdp('Performance.disable');
            const metrics = result?.metrics || [];
            if (metrics.length === 0) return 'No metrics available.';
            const keyMetrics = ['Timestamp', 'Documents', 'Frames', 'JSEventListeners', 'Nodes', 'LayoutCount',
              'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration',
              'JSHeapUsedSize', 'JSHeapTotalSize'];
            const lines = metrics
              .filter((m: any) => keyMetrics.includes(m.name))
              .map((m: any) => {
                if (m.name.includes('HeapUsedSize') || m.name.includes('HeapTotalSize')) return `  ${m.name}: ${(m.value / (1024 * 1024)).toFixed(2)}MB`;
                if (m.name.includes('Duration')) return `  ${m.name}: ${(m.value * 1000).toFixed(1)}ms`;
                return `  ${m.name}: ${m.value}`;
              });
            return `Performance Metrics:\n${lines.join('\n')}`;
          }
          case 'get_web_vitals': {
            const code = `JSON.stringify({ lcp: window.__spawriter_lcp || null, cls: window.__spawriter_cls || null, inp: window.__spawriter_inp || null, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime || null, ttfb: performance.getEntriesByType('navigation')[0]?.responseStart || null, domInteractive: performance.getEntriesByType('navigation')[0]?.domInteractive || null, domComplete: performance.getEntriesByType('navigation')[0]?.domComplete || null, loadTime: performance.getEntriesByType('navigation')[0]?.loadEventEnd || null })`;
            const raw = await evaluateJs(code);
            const vitals = typeof raw === 'string' ? JSON.parse(raw) : {};
            const fmt = (val: number | null, unit: string, good: number, poor: number) => {
              if (val === null || val === undefined) return '(not measured)';
              const s = unit === 'ms' ? `${val.toFixed(0)}ms` : val.toFixed(3);
              const grade = val <= good ? '✅ Good' : val <= poor ? '⚠️ Needs Improvement' : '❌ Poor';
              return `${s} ${grade}`;
            };
            const lines = [
              `  LCP: ${fmt(vitals.lcp, 'ms', 2500, 4000)}`, `  CLS: ${fmt(vitals.cls, '', 0.1, 0.25)}`,
              `  INP: ${fmt(vitals.inp, 'ms', 200, 500)}`, `  FCP: ${vitals.fcp ? `${vitals.fcp.toFixed(0)}ms` : '(not available)'}`,
              `  TTFB: ${vitals.ttfb ? `${vitals.ttfb.toFixed(0)}ms` : '(not available)'}`,
              `  DOM Interactive: ${vitals.domInteractive ? `${vitals.domInteractive.toFixed(0)}ms` : '(n/a)'}`,
              `  DOM Complete: ${vitals.domComplete ? `${vitals.domComplete.toFixed(0)}ms` : '(n/a)'}`,
              `  Load: ${vitals.loadTime ? `${vitals.loadTime.toFixed(0)}ms` : '(n/a)'}`,
            ];
            const observerCode = `if (!window.__spawriter_lcp_obs) { window.__spawriter_lcp = 0; window.__spawriter_cls = 0; window.__spawriter_inp = Infinity; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__spawriter_lcp = e.startTime; }).observe({type:'largest-contentful-paint',buffered:true}); new PerformanceObserver(l => { for (const e of l.getEntries()) window.__spawriter_cls += e.value; }).observe({type:'layout-shift',buffered:true}); new PerformanceObserver(l => { for (const e of l.getEntries()) window.__spawriter_inp = Math.min(window.__spawriter_inp, e.duration); }).observe({type:'event',buffered:true,durationThreshold:16}); window.__spawriter_lcp_obs = true; } 'observers_active'`;
            await evaluateJs(observerCode);
            return `Web Vitals:\n${lines.join('\n')}\n\n(Note: LCP/CLS/INP require observers — run this tool again for updated values after page interaction.)`;
          }
          case 'get_memory': {
            try {
              await relayCdp('Performance.enable');
              const result = await relayCdp('Performance.getMetrics') as any;
              await relayCdp('Performance.disable');
              const m = Object.fromEntries((result?.metrics || []).map((x: any) => [x.name, x.value]));
              return `Memory:\n  JS Heap: ${((m['JSHeapUsedSize'] || 0) / (1024 * 1024)).toFixed(2)}MB / ${((m['JSHeapTotalSize'] || 0) / (1024 * 1024)).toFixed(2)}MB (${m['JSHeapTotalSize'] > 0 ? (((m['JSHeapUsedSize'] || 0) / m['JSHeapTotalSize']) * 100).toFixed(1) : 0}%)\n  DOM Nodes: ${m['Nodes'] || 0}\n  Event Listeners: ${m['JSEventListeners'] || 0}\n  Documents: ${m['Documents'] || 0}\n  Frames: ${m['Frames'] || 0}`;
            } catch {
              const memCode = `JSON.stringify({ jsHeapUsed: performance.memory?.usedJSHeapSize || null, jsHeapTotal: performance.memory?.totalJSHeapSize || null, jsHeapLimit: performance.memory?.jsHeapSizeLimit || null })`;
              const raw = await evaluateJs(memCode);
              const mem = typeof raw === 'string' ? JSON.parse(raw) : {};
              if (mem.jsHeapUsed !== null) {
                return `Memory (via performance.memory):\n  JS Heap: ${(mem.jsHeapUsed / (1024 * 1024)).toFixed(2)}MB / ${(mem.jsHeapTotal / (1024 * 1024)).toFixed(2)}MB (${((mem.jsHeapUsed / mem.jsHeapTotal) * 100).toFixed(1)}%)`;
              }
              return 'Memory info not available in this browser.';
            }
          }
          case 'get_resource_timing': {
            const code = `JSON.stringify(performance.getEntriesByType('resource').map(e => ({ name: e.name, type: e.initiatorType, duration: e.duration, transferSize: e.transferSize, decodedBodySize: e.decodedBodySize, startTime: e.startTime })))`;
            const raw = await evaluateJs(code);
            let resources: any[] = typeof raw === 'string' ? JSON.parse(raw) : [];
            resources.sort((a: any, b: any) => b.duration - a.duration);
            resources = resources.slice(0, 20);
            if (resources.length === 0) return 'No resource timing entries found.';
            const lines = resources.map((r: any) => {
              const url = r.name.length > 80 ? '...' + r.name.slice(-77) : r.name;
              return `  ${r.duration.toFixed(0).padStart(6)}ms  ${(r.transferSize / 1024).toFixed(1).padStart(7)}KB  ${r.type.padEnd(12)}  ${url}`;
            });
            return `Resource Timing (top ${resources.length} by duration):\n  ${' '.padEnd(6)}ms  ${' '.padEnd(7)}KB  ${'type'.padEnd(12)}  URL\n${lines.join('\n')}`;
          }
          default:
            return `Unknown performance action: ${act}`;
        }
      },

      // --- Editor ---
      editor: async (action: string, options?: Record<string, unknown>) => {
        const opts = options || {};
        switch (action) {
          case 'list_sources': {
            const search = ((opts.search as string) || '').toLowerCase();
            if (!self.debugger.enabled) { await relayCdp('Debugger.enable'); await relayCdp('Runtime.enable'); self.debugger.enabled = true; await new Promise(r => setTimeout(r, 200)); }
            let scripts = Array.from(self.debugger.knownScripts.values()).filter(s => s.url && !s.url.startsWith('chrome-extension://'));
            if (search) scripts = scripts.filter(s => s.url.toLowerCase().includes(search));
            scripts = scripts.slice(0, 50);
            if (scripts.length === 0) return 'No scripts found.';
            return `Scripts (${scripts.length}):\n${scripts.map(s => `  [${s.scriptId}] ${s.url}`).join('\n')}`;
          }
          case 'get_source': {
            const scriptId = opts.scriptId as string;
            if (!scriptId) return 'Error: get_source requires scriptId';
            if (!self.debugger.enabled) { await relayCdp('Debugger.enable'); self.debugger.enabled = true; }
            const result = await relayCdp('Debugger.getScriptSource', { scriptId }) as any;
            let source = result?.scriptSource || '(empty)';
            const lineStart = opts.line_start as number | undefined;
            const lineEnd = opts.line_end as number | undefined;
            if (lineStart || lineEnd) {
              const srcLines = source.split('\n');
              const start = Math.max(1, lineStart || 1) - 1;
              const end = Math.min(srcLines.length, lineEnd || srcLines.length);
              source = srcLines.slice(start, end).map((l: string, i: number) => `${(start + i + 1).toString().padStart(5)}| ${l}`).join('\n');
            } else if (source.length > 50000) {
              source = source.slice(0, 50000) + `\n[Truncated to 50000 chars. Use line_start/line_end for specific ranges.]`;
            }
            return source;
          }
          case 'edit_source': {
            const scriptId = opts.scriptId as string;
            const content = opts.content as string;
            if (!scriptId || !content) return 'Error: edit_source requires scriptId and content';
            if (!self.debugger.enabled) { await relayCdp('Debugger.enable'); self.debugger.enabled = true; }
            try {
              await relayCdp('Debugger.setScriptSource', { scriptId, scriptSource: content });
              return `Script ${scriptId} updated (hot-reload applied).`;
            } catch (e) {
              const fb = await evaluateJs(`try { const s = document.createElement('script'); s.textContent = ${JSON.stringify(content)}; document.head.appendChild(s); 'Script injected via DOM.' } catch(e) { 'Fallback failed: ' + e.message }`);
              return `setScriptSource failed (${String(e)}). Fallback: ${fb}`;
            }
          }
          case 'search_source': {
            const search = opts.search as string;
            if (!search) return 'Error: search_source requires search string';
            if (!self.debugger.enabled) { await relayCdp('Debugger.enable'); self.debugger.enabled = true; await new Promise(r => setTimeout(r, 200)); }
            const scripts = Array.from(self.debugger.knownScripts.values()).filter(s => s.url && !s.url.startsWith('chrome-extension://'));
            const matches: string[] = [];
            for (const s of scripts.slice(0, 30)) {
              try {
                const result = await relayCdp('Debugger.searchInContent', { scriptId: s.scriptId, query: search }) as any;
                if (result?.result?.length) {
                  matches.push(`${s.url} (${result.result.length} matches):`);
                  for (const m of result.result.slice(0, 5)) matches.push(`  L${m.lineNumber + 1}: ${m.lineContent.trim().slice(0, 120)}`);
                  if (result.result.length > 5) matches.push(`  ... and ${result.result.length - 5} more`);
                }
              } catch { /* skip */ }
            }
            return matches.length > 0 ? `Search results for "${search}":\n${matches.join('\n')}` : `No results for "${search}" in loaded scripts.`;
          }
          default:
            return `Unknown editor action: ${action}`;
        }
      },

      // --- Page content ---
      pageContent: async (action: string, options?: { selector?: string; max_length?: number; search?: string; include_styles?: boolean }) => {
        const selector = options?.selector || 'body';
        const maxLength = options?.max_length || 50000;
        switch (action) {
          case 'get_html': {
            const includeStyles = options?.include_styles ?? false;
            const code = includeStyles
              ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || '(element not found)'`
              : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return '(element not found)'; const clone = el.cloneNode(true); clone.querySelectorAll('[style]').forEach(e => e.removeAttribute('style')); clone.querySelectorAll('script,noscript').forEach(e => e.remove()); return clone.outerHTML; })()`;
            let html = await evaluateJs(code) as string;
            if (html.length > maxLength) html = html.slice(0, maxLength) + `\n[Truncated to ${maxLength} chars]`;
            return html;
          }
          case 'get_text': {
            const code = `document.querySelector(${JSON.stringify(selector)})?.innerText || '(element not found)'`;
            let text = await evaluateJs(code) as string;
            if (text.length > maxLength) text = text.slice(0, maxLength) + `\n[Truncated to ${maxLength} chars]`;
            return text;
          }
          case 'get_metadata': {
            const code = `JSON.stringify({ title: document.title, url: location.href, description: document.querySelector('meta[name="description"]')?.content || null, charset: document.characterSet, lang: document.documentElement.lang || null, viewport: document.querySelector('meta[name="viewport"]')?.content || null, ogTitle: document.querySelector('meta[property="og:title"]')?.content || null, ogDescription: document.querySelector('meta[property="og:description"]')?.content || null, ogImage: document.querySelector('meta[property="og:image"]')?.content || null, canonical: document.querySelector('link[rel="canonical"]')?.href || null, favicon: document.querySelector('link[rel="icon"]')?.href || document.querySelector('link[rel="shortcut icon"]')?.href || null, scripts: document.querySelectorAll('script[src]').length, stylesheets: document.querySelectorAll('link[rel="stylesheet"]').length, images: document.querySelectorAll('img').length, links: document.querySelectorAll('a[href]').length })`;
            const raw = await evaluateJs(code);
            const meta = typeof raw === 'string' ? JSON.parse(raw) : {};
            const lines = Object.entries(meta).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `  ${k}: ${v}`);
            return `Page Metadata:\n${lines.join('\n')}`;
          }
          case 'search_dom': {
            const search = options?.search;
            if (!search) return 'Error: search_dom requires search string';
            const code = `(() => { const results = []; const walker = document.createTreeWalker(document.querySelector(${JSON.stringify(selector)}) || document.body, NodeFilter.SHOW_ELEMENT); const needle = ${JSON.stringify(search.toLowerCase())}; while (walker.nextNode()) { const el = walker.currentNode; const tag = el.tagName.toLowerCase(); const id = el.id ? '#' + el.id : ''; const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : ''; const text = (el.textContent || '').slice(0, 200).trim(); const attrs = Array.from(el.attributes).map(a => a.name + '="' + a.value + '"').join(' '); const match = tag.includes(needle) || id.toLowerCase().includes(needle) || cls.toLowerCase().includes(needle) || text.toLowerCase().includes(needle) || attrs.toLowerCase().includes(needle); if (match) { results.push('<' + tag + id + cls + '> ' + text.slice(0, 100)); if (results.length >= 50) break; } } return JSON.stringify(results); })()`;
            const raw = await evaluateJs(code);
            const results: string[] = typeof raw === 'string' ? JSON.parse(raw) : [];
            if (results.length === 0) return `No elements found matching "${search}".`;
            return `DOM search for "${search}" (${results.length} results):\n${results.map(r => `  ${r}`).join('\n')}`;
          }
          default:
            return `Unknown page_content action: ${action}`;
        }
      },

      // --- Interact (by @ref) ---
      interact: async (ref: number, action: string, value?: string) => {
        const targetId = (page as any)._guid || 'default';
        const refCache = self.getRefCache(targetId);
        const cached = refCache.get(ref);

        if (cached && cdpSession) {
          const resolved = await sendCdpCmd('DOM.resolveNode', { backendNodeId: cached.backendDOMNodeId }, 10000) as any;
          const objectId = resolved?.object?.objectId;
          if (!objectId) return formatError({ error: `Could not resolve @${ref} to a live DOM node`, hint: 'The element may have been removed. Rerun snapshot() for fresh refs.' });

          const boxModel = await sendCdpCmd('DOM.getBoxModel', { backendNodeId: cached.backendDOMNodeId }, 10000) as any;
          const b = boxModel?.model?.border;
          const cx = b ? (Math.min(b[0], b[2], b[4], b[6]) + Math.max(b[0], b[2], b[4], b[6])) / 2 : 0;
          const cy = b ? (Math.min(b[1], b[3], b[5], b[7]) + Math.max(b[1], b[3], b[5], b[7])) / 2 : 0;

          switch (action) {
            case 'click':
              await sendCdpCmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 }, 10000);
              await sendCdpCmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 }, 10000);
              break;
            case 'hover':
              await sendCdpCmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy }, 10000);
              break;
            case 'fill':
              await sendCdpCmd('Runtime.callFunctionOn', { objectId, functionDeclaration: `function(v) { this.focus(); this.value = v; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }`, arguments: [{ value: value ?? '' }] }, 10000);
              break;
            case 'focus':
              await sendCdpCmd('DOM.focus', { backendNodeId: cached.backendDOMNodeId }, 10000);
              break;
            case 'check':
            case 'uncheck':
              await sendCdpCmd('Runtime.callFunctionOn', { objectId, functionDeclaration: `function(checked) { if (this.checked !== checked) { this.checked = checked; this.dispatchEvent(new Event('change', { bubbles: true })); } }`, arguments: [{ value: action === 'check' }] }, 10000);
              break;
            case 'select':
              if (!value) return formatError({ error: 'Missing value for select action', hint: 'Provide a value parameter' });
              await sendCdpCmd('Runtime.callFunctionOn', { objectId, functionDeclaration: `function(v) { this.value = v; this.dispatchEvent(new Event('change', { bubbles: true })); }`, arguments: [{ value }] }, 10000);
              break;
            default:
              return formatError({ error: `Unknown action: ${action}`, hint: 'Valid: click, hover, fill, focus, check, uncheck, select' });
          }
          return `Performed ${action} on @${ref} [${cached.role}]${cached.name ? ` "${cached.name}"` : ''}`;
        }

        if (cached) {
          const role = cached.role;
          const name = cached.name;
          const roleToSelector: Record<string, string> = {
            link: 'a', button: 'button', textbox: 'input[type="text"],input[type="search"],input[type="email"],input[type="url"],input[type="tel"],input[type="password"],input:not([type]),textarea',
            checkbox: 'input[type="checkbox"]', radio: 'input[type="radio"]', combobox: 'select',
            menuitem: '[role="menuitem"]', tab: '[role="tab"]', switch: '[role="switch"]',
            slider: 'input[type="range"]', spinbutton: 'input[type="number"]', searchbox: 'input[type="search"]',
          };
          const sel = roleToSelector[role] || `[role="${role}"]`;
          const interactCode = `(function() {
            var sels = ${JSON.stringify(sel)}.split(',');
            var name = ${JSON.stringify(name)};
            var action = ${JSON.stringify(action)};
            var value = ${JSON.stringify(value ?? '')};
            var el = null;
            for (var i = 0; i < sels.length; i++) {
              var candidates = document.querySelectorAll(sels[i].trim());
              for (var j = 0; j < candidates.length; j++) {
                var c = candidates[j];
                var text = (c.textContent || c.getAttribute('aria-label') || c.getAttribute('title') || c.getAttribute('placeholder') || c.value || '').trim();
                if (!name || text.toLowerCase().indexOf(name.toLowerCase()) !== -1) { el = c; break; }
              }
              if (el) break;
            }
            if (!el) return 'NOT_FOUND';
            switch (action) {
              case 'click': el.click(); return 'OK';
              case 'hover': el.dispatchEvent(new MouseEvent('mouseover', {bubbles:true})); el.dispatchEvent(new MouseEvent('mouseenter', {bubbles:true})); return 'OK';
              case 'fill': el.focus(); el.value = value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';
              case 'focus': el.focus(); return 'OK';
              case 'check': if (!el.checked) el.click(); return 'OK';
              case 'uncheck': if (el.checked) el.click(); return 'OK';
              case 'select': el.value = value; el.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';
              default: return 'UNKNOWN_ACTION';
            }
          })()`;
          const result = await evaluateJs(interactCode);
          if (result === 'NOT_FOUND') return formatError({ error: `Element not found for @${ref} [${role}] "${name}"`, hint: 'Run snapshot() to refresh refs' });
          if (result === 'UNKNOWN_ACTION') return formatError({ error: `Unknown action: ${action}`, hint: 'Valid: click, hover, fill, focus, check, uncheck, select' });
          return `Performed ${action} on @${ref} [${cached.role}]${cached.name ? ` "${cached.name}"` : ''} (via page.evaluate)`;
        }

        return formatError({ error: `Ref @${ref} not found`, hint: 'Run snapshot() first to get fresh @ref numbers' });
      },

      // --- Clear cache and reload ---
      clearCacheAndReload: async (options?: { clear?: string; reload?: boolean; origin?: string }) => {
        const clearArg = options?.clear;
        const shouldReload = options?.reload !== false;
        let clearTypes: Set<string>;
        if (clearArg) {
          const raw = clearArg.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
          clearTypes = new Set(raw.includes('all')
            ? ['cache', 'cookies', 'local_storage', 'session_storage', 'cache_storage', 'indexeddb', 'service_workers']
            : raw);
        } else {
          clearTypes = new Set<string>();
        }
        const origin = options?.origin || await evaluateJs('window.location.origin') as string;
        const cleared: string[] = [];
        let needsIgnoreCache = false;

        if (clearTypes.has('cache')) { needsIgnoreCache = true; cleared.push('cache (per-tab bypass via ignoreCache reload)'); }

        if (clearTypes.has('cookies')) {
          if (cdpSession) {
            const cookieResult = await sendCdpCmd('Network.getCookies') as any;
            const originHost = new URL(origin).hostname;
            const matching = (cookieResult?.cookies || []).filter((c: any) => {
              const isDotPrefixed = c.domain.startsWith('.');
              const cd = isDotPrefixed ? c.domain.slice(1) : c.domain;
              if (isDotPrefixed && !originHost.includes('.')) return false;
              return originHost === cd || originHost.endsWith('.' + cd);
            });
            for (const c of matching) await sendCdpCmd('Network.deleteCookies', { name: c.name, domain: c.domain });
            cleared.push(`cookies (${origin}, ${matching.length} removed)`);
          } else {
            const originHost = new URL(origin).hostname;
            const allCookies = await page.context().cookies();
            const matching = allCookies.filter((c: any) => {
              const cd = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
              return originHost === cd || originHost.endsWith('.' + cd);
            });
            for (const c of matching) await page.context().clearCookies({ name: c.name, domain: c.domain });
            cleared.push(`cookies (${origin}, ${matching.length} removed via Playwright)`);
          }
        }

        if (cdpSession) {
          const storageParts: string[] = [];
          if (clearTypes.has('local_storage')) storageParts.push('local_storage');
          if (clearTypes.has('session_storage')) storageParts.push('session_storage');
          if (clearTypes.has('cache_storage')) storageParts.push('cache_storage');
          if (clearTypes.has('indexeddb')) storageParts.push('indexeddb');
          if (clearTypes.has('service_workers')) storageParts.push('service_workers');
          if (storageParts.length > 0) {
            await sendCdpCmd('Storage.clearDataForOrigin', { origin, storageTypes: storageParts.join(',') });
            cleared.push(`${storageParts.join(', ')} (${origin})`);
          }
        } else {
          if (clearTypes.has('local_storage')) { await evaluateJs('localStorage.clear()'); cleared.push('local_storage'); }
          if (clearTypes.has('session_storage')) { await evaluateJs('sessionStorage.clear()'); cleared.push('session_storage'); }
          if (clearTypes.has('cache_storage')) {
            await evaluateJs('caches.keys().then(k => Promise.all(k.map(c => caches.delete(c))))');
            cleared.push('cache_storage');
          }
          if (clearTypes.has('indexeddb')) cleared.push('indexeddb (requires CDP)');
          if (clearTypes.has('service_workers')) {
            await evaluateJs("navigator.serviceWorker.getRegistrations().then(regs => Promise.all(regs.map(r => r.unregister())))");
            cleared.push('service_workers');
          }
        }

        if (shouldReload || needsIgnoreCache) {
          if (cdpSession) {
            await sendCdpCmd('Page.reload', { ignoreCache: needsIgnoreCache }, getCommandTimeout('Page.reload'));
          } else {
            await page.evaluate('window.location.reload()');
          }
          await new Promise(r => setTimeout(r, 2000));
          cleared.push(needsIgnoreCache ? 'page reloaded (cache bypassed)' : 'page reloaded');
        }
        return cleared.length > 0 ? `Cleared: ${cleared.join('; ')}` : 'No storage cleared';
      },

      // --- Navigate ---
      navigate: async (url: string) => {
        if (cdpSession) {
          await sendCdpCmd('Page.navigate', { url }, getCommandTimeout('Page.navigate'));
        } else {
          await page.evaluate(`window.location.href = ${JSON.stringify(url)}`);
        }
        await new Promise(r => setTimeout(r, 2000));
        return `Navigated to ${url}`;
      },

      ensureFreshRender: async () => {
        if (cdpSession) {
          await sendCdpCmd('Page.reload', { ignoreCache: true }, getCommandTimeout('Page.reload'));
        } else {
          await page.evaluate('window.location.reload()');
        }
        await new Promise(r => setTimeout(r, 2000));
        return 'Page reloaded with fresh cache';
      },

      // --- Reset (callable from VM) ---
      resetPlaywright: async () => {
        await self.reset();
        return 'Playwright connection reset.';
      },

      // --- CDP session ---
      getCDPSession: () => cdpSession,
    };

    // Alias: accessibilitySnapshot === snapshot
    globals.accessibilitySnapshot = globals.snapshot;

    // Sandboxed require and import (matches upstream playwriter)
    globals.require = self.sandboxedRequire;
    globals.import = (specifier: string) => import(specifier);

    return globals;
  }

  // -----------------------------------------------------------------------
  // Ref cache management
  // -----------------------------------------------------------------------

  private getRefCache(targetId: string): Map<number, RefInfo> {
    if (!this.refCacheByTab.has(targetId)) {
      this.refCacheByTab.set(targetId, new Map());
    }
    return this.refCacheByTab.get(targetId)!;
  }

  // -----------------------------------------------------------------------
  // Handle debugger events from CDP
  // -----------------------------------------------------------------------

  handleDebuggerEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Debugger.paused': {
        this.debugger.paused = true;
        const callFrames = params.callFrames as Array<{ callFrameId: string }> | undefined;
        this.debugger.currentCallFrameId = callFrames?.[0]?.callFrameId ?? null;
        break;
      }
      case 'Debugger.resumed':
        this.debugger.paused = false;
        this.debugger.currentCallFrameId = null;
        break;
      case 'Debugger.scriptParsed': {
        const url = params.url as string | undefined;
        const scriptId = params.scriptId as string | undefined;
        if (url && scriptId && !url.startsWith('chrome') && !url.startsWith('devtools')) {
          this.debugger.knownScripts.set(scriptId, { scriptId, url });
        }
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Reset / status
  // -----------------------------------------------------------------------

  async reset(): Promise<void> {
    this.userState = {};
    this.networkMonitor.clearAll();
    this.debugger = createDebuggerState();
    this.lastSnapshot = null;
    this.refCacheByTab.clear();
    this.savedOverrides = {};
    await this.closeQuietly();
  }

  getStatus(): { connected: boolean; stateKeys: string[] } {
    return {
      connected: this.isConnected,
      stateKeys: Object.keys(this.userState),
    };
  }

  getNetworkMonitor(): NetworkMonitor {
    return this.networkMonitor;
  }

  private clearConnectionState() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isConnected = false;
  }

  private async closeQuietly(): Promise<void> {
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
    }
    this.clearConnectionState();
  }

  static formatConsoleLogs(logs: Array<{ method: string; args: unknown[] }>, prefix = 'Console output'): string {
    if (logs.length === 0) return '';
    let text = `${prefix}:\n`;
    for (const { method, args } of logs) {
      const formattedArgs = args.map(arg =>
        typeof arg === 'string' ? arg : util.inspect(arg, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000, breakLength: 80 })
      ).join(' ');
      text += `[${method}] ${formattedArgs}\n`;
    }
    return text + '\n';
  }
}

// ---------------------------------------------------------------------------
// ExecutorManager — manages multiple executor instances by session ID
// ---------------------------------------------------------------------------

export class ExecutorManager {
  private executors = new Map<string, PlaywrightExecutor>();
  private maxSessions: number;
  private logger?: ExecutorLogger;
  private relaySendCdp?: RelayCdpSender;

  constructor(options?: { maxSessions?: number; logger?: ExecutorLogger; relaySendCdp?: RelayCdpSender }) {
    this.maxSessions = options?.maxSessions ?? 5;
    this.logger = options?.logger;
    this.relaySendCdp = options?.relaySendCdp;
  }

  getOrCreate(sessionId: string): PlaywrightExecutor {
    let executor = this.executors.get(sessionId);
    if (!executor) {
      if (this.executors.size >= this.maxSessions) {
        throw new Error(
          `Playwright executor limit reached (${this.maxSessions}). ` +
          `Active sessions: ${Array.from(this.executors.keys()).join(', ')}. ` +
          `Delete an existing session first.`,
        );
      }
      executor = new PlaywrightExecutor(this.logger);
      if (this.relaySendCdp) executor.relaySendCdp = this.relaySendCdp;
      this.executors.set(sessionId, executor);
    }
    return executor;
  }

  get(sessionId: string): PlaywrightExecutor | null {
    return this.executors.get(sessionId) ?? null;
  }

  async remove(sessionId: string): Promise<boolean> {
    const executor = this.executors.get(sessionId);
    if (executor) {
      await executor.reset();
      return this.executors.delete(sessionId);
    }
    return false;
  }

  listSessions(): Array<{ id: string; connected: boolean; stateKeys: string[] }> {
    return Array.from(this.executors.entries()).map(([id, executor]) => ({
      id,
      ...executor.getStatus(),
    }));
  }

  async resetAll(): Promise<void> {
    const resets = Array.from(this.executors.values()).map(e => e.reset().catch(() => {}));
    await Promise.all(resets);
    this.executors.clear();
  }

  get size(): number {
    return this.executors.size;
  }
}
