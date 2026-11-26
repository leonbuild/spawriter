/**
 * Executor Worker — per-execute child process (W11 §9.1/§16.6).
 *
 * This is spawned by ExecutorSupervisor for each user code execution.
 * It receives IPC messages from the Relay, connects to Chrome via CDP,
 * runs user code, and sends results back. The process exits after
 * one execution (per-execute model per ADR-001).
 *
 * Not imported by relay.ts directly — spawned as a child process via
 * executor-supervisor.ts.
 */

import { WorkerIpcCodec, type WorkerMessage, type InitPayload, type ExecutePayload, type ResultPayload } from './worker-ipc.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkerConfig {
  /** CDP WebSocket endpoint to connect to. */
  cdpEndpoint: string;
  /** Max execution timeout in ms. */
  maxTimeoutMs: number;
  /** Max heap size (MiB). */
  maxHeapMib: number;
}

// ─── Worker Process ──────────────────────────────────────────────────────────

const codec = new WorkerIpcCodec();
let initPayload: InitPayload | null = null;
let currentState: Record<string, unknown> = {};
let stateRevision = 0;
let executing = false;

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
  sendToRelay({
    kind: 'result',
    id: requestId,
    sessionId: initPayload?.sessionId ?? '',
    executeEpoch: initPayload?.executeEpoch ?? 0,
    payload: result,
  });
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

// ─── Execution ───────────────────────────────────────────────────────────────

async function executeCode(payload: ExecutePayload): Promise<ResultPayload> {
  const { code, timeoutMs, requestId } = payload;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    // Build a minimal sandbox with the state.
    // In the full implementation, this would set up Playwright connection
    // and all VM globals. For now, we execute in a basic Node.js context.
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
      AbortSignal: ac.signal,
    };

    const context = vm.createContext(sandbox);
    const script = new vm.Script(`(async () => { ${code} })()`, {
      filename: `execute-${requestId}.js`,
    });

    const result = await script.runInContext(context, { timeout: timeoutMs });

    // Extract state candidate.
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
  } finally {
    clearTimeout(timer);
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
        executeCode(payload)
          .then(result => {
            sendResult(payload.requestId, result);
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
        // In full implementation, would abort the running execution.
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

  // Safety: exit if parent dies (no IPC).
  process.on('disconnect', () => {
    process.exit(1);
  });

  // Uncaught errors → report and exit.
  process.on('uncaughtException', (err) => {
    sendError('UNCAUGHT', err.message);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    sendError('UNHANDLED_REJECTION', String(reason));
    process.exit(1);
  });
}

export { executeCode, handleMessage };
