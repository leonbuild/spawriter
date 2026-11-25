/**
 * Unified configuration for the Spawriter stability features.
 *
 * All parameters are centrally defined and validated here.
 * §10 of the stability plan.
 */

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw === '1' || raw === 'true' || raw === 'on';
}

function envString(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/** Validated positive integer within [min, max]. */
function clampedInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min) return min;
  if (value > max) return max;
  return Math.floor(value);
}

export interface StabilityConfig {
  // --- Console governor ---
  consoleRatePerTab: number;       // events/s per tab
  consoleBurstPerTab: number;      // token burst per tab
  consoleGlobalRate: number;       // events/s global
  consoleGlobalBurst: number;      // token burst global
  telemetryBufferBytes: number;    // global byte cap
  telemetryTabBytes: number;       // per-tab byte cap
  telemetryEventBytes: number;     // single event byte cap
  telemetryAgeMs: number;          // max event age in queue
  signatureTabCap: number;         // per-tab signature map cap
  signatureGlobalCap: number;      // global signature map cap
  signatureTtlMs: number;          // signature TTL

  // --- CDP log ---
  cdpLogSegmentBytes: number;      // single segment size
  cdpLogSegments: number;          // total retained segments
  cdpLogQueueBytes: number;        // log queue memory cap

  // --- Execution ---
  execTimeoutMs: number;           // default client entry timeout
  execTimeoutMinMs: number;        // minimum allowed
  execTimeoutMaxMs: number;        // maximum allowed
  recoveryGraceMs: number;         // recovery budget
  sessionQueueLimit: number;       // pending per session (not counting running)
  sessionMax: number;              // max logical sessions
  globalQueueLimit: number;        // global queued tasks
  emptySessionIdleMs: number;      // idle sweep for empty sessions

  // --- HTTP ---
  httpHeaderMs: number;            // header read cap
  httpBodyMs: number;              // body read cap
  httpBodyBytes: number;           // max body
  codeBytes: number;               // max script
  controlConnectionMax: number;    // global connections
  pendingBodyBytes: number;        // global pending body

  // --- Results ---
  resultPendingGlobalBytes: number;
  resultTextBytes: number;
  resultImageDecodedBytes: number;
  resultTotalWireBytes: number;

  // --- Transport ---
  transportMode: 'auto' | 'sw' | 'port';
  transportHeartbeatMs: number;

  // --- Wire protocol ---
  wireFrameBytes: number;
  wireChunkBytes: number;
  wireTelemetryCreditBytes: number;
  wireCriticalCreditBytes: number;
  wireReassemblyBytes: number;
  wireReassemblyTransfers: number;
  controlBytesPerDirection: number;
  controlFramesPerDirection: number;
  controlRatePerSec: number;
  controlBurstFrames: number;
  revokedScopeCap: number;
  payloadMemoryTransport: number;
  payloadMemoryGlobal: number;

  // --- Pending ---
  pendingPerTab: number;
  pendingPerTransport: number;

  // --- Risk journal ---
  riskPerTarget: number;
  riskGlobal: number;
  journalMaxRecords: number;
  journalMaxBytes: number;
  journalQueueTxns: number;
  journalQueueBytes: number;
  journalCleanupReserveBytes: number;

  // --- Worker ---
  workerMax: number;
  workerActive: number;
  workerIdleMs: number;
  workerHeapMib: number;
  workerRssSoftMib: number;
  workerGlobalBudgetMib: number;
  workerSampleMs: number;
  executorMode: 'worker' | 'inprocess';

  // --- State ---
  stateSessionBytes: number;
  stateGlobalBytes: number;
  stateTransientGlobalBytes: number;
  internalCacheSessionBytes: number;
  internalCacheGlobalBytes: number;

  // --- Idempotency ---
  execIdWindowMs: number;
  execIdPerSessionCap: number;
  execIdGlobalCap: number;
  execIdRecordBytes: number;
  execIdGlobalBytes: number;
  opIdCap: number;
  opIdBytes: number;

  // --- Raw CDP ---
  rawCdpScopeMs: number;
  rawCdpIdleMs: number;

  // --- Runtime ---
  runtimeReplay: boolean;
  cdpDebugFull: boolean;

  // --- Data root ---
  dataRoot: string;
  logDir: string;
  mcpPort: number;

  // --- Task model ---
  taskModel: 'per-execute' | 'per-session';

  // --- Critical data ---
  criticalBytes: number;
  criticalFrames: number;
  criticalAgeMs: number;
}

/**
 * Load configuration from environment with defaults from §10.
 * Safety invariants (owner, epoch checks) cannot be disabled.
 */
export function loadConfig(): StabilityConfig {
  return {
    consoleRatePerTab: envInt('SSPA_CONSOLE_RATE_PER_TAB', 100),
    consoleBurstPerTab: envInt('SSPA_CONSOLE_BURST_PER_TAB', 200),
    consoleGlobalRate: envInt('SSPA_CONSOLE_GLOBAL_RATE', 500),
    consoleGlobalBurst: envInt('SSPA_CONSOLE_GLOBAL_BURST', 1000),
    telemetryBufferBytes: envInt('SSPA_TELEMETRY_BUFFER_BYTES', 4_194_304),
    telemetryTabBytes: envInt('SSPA_TELEMETRY_TAB_BYTES', 1_048_576),
    telemetryEventBytes: envInt('SSPA_TELEMETRY_EVENT_BYTES', 65_536),
    telemetryAgeMs: envInt('SSPA_TELEMETRY_AGE_MS', 2_000),
    signatureTabCap: envInt('SSPA_SIGNATURE_TAB', 1024),
    signatureGlobalCap: envInt('SSPA_SIGNATURE_GLOBAL', 8192),
    signatureTtlMs: envInt('SSPA_SIGNATURE_TTL_MS', 60_000),

    cdpLogSegmentBytes: envInt('SSPA_CDP_LOG_SEGMENT_BYTES', 10_485_760),
    cdpLogSegments: envInt('SSPA_CDP_LOG_SEGMENTS', 5),
    cdpLogQueueBytes: envInt('SSPA_LOG_QUEUE_BYTES', 2_097_152),

    execTimeoutMs: envInt('SSPA_EXEC_TIMEOUT_MS', 30_000),
    execTimeoutMinMs: envInt('SSPA_EXEC_TIMEOUT_MIN_MS', 100),
    execTimeoutMaxMs: envInt('SSPA_EXEC_TIMEOUT_MAX_MS', 120_000),
    recoveryGraceMs: envInt('SSPA_RECOVERY_GRACE_MS', 5_000),
    sessionQueueLimit: envInt('SSPA_SESSION_QUEUE_LIMIT', 1),
    sessionMax: envInt('SSPA_SESSION_MAX', 64),
    globalQueueLimit: envInt('SSPA_GLOBAL_QUEUE_LIMIT', 16),
    emptySessionIdleMs: envInt('SSPA_EMPTY_SESSION_IDLE_MS', 1_800_000),

    httpHeaderMs: envInt('SSPA_HTTP_HEADER_MS', 5_000),
    httpBodyMs: envInt('SSPA_HTTP_BODY_MS', 5_000),
    httpBodyBytes: envInt('SSPA_HTTP_BODY_BYTES', 1_048_576),
    codeBytes: envInt('SSPA_CODE_BYTES', 524_288),
    controlConnectionMax: envInt('SSPA_CONTROL_CONNECTION_MAX', 64),
    pendingBodyBytes: envInt('SSPA_PENDING_BODY_BYTES', 16_777_216),

    resultPendingGlobalBytes: envInt('SSPA_RESULT_PENDING_GLOBAL_BYTES', 67_108_864),
    resultTextBytes: envInt('SSPA_RESULT_TEXT_BYTES', 65_536),
    resultImageDecodedBytes: envInt('SSPA_RESULT_IMAGE_DECODED_BYTES', 8_388_608),
    resultTotalWireBytes: envInt('SSPA_RESULT_TOTAL_WIRE_BYTES', 16_777_216),

    transportMode: (envString('SSPA_TRANSPORT_MODE', 'auto') as 'auto' | 'sw' | 'port'),
    transportHeartbeatMs: envInt('SSPA_TRANSPORT_HEARTBEAT_MS', 20_000),

    wireFrameBytes: envInt('SSPA_WIRE_FRAME_BYTES', 98_304),
    wireChunkBytes: envInt('SSPA_WIRE_CHUNK_BYTES', 49_152),
    wireTelemetryCreditBytes: envInt('SSPA_WIRE_TELEMETRY_CREDIT', 262_144),
    wireCriticalCreditBytes: envInt('SSPA_WIRE_CRITICAL_CREDIT', 524_288),
    wireReassemblyBytes: envInt('SSPA_WIRE_REASSEMBLY_BYTES', 33_554_432),
    wireReassemblyTransfers: envInt('SSPA_WIRE_REASSEMBLY_TRANSFERS', 2),
    controlBytesPerDirection: envInt('SSPA_CONTROL_BYTES', 65_536),
    controlFramesPerDirection: envInt('SSPA_CONTROL_FRAMES', 32),
    controlRatePerSec: envInt('SSPA_CONTROL_RATE', 200),
    controlBurstFrames: envInt('SSPA_CONTROL_BURST', 32),
    revokedScopeCap: envInt('SSPA_REVOKED_SCOPE_CAP', 1024),
    payloadMemoryTransport: envInt('SSPA_PAYLOAD_MEMORY_TRANSPORT', 67_108_864),
    payloadMemoryGlobal: envInt('SSPA_PAYLOAD_MEMORY_GLOBAL', 134_217_728),

    pendingPerTab: envInt('SSPA_PENDING_PER_TAB', 64),
    pendingPerTransport: envInt('SSPA_PENDING_PER_TRANSPORT', 256),

    riskPerTarget: envInt('SSPA_RISK_PER_TARGET', 32),
    riskGlobal: envInt('SSPA_RISK_GLOBAL', 512),
    journalMaxRecords: envInt('SSPA_JOURNAL_MAX_RECORDS', 1024),
    journalMaxBytes: envInt('SSPA_JOURNAL_MAX_BYTES', 4_194_304),
    journalQueueTxns: envInt('SSPA_JOURNAL_QUEUE_TXNS', 64),
    journalQueueBytes: envInt('SSPA_JOURNAL_QUEUE_BYTES', 1_048_576),
    journalCleanupReserveBytes: envInt('SSPA_JOURNAL_CLEANUP_RESERVE_BYTES', 1_048_576),

    workerMax: envInt('SSPA_WORKER_MAX', 10),
    workerActive: envInt('SSPA_WORKER_ACTIVE', 4),
    workerIdleMs: envInt('SSPA_WORKER_IDLE_MS', 300_000),
    workerHeapMib: envInt('SSPA_WORKER_HEAP_MIB', 384),
    workerRssSoftMib: envInt('SSPA_WORKER_RSS_SOFT_MIB', 768),
    workerGlobalBudgetMib: envInt('SSPA_WORKER_GLOBAL_BUDGET_MIB', 2048),
    workerSampleMs: clampedInt(envInt('SSPA_WORKER_SAMPLE_MS', 500), 250, 5000),
    executorMode: (envString('SSPA_EXECUTOR_MODE', 'worker') as 'worker' | 'inprocess'),

    stateSessionBytes: envInt('SSPA_STATE_SESSION_BYTES', 262_144),
    stateGlobalBytes: envInt('SSPA_STATE_GLOBAL_BYTES', 4_194_304),
    stateTransientGlobalBytes: envInt('SSPA_STATE_TRANSIENT_GLOBAL_BYTES', 16_777_216),
    internalCacheSessionBytes: envInt('SSPA_INTERNAL_CACHE_SESSION_BYTES', 2_097_152),
    internalCacheGlobalBytes: envInt('SSPA_INTERNAL_CACHE_GLOBAL_BYTES', 16_777_216),

    execIdWindowMs: envInt('SSPA_EXEC_ID_WINDOW_MS', 600_000),
    execIdPerSessionCap: envInt('SSPA_EXEC_ID_PER_SESSION_CAP', 8192),
    execIdGlobalCap: envInt('SSPA_EXEC_ID_GLOBAL_CAP', 65_536),
    execIdRecordBytes: envInt('SSPA_EXEC_ID_RECORD_BYTES', 512),
    execIdGlobalBytes: envInt('SSPA_EXEC_ID_GLOBAL_BYTES', 33_554_432),
    opIdCap: envInt('SSPA_OP_ID_CAP', 4096),
    opIdBytes: envInt('SSPA_OP_ID_BYTES', 4_194_304),

    rawCdpScopeMs: envInt('SSPA_RAW_CDP_SCOPE_MS', 30_000),
    rawCdpIdleMs: envInt('SSPA_RAW_CDP_IDLE_MS', 5_000),

    runtimeReplay: envBool('SSPA_RUNTIME_REPLAY', true),
    cdpDebugFull: envBool('SSPA_CDP_DEBUG_FULL', false),

    dataRoot: envString('SSPA_DATA_ROOT', ''),
    logDir: envString('SSPA_LOG_DIR', ''),
    mcpPort: envInt('SSPA_MCP_PORT', 19989),

    taskModel: (envString('SSPA_TASK_MODEL', 'per-execute') as 'per-execute' | 'per-session'),

    criticalBytes: envInt('SSPA_CRITICAL_BYTES', 2_097_152),
    criticalFrames: envInt('SSPA_CRITICAL_FRAMES', 256),
    criticalAgeMs: envInt('SSPA_CRITICAL_AGE_MS', 2_000),
  };
}
