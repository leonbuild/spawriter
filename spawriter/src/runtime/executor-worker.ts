/**
 * Executor Worker — per-execute child process (W11 §9.1/§16.6).
 *
 * Spawned by ExecutorSupervisor for each user code execution.
 * Connects to Chrome via CDP (through the relay's /cdp proxy),
 * runs user code with full Playwright + VM globals, and returns
 * results via IPC. Exits after one execution (per-execute model).
 */

import { WorkerIpcCodec, type WorkerMessage, type InitPayload, type ExecutePayload, type ResultPayload } from './worker-ipc.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkerExecuteResult {
  requestId: string;
  success: boolean;
  value?: {
    text: string;
    images: Array<{ data: string; mimeType: string }>;
    screenshots: Array<{ path: string; base64: string; mimeType: string; snapshot: string; labelCount: number }>;
    isError: boolean;
  };
  error?: { code: string; message: string; stack?: string };
  stateCandidate?: Record<string, unknown>;
  stateRevision?: number;
}

// ─── Worker State ────────────────────────────────────────────────────────────

const codec = new WorkerIpcCodec();
let initPayload: InitPayload | null = null;
let currentState: Record<string, unknown> = {};
let stateRevision = 0;
let executing = false;

// Lazily loaded PlaywrightExecutor — only imported when actually executing.
// This avoids the import overhead when the worker module is loaded for testing.
let PlaywrightExecutorClass: any = null;

async function getPlaywrightExecutor(): Promise<any> {
  if (!PlaywrightExecutorClass) {
    const mod = await import('../pw-executor.js');
    PlaywrightExecutorClass = mod.PlaywrightExecutor;
  }
  return PlaywrightExecutorClass;
}

// ─── IPC Helpers ─────────────────────────────────────────────────────────────

function sendToRelay(msg: WorkerMessage): void {
  if (process.send) {
    process.send(codec.encode(msg));
  }
}

function sendReady(): void {
  sendToRelay({
    kind: 'ready',
    id: 'ready-0',
    sessionId: initPayload?.sessionId ?? '',
    executeEpoch: initPayload?.executeEpoch ?? 0,
    payload: { pid: process.pid },
  });
}

function sendResult(requestId: string, result: ResultPayload): void {
  // Enforce IPC size limits (§16.6): validate result and state before sending.
  const validation = codec.validateResult(result);
  if (!validation.valid) {
    sendToRelay({
      kind: 'result',
      id: requestId,
      sessionId: initPayload?.sessionId ?? '',
      executeEpoch: initPayload?.executeEpoch ?? 0,
      payload: {
        requestId,
        success: false,
        error: { code: 'RESULT_LIMIT', message: validation.error ?? 'Result exceeds IPC size limit' },
      } satisfies ResultPayload,
    });
    return;
  }

  if (result.stateCandidate && !codec.validateStateSize(result.stateCandidate)) {
    result = {
      ...result,
      stateCandidate: undefined,
      error: { code: 'STATE_LIMIT', message: 'State exceeds 256 KiB IPC limit; previous checkpoint preserved' },
    };
  }

  const msg: WorkerMessage = {
    kind: 'result',
    id: requestId,
    sessionId: initPayload?.sessionId ?? '',
    executeEpoch: initPayload?.executeEpoch ?? 0,
    payload: result,
  };

  const encoded = codec.encode(msg);
  if (!encoded) {
    // Entire message too large — send error without payload.
    sendToRelay({
      kind: 'result',
      id: requestId,
      sessionId: initPayload?.sessionId ?? '',
      executeEpoch: initPayload?.executeEpoch ?? 0,
      payload: {
        requestId,
        success: false,
        error: { code: 'RESULT_LIMIT', message: 'Full result exceeds 16 MiB IPC wire limit' },
      } satisfies ResultPayload,
    });
    return;
  }

  if (process.send) {
    process.send(encoded);
  }
}

function sendLog(message: string): void {
  sendToRelay({
    kind: 'log',
    id: `log-${Date.now()}`,
    sessionId: initPayload?.sessionId ?? '',
    executeEpoch: initPayload?.executeEpoch ?? 0,
    payload: { level: 'info', message, timestamp: Date.now() },
  });
}

function sendError(code: string, message: string): void {
  sendToRelay({
    kind: 'error',
    id: `error-${Date.now()}`,
    sessionId: initPayload?.sessionId ?? '',
    executeEpoch: initPayload?.executeEpoch ?? 0,
    payload: { code, message },
  });
}

// ─── Execution via PlaywrightExecutor ────────────────────────────────────────

async function executeWithPlaywright(payload: ExecutePayload): Promise<WorkerExecuteResult> {
  const { code, timeoutMs, requestId } = payload;

  try {
    const PwExecutor = await getPlaywrightExecutor();
    const executor = new PwExecutor(
      { log: (...a: unknown[]) => sendLog(a.map(String).join(' ')),
        error: (...a: unknown[]) => sendLog('[ERROR] ' + a.map(String).join(' ')) },
    );

    // Inject user state.
    executor.setUserState({ ...currentState });

    // Claim the tab so ensureConnection finds the right page.
    if (initPayload?.targetInfo?.tabId) {
      executor.claimTab(
        initPayload.targetInfo.tabId,
        initPayload.targetInfo.url || undefined,
        initPayload.targetInfo.targetId || undefined,
      );
    }

    // Run the user code — PlaywrightExecutor handles CDP connection,
    // VM sandbox with all globals, screenshots, snapshots, etc.
    const result = await executor.execute(code, timeoutMs);

    // Read updated state.
    const newState = executor.getUserState();

    // Disconnect from Chrome (best-effort cleanup).
    try { await executor.reset(); } catch { /* ok */ }

    return {
      requestId,
      success: !result.isError,
      value: {
        text: result.text,
        images: result.images,
        screenshots: result.screenshots,
        isError: result.isError,
      },
      stateCandidate: newState,
      stateRevision: stateRevision + 1,
    };
  } catch (err: any) {
    return {
      requestId,
      success: false,
      error: {
        code: err.code ?? 'EXECUTION_ERROR',
        message: err.message,
        stack: err.stack,
      },
    };
  }
}

// ─── Fallback sandbox execution (no Playwright) ─────────────────────────────

async function executeCode(payload: ExecutePayload): Promise<ResultPayload> {
  const { code, timeoutMs, requestId } = payload;

  try {
    const vm = await import('node:vm');

    const sandbox: Record<string, unknown> = {
      state: { ...currentState },
      console: {
        log: (...args: unknown[]) => sendLog(args.map(String).join(' ')),
        error: (...args: unknown[]) => sendLog('[ERROR] ' + args.map(String).join(' ')),
        warn: (...args: unknown[]) => sendLog('[WARN] ' + args.map(String).join(' ')),
      },
      setTimeout,
      clearTimeout,
      Promise,
      Date,
      JSON,
      Math,
    };

    const context = vm.createContext(sandbox);
    const script = new vm.Script(`(async () => { ${code} })()`, {
      filename: `execute-${requestId}.js`,
    });

    const result = await script.runInContext(context, { timeout: timeoutMs });
    const stateCandidate = sandbox.state as Record<string, unknown>;

    return {
      requestId,
      success: true,
      value: result,
      stateCandidate,
      stateRevision: stateRevision + 1,
    };
  } catch (err: any) {
    return {
      requestId,
      success: false,
      error: {
        code: err.code ?? 'EXECUTION_ERROR',
        message: err.message,
        stack: err.stack,
      },
    };
  }
}

// ─── IPC Handler ─────────────────────────────────────────────────────────────

function handleMessage(raw: unknown): void {
  try {
    const msg = codec.decode(raw as string);
    if (!msg) return;

    switch (msg.kind) {
      case 'init': {
        initPayload = msg.payload as InitPayload;
        currentState = { ...(initPayload.state ?? {}) };
        stateRevision = initPayload.stateRevision ?? 0;
        sendReady();
        break;
      }

      case 'execute': {
        if (executing) {
          sendError('BUSY', 'Worker already executing');
          return;
        }
        executing = true;
        const payload = msg.payload as ExecutePayload;

        // Use Playwright mode when CDP is reachable (env var set by supervisor),
        // fall back to basic sandbox for testing.
        const usePlaywright = !!process.env.SSPA_MCP_PORT;

        const run = usePlaywright
          ? executeWithPlaywright(payload).then(r => ({
              requestId: r.requestId,
              success: r.success,
              value: r.value,
              error: r.error,
              stateCandidate: r.stateCandidate,
              stateRevision: r.stateRevision,
            }))
          : executeCode(payload);

        run
          .then(result => {
            sendResult(payload.requestId, result as ResultPayload);
            if (result.success && result.stateCandidate) {
              currentState = result.stateCandidate;
              stateRevision = result.stateRevision ?? stateRevision + 1;
            }
          })
          .catch(err => {
            sendResult(payload.requestId, {
              requestId: payload.requestId,
              success: false,
              error: { code: 'INTERNAL_ERROR', message: err.message },
            });
          })
          .finally(() => {
            executing = false;
            // Per-execute model: exit after one execution.
            process.exit(0);
          });
        break;
      }

      case 'cancel': {
        sendLog('Cancel received');
        process.exit(1);
        break;
      }

      case 'shutdown': {
        sendLog('Shutdown received');
        process.exit(0);
        break;
      }

      case 'heartbeat': {
        sendToRelay({
          kind: 'heartbeat',
          id: msg.id,
          sessionId: msg.sessionId,
          executeEpoch: msg.executeEpoch,
          payload: { pid: process.pid, alive: true },
        });
        break;
      }

      default:
        break;
    }
  } catch (err: any) {
    sendError('IPC_ERROR', `Message handling error: ${err.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

if (process.send) {
  process.on('message', handleMessage);

  process.on('disconnect', () => {
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    sendError('UNCAUGHT', err.message);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    sendError('UNHANDLED_REJECTION', String(reason));
    process.exit(1);
  });
}

export { executeCode, executeWithPlaywright, handleMessage };
