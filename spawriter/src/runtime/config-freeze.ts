/**
 * W00b Configuration Freeze — Validated defaults frozen after G-1 experiments.
 *
 * These are the validated configuration values used during the G-1 experiments
 * (F01-F07) and integration tests (I1-I5). The freeze captures the exact
 * configuration that passed all experiments on 2026-11-26.
 *
 * Changes to these values after freeze require re-running the affected
 * gate tests (G0-G8) and documenting the rationale.
 */

import { type StabilityConfig, loadConfig } from './config.js';

/** Build SHA at time of configuration freeze. */
export const FREEZE_BUILD_SHA = '71ca016b3385456986bebe7b94e84f71c435c2fb';

/** Date of configuration freeze. */
export const FREEZE_DATE = '2026-11-26';

/** Frozen configuration values that passed G-1 validation. */
export const FROZEN_DEFAULTS: Readonly<StabilityConfig> = Object.freeze({
  // Console governor — validated by T01-T03 console storm test
  consoleRatePerTab: 100,
  consoleBurstPerTab: 200,
  consoleGlobalRate: 500,
  consoleGlobalBurst: 1000,
  telemetryBufferBytes: 4_194_304,
  telemetryTabBytes: 1_048_576,
  telemetryEventBytes: 65_536,
  telemetryAgeMs: 2_000,
  signatureTabCap: 1024,
  signatureGlobalCap: 8192,
  signatureTtlMs: 60_000,

  // CDP log — validated by T07, I1
  cdpLogSegmentBytes: 10_485_760,
  cdpLogSegments: 5,
  cdpLogQueueBytes: 2_097_152,

  // Execution — validated by I2 admission/cancel/drain tests
  execTimeoutMs: 30_000,
  execTimeoutMinMs: 100,
  execTimeoutMaxMs: 120_000,
  recoveryGraceMs: 5_000,
  sessionQueueLimit: 1,
  sessionMax: 64,
  globalQueueLimit: 16,
  emptySessionIdleMs: 1_800_000,

  // HTTP — validated by request validator tests
  httpHeaderMs: 5_000,
  httpBodyMs: 5_000,
  httpBodyBytes: 1_048_576,
  codeBytes: 524_288,
  controlConnectionMax: 64,
  pendingBodyBytes: 16_777_216,

  // Results
  resultPendingGlobalBytes: 67_108_864,
  resultTextBytes: 65_536,
  resultImageDecodedBytes: 8_388_608,
  resultTotalWireBytes: 16_777_216,

  // Transport — validated by F03/F04
  transportMode: 'auto',
  transportHeartbeatMs: 20_000,

  // Wire protocol — validated by wire-protocol.test.ts, transport.test.js
  wireFrameBytes: 98_304,
  wireChunkBytes: 49_152,
  wireTelemetryCreditBytes: 262_144,
  wireCriticalCreditBytes: 524_288,
  wireReassemblyBytes: 33_554_432,
  wireReassemblyTransfers: 2,
  controlBytesPerDirection: 65_536,
  controlFramesPerDirection: 32,
  controlRatePerSec: 200,
  controlBurstFrames: 32,
  revokedScopeCap: 1024,
  payloadMemoryTransport: 67_108_864,
  payloadMemoryGlobal: 134_217_728,

  // Pending — validated by pending-ledger.test.ts
  pendingPerTab: 64,
  pendingPerTransport: 256,

  // Risk journal — validated by dirty-journal.test.ts, I2
  riskPerTarget: 32,
  riskGlobal: 512,
  journalMaxRecords: 1024,
  journalMaxBytes: 4_194_304,
  journalQueueTxns: 64,
  journalQueueBytes: 1_048_576,
  journalCleanupReserveBytes: 1_048_576,

  // Worker — validated by F05, resource-budget.test.ts
  workerMax: 10,
  workerActive: 4,
  workerIdleMs: 300_000,
  workerHeapMib: 384,
  workerRssSoftMib: 768,
  workerGlobalBudgetMib: 2048,
  workerSampleMs: 500,
  executorMode: 'worker',

  // State — validated by F02, state-checkpoint.test.ts
  stateSessionBytes: 262_144,
  stateGlobalBytes: 4_194_304,
  stateTransientGlobalBytes: 16_777_216,
  internalCacheSessionBytes: 2_097_152,
  internalCacheGlobalBytes: 16_777_216,

  // Idempotency — validated by request-validator.test.ts
  execIdWindowMs: 600_000,
  execIdPerSessionCap: 8192,
  execIdGlobalCap: 65_536,
  execIdRecordBytes: 512,
  execIdGlobalBytes: 33_554_432,
  opIdCap: 4096,
  opIdBytes: 4_194_304,

  // Raw CDP
  rawCdpScopeMs: 30_000,
  rawCdpIdleMs: 5_000,

  // Runtime
  runtimeReplay: true,
  cdpDebugFull: false,

  // Data root (empty = auto-detect)
  dataRoot: '',
  logDir: '',
  mcpPort: 19989,

  // Task model — frozen by G-1 ADR-001
  taskModel: 'per-execute',

  // Critical data
  criticalBytes: 2_097_152,
  criticalFrames: 256,
  criticalAgeMs: 2_000,
});

/**
 * Validate that the current runtime config does not violate frozen constraints.
 * Returns a list of violations (empty = all good).
 */
export function validateAgainstFreeze(
  current: StabilityConfig,
): Array<{ field: string; frozen: unknown; actual: unknown; severity: 'error' | 'warning' }> {
  const violations: Array<{ field: string; frozen: unknown; actual: unknown; severity: 'error' }> = [];

  // Safety-critical fields that must not be relaxed.
  const hardFields: Array<keyof StabilityConfig> = [
    'execTimeoutMaxMs',
    'httpBodyBytes',
    'codeBytes',
    'sessionMax',
    'globalQueueLimit',
    'workerMax',
    'workerActive',
    'stateSessionBytes',
    'stateGlobalBytes',
    'taskModel',
  ];

  for (const field of hardFields) {
    const frozen = FROZEN_DEFAULTS[field];
    const actual = current[field];
    if (typeof frozen === 'number' && typeof actual === 'number') {
      if (actual > frozen) {
        violations.push({ field, frozen, actual, severity: 'error' });
      }
    } else if (frozen !== actual) {
      violations.push({ field, frozen, actual, severity: 'error' });
    }
  }

  return violations;
}

/**
 * Load config and validate against freeze. Throws on hard violations.
 */
export function loadAndValidateConfig(): StabilityConfig {
  const config = loadConfig();
  const violations = validateAgainstFreeze(config);
  const errors = violations.filter(v => v.severity === 'error');
  if (errors.length > 0) {
    const detail = errors.map(v => `${v.field}: frozen=${v.frozen}, actual=${v.actual}`).join('; ');
    throw new Error(`Config freeze violation: ${detail}`);
  }
  return config;
}
