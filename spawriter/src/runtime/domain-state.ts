/**
 * Runtime domain state tracker — context cache, frame identity, and
 * snapshot/live barrier management.
 *
 * §5.2/W07 of the stability plan. Pure data structure — no I/O.
 * Tracks Runtime.executionContext*, Page.frame*, and Target lifecycle
 * to provide consistent views for each session/tab.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExecutionContextInfo {
  id: number;
  origin: string;
  name: string;
  auxData?: {
    isDefault?: boolean;
    type?: string;
    frameId?: string;
  };
}

export interface FrameInfo {
  id: string;
  parentId?: string;
  url: string;
  name?: string;
  /** Monotonic timestamp of last navigation. */
  lastNavigatedMono: number;
  /** Whether frame tree snapshot has been received for this frame. */
  snapshotSeen: boolean;
}

export type ContextEventKind = 'created' | 'destroyed' | 'cleared';

export interface ContextEvent {
  kind: ContextEventKind;
  contextId?: number;
  context?: ExecutionContextInfo;
  /** Monotonic timestamp when the event was received. */
  receivedMono: number;
}

export interface DomainStateConfig {
  /** Max contexts to track per tab. */
  maxContextsPerTab?: number;
  /** Max frames to track per tab. */
  maxFramesPerTab?: number;
  /** Max events in the replay buffer per tab. */
  maxReplayBufferPerTab?: number;
}

// ─── Per-tab state ───────────────────────────────────────────────────────────

export class TabDomainState {
  private readonly _maxContexts: number;
  private readonly _maxFrames: number;
  private readonly _maxReplay: number;

  /** Active execution contexts by context ID. */
  private _contexts = new Map<number, ExecutionContextInfo>();
  /** Active frames by frame ID. */
  private _frames = new Map<string, FrameInfo>();
  /** Ordered replay buffer for context events (bounded). */
  private _replayBuffer: ContextEvent[] = [];
  /** Whether the initial snapshot (Runtime.executionContextCreated batch) is complete. */
  private _snapshotComplete = false;
  /** Document generation counter — incremented on navigations. */
  private _documentGeneration = 0;

  constructor(config: DomainStateConfig = {}) {
    this._maxContexts = config.maxContextsPerTab ?? 256;
    this._maxFrames = config.maxFramesPerTab ?? 128;
    this._maxReplay = config.maxReplayBufferPerTab ?? 512;
  }

  // ─── Context lifecycle ─────────────────────────────────────────────────

  /**
   * Handle Runtime.executionContextCreated.
   */
  contextCreated(context: ExecutionContextInfo, receivedMono: number): void {
    if (this._contexts.size >= this._maxContexts) {
      // Evict oldest non-default context.
      for (const [id, ctx] of this._contexts) {
        if (!ctx.auxData?.isDefault) {
          this._contexts.delete(id);
          break;
        }
      }
    }
    this._contexts.set(context.id, context);
    this._pushReplay({ kind: 'created', contextId: context.id, context, receivedMono });
  }

  /**
   * Handle Runtime.executionContextDestroyed.
   */
  contextDestroyed(contextId: number, receivedMono: number): void {
    this._contexts.delete(contextId);
    this._pushReplay({ kind: 'destroyed', contextId, receivedMono });
  }

  /**
   * Handle Runtime.executionContextsCleared.
   */
  contextsCleared(receivedMono: number): void {
    this._contexts.clear();
    this._replayBuffer = [];
    this._snapshotComplete = false;
    this._documentGeneration++;
    this._pushReplay({ kind: 'cleared', receivedMono });
  }

  /**
   * Mark the initial snapshot as complete.
   */
  markSnapshotComplete(): void {
    this._snapshotComplete = true;
  }

  get snapshotComplete(): boolean {
    return this._snapshotComplete;
  }

  get documentGeneration(): number {
    return this._documentGeneration;
  }

  /**
   * Get a context by ID.
   */
  getContext(id: number): ExecutionContextInfo | undefined {
    return this._contexts.get(id);
  }

  /**
   * Get the default context for the main frame.
   */
  getDefaultContext(): ExecutionContextInfo | undefined {
    for (const ctx of this._contexts.values()) {
      if (ctx.auxData?.isDefault && ctx.auxData?.type === 'default') {
        return ctx;
      }
    }
    // Fallback: any default context.
    for (const ctx of this._contexts.values()) {
      if (ctx.auxData?.isDefault) return ctx;
    }
    return undefined;
  }

  /**
   * Get all contexts.
   */
  getAllContexts(): ExecutionContextInfo[] {
    return [...this._contexts.values()];
  }

  /**
   * Get the replay buffer for context events.
   */
  getReplayBuffer(): readonly ContextEvent[] {
    return this._replayBuffer;
  }

  // ─── Frame lifecycle ───────────────────────────────────────────────────

  /**
   * Handle Page.frameAttached.
   */
  frameAttached(frameId: string, parentId: string | undefined, receivedMono: number): boolean {
    if (this._frames.has(frameId)) {
      // Duplicate — not an error per se (snapshot + live overlap).
      return false;
    }
    if (this._frames.size >= this._maxFrames) return false;

    this._frames.set(frameId, {
      id: frameId,
      parentId,
      url: '',
      lastNavigatedMono: receivedMono,
      snapshotSeen: false,
    });
    return true;
  }

  /**
   * Handle Page.frameDetached.
   */
  frameDetached(frameId: string): boolean {
    return this._frames.delete(frameId);
  }

  /**
   * Handle Page.frameNavigated.
   */
  frameNavigated(frameId: string, url: string, receivedMono: number): void {
    const frame = this._frames.get(frameId);
    if (frame) {
      frame.url = url;
      frame.lastNavigatedMono = receivedMono;
    }
  }

  /**
   * Bulk load frames from Page.getFrameTree (snapshot).
   */
  loadFrameTree(frames: Array<{ id: string; parentId?: string; url: string }>, receivedMono: number): void {
    for (const f of frames) {
      if (!this._frames.has(f.id) && this._frames.size < this._maxFrames) {
        this._frames.set(f.id, {
          id: f.id,
          parentId: f.parentId,
          url: f.url,
          lastNavigatedMono: receivedMono,
          snapshotSeen: true,
        });
      } else if (this._frames.has(f.id)) {
        const existing = this._frames.get(f.id)!;
        existing.url = f.url;
        existing.snapshotSeen = true;
      }
    }
  }

  /**
   * Get a frame by ID.
   */
  getFrame(frameId: string): FrameInfo | undefined {
    return this._frames.get(frameId);
  }

  /**
   * Get all frames.
   */
  getAllFrames(): FrameInfo[] {
    return [...this._frames.values()];
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────

  diagnostics(): {
    contexts: number;
    frames: number;
    replayBuffer: number;
    snapshotComplete: boolean;
    documentGeneration: number;
  } {
    return {
      contexts: this._contexts.size,
      frames: this._frames.size,
      replayBuffer: this._replayBuffer.length,
      snapshotComplete: this._snapshotComplete,
      documentGeneration: this._documentGeneration,
    };
  }

  /**
   * Reset all state.
   */
  reset(): void {
    this._contexts.clear();
    this._frames.clear();
    this._replayBuffer = [];
    this._snapshotComplete = false;
    this._documentGeneration = 0;
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  private _pushReplay(event: ContextEvent): void {
    if (this._replayBuffer.length >= this._maxReplay) {
      // Keep the most recent half.
      this._replayBuffer = this._replayBuffer.slice(this._maxReplay >> 1);
    }
    this._replayBuffer.push(event);
  }
}
