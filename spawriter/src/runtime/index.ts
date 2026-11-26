/**
 * Runtime module barrel — re-exports all stability infrastructure.
 */

export {
  ExecutionError,
  CdpCommandTimeoutError,
  ConnectionTimeoutError,
  ExecutionTimeoutError,
  NavigationError,
  SessionBusyError,
  TargetDetachedError,
  TargetUnhealthyError,
  CancelledError,
  RelayDrainingError,
  classifyError,
  type ExecutionErrorCode,
  type ExecutionOutcome,
  type RecoveryState,
  type ExecutionPhase,
  type ExecutionErrorMeta,
} from './execution-errors.js';

export {
  ExecutionContext,
  monoNowMs,
  clampTimeout,
  generateRequestId,
  generateInstanceId,
  STAGE_CAPS,
  DEFAULT_EXEC_TIMEOUT_MS,
  MIN_EXEC_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  type ExecutionIdentity,
  type TargetBinding,
} from './execution-context.js';

export {
  ExecutionCoordinator,
  type TaskRecord,
  type TaskStatus,
  type CoordinatorOptions,
} from './execution-coordinator.js';

export {
  SessionRegistry,
  type SessionId,
  type Lease,
  type PhysicalTarget,
  type CdpClient,
  type VirtualSession,
  type SessionState,
  type LeaseStatus,
  type TargetHealthState,
} from './session-registry.js';

export {
  CdpRouter,
  ROUTER_CRITICAL_EVENTS,
  DROPPED_EVENTS as ROUTER_DROPPED_EVENTS,
  type ConnectedClient,
  type RouteDestination,
  type CdpEventPayload,
  type CdpRouterConfig,
} from './cdp-router.js';

export {
  HealthMonitor,
  type HealthStatus,
  type HealthMetrics,
  type HealthConfig,
} from './health.js';

export {
  TabDomainState,
  type ExecutionContextInfo,
  type FrameInfo,
  type ContextEvent,
  type ContextEventKind,
  type DomainStateConfig,
} from './domain-state.js';

export {
  NavigationCoordinator,
  type NavigationRecord,
  type NavigationState,
  type NavigationConfig,
} from './navigation.js';

export {
  TokenBucket,
  SignatureMap,
  consoleSignature,
} from './token-bucket.js';

export {
  BoundedLogger,
  redactSensitive,
} from './bounded-logger.js';

export {
  loadConfig,
  type StabilityConfig,
} from './config.js';

export {
  FROZEN_DEFAULTS,
  FREEZE_DATE,
  FREEZE_BUILD_SHA,
  validateAgainstFreeze,
  loadAndValidateConfig,
} from './config-freeze.js';

export {
  InstanceLock,
  type LockInfo,
  type LockResult,
  type InstanceLockConfig,
} from './instance-lock.js';

export {
  ProcessGuard,
  type ManagedProcess,
  type ProcessState,
  type ProcessGuardConfig,
} from './process-guard.js';

export {
  StateCheckpoint,
  type Checkpoint,
  type CheckpointConfig,
} from './state-checkpoint.js';

export {
  EventAttributionBarrier,
  type EventEpochs,
  type AttributionResult,
  type OwnerInfo,
  type AttributionBarrierConfig,
} from './event-attribution.js';

export {
  WIRE_VERSION,
  MAX_FRAME_SIZE,
  encodeEnvelope,
  decodeEnvelope,
  validateEnvelope,
  FlowControl,
  type WireEnvelope,
  type MessageKind,
  type ControlPayload,
  type FlowControlConfig,
} from './wire-protocol.js';

export {
  PendingLedger,
  type PendingCommand,
  type PendingLedgerConfig,
} from './pending-ledger.js';

export {
  RuntimeControl,
  type RuntimeControlDeps,
  type SessionCreateResult,
  type ExecuteRequest,
  type ExecuteResult,
  type StatusResult,
  type CancelResult,
  type TabClaimResult,
  type TabListResult,
  type DrainResult,
} from './runtime-control.js';

export {
  CancelCoordinator,
  type CancelRecord,
  type CancelPhase,
  type CancelReason,
  type CancelCoordinatorConfig,
} from './cancel-coordinator.js';

export {
  DomainLeaseTracker,
  type DomainRecord,
  type EnableState,
  type DomainLeaseConfig,
} from './domain-lease.js';

export {
  DirtyJournal,
  type RiskRecord,
  type RiskLevel,
  type RiskStatus,
  type DirtyJournalConfig,
} from './dirty-journal.js';

export {
  ResourceBudget,
  type WorkerAllocation,
  type BudgetSnapshot,
  type ResourceBudgetConfig,
} from './resource-budget.js';

export {
  RequestValidator,
  type ValidationResult,
  type RequestValidatorConfig,
} from './request-validator.js';

export {
  CredentialStore,
  type Principal,
  type PairingRecord,
  type CredentialStoreConfig,
} from './credential-store.js';

export {
  WorkerIpcCodec,
  type WorkerMessage,
  type WorkerMessageKind,
  type InitPayload,
  type ExecutePayload,
  type ResultPayload,
  type StateCommitPayload,
  type LogPayload,
  type CdpCommandPayload,
  type IpcCodecConfig,
} from './worker-ipc.js';

export {
  RelayRuntime,
  type RelayRuntimeConfig,
  type RuntimeDiagnostics,
} from './relay-runtime.js';

export {
  RelayBridge,
  type BridgeCallbacks,
  type ClaimResult,
  type AdmitResult,
} from './relay-bridge.js';

export {
  ExecutorSupervisor,
  type SupervisorConfig,
  type ExecuteRequest as SupervisorExecuteRequest,
  type ExecuteResponse as SupervisorExecuteResponse,
  type TabInfo,
} from './executor-supervisor.js';

export {
  runGates,
  runG0S,
  runG0,
  runG1,
  runG2,
  runG3,
  runG4,
  type GateResult,
  type GateReport,
  type GateStatus,
} from './gate-runner.js';
