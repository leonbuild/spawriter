import { chromium } from 'playwright-core';
import * as vm from 'node:vm';
import * as util from 'node:util';
import { getCdpUrl, getRelayPort, log, error } from './utils.js';
export class CodeExecutionTimeoutError extends Error {
    constructor(timeout) {
        super(`Code execution timed out after ${timeout}ms`);
        this.name = 'CodeExecutionTimeoutError';
    }
}
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
};
/**
 * Parse code and check if it's a single expression that should be auto-returned.
 * Returns the expression source or null. Uses async-function heuristic to handle
 * `await` expressions: wraps in `async function` before testing compilability.
 */
export function getAutoReturnExpression(code) {
    const trimmed = code.replace(/;+\s*$/, '').trim();
    if (!trimmed)
        return null;
    if (/^\s*(const|let|var|function|class|if|for|while|do|switch|try|throw|import|export)\b/.test(trimmed))
        return null;
    if (/^\s*return\b/.test(trimmed))
        return null;
    const lines = trimmed.split('\n');
    if (lines.length > 1) {
        for (const line of lines) {
            const stripped = line.trim();
            if (stripped.endsWith(';') || stripped.endsWith('{') || stripped.endsWith('}'))
                return null;
        }
    }
    try {
        new Function(`return async function() { return (${trimmed}) }`);
        return trimmed;
    }
    catch {
        return null;
    }
}
export function wrapCode(code) {
    const expr = getAutoReturnExpression(code);
    if (expr !== null) {
        return `(async () => { return await (${expr}) })()`;
    }
    return `(async () => { ${code} })()`;
}
export class PlaywrightExecutor {
    browser = null;
    context = null;
    page = null;
    userState = {};
    isConnected = false;
    activeAbortController = null;
    async ensureConnection() {
        if (this.isConnected && this.browser && this.page && !this.page.isClosed()) {
            return { page: this.page, context: this.context };
        }
        await this.closeQuietly();
        const port = getRelayPort();
        const clientId = `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const cdpUrl = getCdpUrl(port, clientId);
        log('Connecting Playwright over CDP:', cdpUrl);
        const browser = await Promise.race([
            chromium.connectOverCDP(cdpUrl),
            new Promise((_, reject) => setTimeout(() => reject(new Error('CDP connection timeout (15s)')), 15000)),
        ]);
        browser.on('disconnected', () => {
            log('Playwright browser disconnected');
            this.clearConnectionState();
        });
        const contexts = browser.contexts();
        const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
        context.setDefaultTimeout(30000);
        context.setDefaultNavigationTimeout(15000);
        const pages = context.pages().filter(p => !p.isClosed());
        const page = pages.length > 0 ? pages[0] : await context.newPage();
        try {
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
        }
        catch {
            // Best-effort stabilization: the page may already be in a valid state.
        }
        this.browser = browser;
        this.context = context;
        this.page = page;
        this.isConnected = true;
        return { page, context };
    }
    cancelActiveExecution() {
        if (this.activeAbortController) {
            this.activeAbortController.abort();
            this.activeAbortController = null;
        }
    }
    async execute(code, timeout = 30000, retryOnContextError = true) {
        const consoleLogs = [];
        this.cancelActiveExecution();
        const abortController = new AbortController();
        this.activeAbortController = abortController;
        let timeoutHandle = null;
        try {
            const { page, context } = await this.ensureConnection();
            const prevDefaultTimeout = 30000;
            page.setDefaultTimeout(Math.min(timeout, prevDefaultTimeout));
            page.setDefaultNavigationTimeout(Math.min(timeout, 15000));
            const customConsole = {
                log: (...args) => consoleLogs.push({ method: 'log', args }),
                info: (...args) => consoleLogs.push({ method: 'info', args }),
                warn: (...args) => consoleLogs.push({ method: 'warn', args }),
                error: (...args) => consoleLogs.push({ method: 'error', args }),
                debug: (...args) => consoleLogs.push({ method: 'debug', args }),
            };
            // Warm up execution context. Some CDP flows emit a transient
            // "Execution context was destroyed" right after connect/navigation.
            try {
                await Promise.race([
                    page.evaluate('1'),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Warmup timeout')), 3000)),
                ]);
            }
            catch {
                // Best-effort warmup only; user code execution below has full error handling.
            }
            const vmContextObj = {
                page,
                context,
                state: this.userState,
                console: customConsole,
                ...usefulGlobals,
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
                    timeoutHandle = setTimeout(() => {
                        reject(new CodeExecutionTimeoutError(timeout));
                    }, timeout);
                }),
                new Promise((_, reject) => {
                    abortController.signal.addEventListener('abort', () => reject(new CodeExecutionTimeoutError(timeout)));
                }),
            ]);
            if (timeoutHandle)
                clearTimeout(timeoutHandle);
            page.setDefaultTimeout(prevDefaultTimeout);
            page.setDefaultNavigationTimeout(15000);
            let responseText = PlaywrightExecutor.formatConsoleLogs(consoleLogs);
            if (hasExplicitReturn && result !== undefined) {
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
                finalText = finalText.slice(0, MAX_LENGTH)
                    + `\n\n[Truncated to ${MAX_LENGTH} characters]`;
            }
            return { text: finalText, isError: false };
        }
        catch (err) {
            if (timeoutHandle)
                clearTimeout(timeoutHandle);
            const e = err;
            const isTimeoutError = e instanceof CodeExecutionTimeoutError
                || e.name === 'TimeoutError'
                || e.name === 'AbortError';
            const isRecoverableContextError = /Execution context was destroyed/i.test(e.message)
                || /Cannot find context with specified id/i.test(e.message);
            if (retryOnContextError && isRecoverableContextError) {
                log('Playwright execution context stale, retrying once...');
                await new Promise(resolve => setTimeout(resolve, 150));
                return this.execute(code, timeout, false);
            }
            error('Error in playwright execute:', e.stack || e.message);
            if (isTimeoutError) {
                try {
                    if (this.page && !this.page.isClosed()) {
                        await Promise.race([
                            this.page.evaluate('1'),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('post-timeout check')), 3000)),
                        ]).catch(() => { });
                    }
                }
                catch { /* ignore */ }
            }
            const logsText = PlaywrightExecutor.formatConsoleLogs(consoleLogs, 'Console output (before error)');
            const resetHint = isTimeoutError
                ? '\n\n[HINT: Execution timed out. The operation may still be running in the browser. Use reset if the browser is in a bad state.]'
                : '\n\n[HINT: If this is a Playwright connection error, call reset to reconnect.]';
            const errorText = isTimeoutError ? e.message : (e.stack || e.message);
            return {
                text: `${logsText}\nError executing code: ${errorText}${resetHint}`,
                isError: true,
            };
        }
        finally {
            if (this.activeAbortController === abortController) {
                this.activeAbortController = null;
            }
        }
    }
    async reset() {
        this.userState = {};
        await this.closeQuietly();
    }
    getStatus() {
        return {
            connected: this.isConnected,
            stateKeys: Object.keys(this.userState),
        };
    }
    clearConnectionState() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isConnected = false;
    }
    async closeQuietly() {
        if (this.browser) {
            try {
                await this.browser.close();
            }
            catch { /* ignore */ }
        }
        this.clearConnectionState();
    }
    static formatConsoleLogs(logs, prefix = 'Console output') {
        if (logs.length === 0)
            return '';
        let text = `${prefix}:\n`;
        for (const { method, args } of logs) {
            const formattedArgs = args.map(arg => typeof arg === 'string' ? arg : util.inspect(arg, { depth: 4, colors: false, maxArrayLength: 100, maxStringLength: 1000, breakLength: 80 })).join(' ');
            text += `[${method}] ${formattedArgs}\n`;
        }
        return text + '\n';
    }
}
/**
 * Manages multiple PlaywrightExecutor instances keyed by session ID.
 * Each session has its own browser connection and persistent state.
 */
export class ExecutorManager {
    executors = new Map();
    maxSessions;
    constructor(maxSessions = 5) {
        this.maxSessions = maxSessions;
    }
    getOrCreate(sessionId) {
        let executor = this.executors.get(sessionId);
        if (!executor) {
            if (this.executors.size >= this.maxSessions) {
                const oldest = this.executors.keys().next().value;
                const oldExecutor = this.executors.get(oldest);
                oldExecutor.reset().catch(() => { });
                this.executors.delete(oldest);
            }
            executor = new PlaywrightExecutor();
            this.executors.set(sessionId, executor);
        }
        return executor;
    }
    get(sessionId) {
        return this.executors.get(sessionId) ?? null;
    }
    async remove(sessionId) {
        const executor = this.executors.get(sessionId);
        if (executor) {
            await executor.reset();
            return this.executors.delete(sessionId);
        }
        return false;
    }
    listSessions() {
        return Array.from(this.executors.entries()).map(([id, executor]) => ({
            id,
            ...executor.getStatus(),
        }));
    }
    async resetAll() {
        const resets = Array.from(this.executors.values()).map(e => e.reset().catch(() => { }));
        await Promise.all(resets);
        this.executors.clear();
    }
    get size() {
        return this.executors.size;
    }
}
//# sourceMappingURL=pw-executor.js.map