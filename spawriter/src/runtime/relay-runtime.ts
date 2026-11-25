/**
 * RelayRuntime — composition root for the stability module layer.
 *
 * Instantiates and wires together all pure-logic modules into a single
 * injectable runtime. The existing relay.ts will delegate to this instance
 * during integration, replacing its ad-hoc global Maps and scattered logic.
 *
 * Not a God object: each subsystem retains its own interface. RelayRuntime
 * is the assembly point and lifecycle manager.
 */

import { type StabilityConfig, loadConfig } from './config.js';
import { SessionRegistry } from './session-registry.js';
import { ExecutionCoordinator } from './execution-coordinator.js';
import { CdpRouter } from './cdp-router.js';
import { PendingLedger } from './pending-ledger.js';
import { EventAttributionBarrier } from './event-attribution.js';
import { HealthMonitor } from './health.js';
import { NavigationCoordinator } from './navigation.js';
import { TabDomainState } from './domain-state.js';
import { DomainLeaseTracker } from './domain-lease.js';
import { CancelCoordinator } from './cancel-coordinator.js';
import { DirtyJournal } from './dirty-journal.js';
import { ResourceBudget } from './resource-budget.js';
import { RequestValidator } from './request-validator.js';
import { CredentialStore } from './credential-store.js';
import { StateCheckpoint } from './state-checkpoint.js';
import { BoundedLogger } from './bounded-logger.js';
import { ProcessGuard } from './process-guard.js';
import { generateInstanceId, monoNowMs } from './execution-context.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RelayRuntimeConfig {
  /** Override config (merged with env-based loadConfig). */
  config?: Partial<StabilityConfig>;
  /** Relay instance ID (auto-generated if omitted). */
  instanceId?: string;
  /** Log directory for bounded logger. */
  logDir?: string;
}

export interface RuntimeDiagnostics {
  instanceId: string;
  uptimeMs: number;
  sessions: ReturnType<SessionRegistry['diagnostics']>;
  health: ReturnType<HealthMonitor['getMetrics']>;
  coordinator: ReturnType<ExecutionCoordinator['diagnostics']>;
  pending: ReturnType<PendingLedger['diagnostics']>;
  cancel: ReturnType<CancelCoordinator['diagnostics']>;
  journal: ReturnType<DirtyJournal['diagnostics']>;
  budget: ReturnType<ResourceBudget['snapshot']>;
  credentials: ReturnType<CredentialStore['diagnostics']>;
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export class RelayRuntime {
  readonly instanceId: string;
  readonly config: StabilityConfig;
  readonly startMono: number;

  // ─── Subsystems (public for relay.ts delegation) ───────────────────

  readonly registry: SessionRegistry;
  readonly coordinator: ExecutionCoordinator;
  readonly router: CdpRouter;
  readonly pending: PendingLedger;
  readonly attribution: EventAttributionBarrier;
  readonly health: HealthMonitor;
  readonly navigation: NavigationCoordinator;
  readonly cancel: CancelCoordinator;
  readonly journal: DirtyJournal;
  readonly budget: ResourceBudget;
  readonly validator: RequestValidator;
  readonly credentials: CredentialStore;
  readonly processGuard: ProcessGuard;
  readonly logger: BoundedLogger;

  /** Per-tab domain state. */
  readonly tabStates = new Map<number, TabDomainState>();
  /** Per-session state checkpoints. */
  readonly checkpoints = new Map<string, StateCheckpoint>();
  /** Per-tab domain lease trackers (shared across sessions). */
  readonly domainLeases: DomainLeaseTracker;

  private _draining = false;
  private _closed = false;

  constructor(runtimeConfig: RelayRuntimeConfig = {}) {
    this.startMono = monoNowMs();
    this.instanceId = runtimeConfig.instanceId ?? generateInstanceId();

    const envConfig = loadConfig();
    this.config = { ...envConfig, ...runtimeConfig.config } as StabilityConfig;

    // ─── Instantiate subsystems ────────────────────────────────────

    this.registry = new SessionRegistry(this.config.sessionMax);

    this.coordinator = new ExecutionCoordinator({
      registry: this.registry,
      sessionQueueLimit: this.config.sessionQueueLimit,
      maxGlobalQueued: this.config.globalQueueLimit,
      defaultTimeoutMs: this.config.execTimeoutMs,
      recoveryGraceMs: this.config.recoveryGraceMs,
    });

    this.router = new CdpRouter();

    this.pending = new PendingLedger({
      maxPerTab: this.config.pendingPerTab,
      maxPerTransport: this.config.pendingPerTransport,
    });

    this.attribution = new EventAttributionBarrier();

    this.health = new HealthMonitor({
      errorRateThreshold: 60,
    });

    this.navigation = new NavigationCoordinator();

    this.cancel = new CancelCoordinator({
      totalGraceMs: this.config.recoveryGraceMs,
    });

    this.journal = new DirtyJournal();

    this.budget = new ResourceBudget({
      maxWorkers: this.config.workerMax,
      maxActiveWorkers: this.config.workerActive,
      globalQueueLimit: this.config.globalQueueLimit,
      httpBodyBytes: this.config.httpBodyBytes,
      codePayloadBytes: this.config.codeBytes,
    });

    this.validator = new RequestValidator({
      maxBodyBytes: this.config.httpBodyBytes,
      maxCodeBytes: this.config.codeBytes,
      minTimeoutMs: this.config.execTimeoutMinMs,
      maxTimeoutMs: this.config.execTimeoutMaxMs,
    });

    this.credentials = new CredentialStore();

    this.processGuard = new ProcessGuard();

    this.domainLeases = new DomainLeaseTracker();

    const logDir = runtimeConfig.logDir ?? process.cwd();
    this.logger = new BoundedLogger({
      dir: logDir,
      baseName: 'relay',
      instanceId: this.instanceId,
      segmentBytes: this.config.cdpLogSegmentBytes,
      maxSegments: this.config.cdpLogSegments,
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  get isDraining(): boolean { return this._draining; }
  get isClosed(): boolean { return this._closed; }

  /**
   * Begin draining: reject new admissions, wait for in-flight to complete.
   */
  startDrain(): void {
    this._draining = true;
    this.coordinator.startDrain();
  }

  /**
   * Close the runtime. Cleans up all subsystems.
   */
  close(): void {
    this._draining = true;
    this._closed = true;

    // Clean up per-tab state.
    for (const [, state] of this.tabStates) state.reset();
    this.tabStates.clear();

    // Clean up per-session checkpoints.
    for (const [, cp] of this.checkpoints) cp.reset();
    this.checkpoints.clear();

    // Reset subsystems.
    this.attribution.reset();
    this.journal.reset();
    this.budget.reset();
    this.credentials.reset();
    this.domainLeases.reset();
  }

  // ─── Tab state ─────────────────────────────────────────────────────

  /**
   * Get or create domain state for a tab.
   */
  getTabState(tabId: number): TabDomainState {
    let state = this.tabStates.get(tabId);
    if (!state) {
      state = new TabDomainState();
      this.tabStates.set(tabId, state);
    }
    return state;
  }

  /**
   * Remove tab state (tab closed).
   */
  removeTabState(tabId: number): void {
    const state = this.tabStates.get(tabId);
    if (state) {
      state.reset();
      this.tabStates.delete(tabId);
    }
    this.domainLeases.removeTarget(String(tabId));
  }

  // ─── Session state ─────────────────────────────────────────────────

  /**
   * Get or create a state checkpoint for a session.
   */
  getCheckpoint(sessionId: string): StateCheckpoint {
    let cp = this.checkpoints.get(sessionId);
    if (!cp) {
      cp = new StateCheckpoint({
        maxByteSize: this.config.stateSessionBytes,
      });
      this.checkpoints.set(sessionId, cp);
    }
    return cp;
  }

  /**
   * Remove a session's state checkpoint.
   */
  removeCheckpoint(sessionId: string): void {
    const cp = this.checkpoints.get(sessionId);
    if (cp) {
      cp.reset();
      this.checkpoints.delete(sessionId);
    }
  }

  // ─── Diagnostics ───────────────────────────────────────────────────

  diagnostics(): RuntimeDiagnostics {
    return {
      instanceId: this.instanceId,
      uptimeMs: monoNowMs() - this.startMono,
      sessions: this.registry.diagnostics(),
      health: this.health.getMetrics(),
      coordinator: this.coordinator.diagnostics(),
      pending: this.pending.diagnostics(),
      cancel: this.cancel.diagnostics(),
      journal: this.journal.diagnostics(),
      budget: this.budget.snapshot(),
      credentials: this.credentials.diagnostics(),
    };
  }
}
