import { type BrowserContext, type Page } from 'playwright-core';
export declare class CodeExecutionTimeoutError extends Error {
    constructor(timeout: number);
}
export interface ExecuteResult {
    text: string;
    isError: boolean;
}
/**
 * Parse code and check if it's a single expression that should be auto-returned.
 * Returns the expression source or null. Uses async-function heuristic to handle
 * `await` expressions: wraps in `async function` before testing compilability.
 */
export declare function getAutoReturnExpression(code: string): string | null;
export declare function wrapCode(code: string): string;
export declare class PlaywrightExecutor {
    private browser;
    private context;
    private page;
    private userState;
    private isConnected;
    private activeAbortController;
    ensureConnection(): Promise<{
        page: Page;
        context: BrowserContext;
    }>;
    cancelActiveExecution(): void;
    execute(code: string, timeout?: number): Promise<ExecuteResult>;
    reset(): Promise<void>;
    getStatus(): {
        connected: boolean;
        stateKeys: string[];
    };
    private clearConnectionState;
    private closeQuietly;
    static formatConsoleLogs(logs: Array<{
        method: string;
        args: unknown[];
    }>, prefix?: string): string;
}
/**
 * Manages multiple PlaywrightExecutor instances keyed by session ID.
 * Each session has its own browser connection and persistent state.
 */
export declare class ExecutorManager {
    private executors;
    private maxSessions;
    constructor(maxSessions?: number);
    getOrCreate(sessionId: string): PlaywrightExecutor;
    get(sessionId: string): PlaywrightExecutor | null;
    remove(sessionId: string): Promise<boolean>;
    listSessions(): Array<{
        id: string;
        connected: boolean;
        stateKeys: string[];
    }>;
    resetAll(): Promise<void>;
    get size(): number;
}
//# sourceMappingURL=pw-executor.d.ts.map