export interface SessionState {
  id: string;
  cdpSession: unknown | null;
  preferredTargetId: string | null;
  activeAgentId: string | null;
  consoleLogs: Array<{ level: string; text: string; timestamp: number; url?: string; lineNumber?: number }>;
  interceptEnabled: boolean;
  interceptRules: Map<string, { id: string; urlPattern: string; resourceType?: string; mockStatus?: number; mockHeaders?: string; mockBody?: string; block?: boolean }>;
  interceptNextId: number;
  networkLog: Map<string, unknown>;
  refCacheByTab: Map<string, Map<number, { backendDOMNodeId: number; role: string; name: string }>>;
  lastSnapshot: string | null;
  debuggerEnabled: boolean;
  breakpoints: Map<string, { id: string; file: string; line: number }>;
  debuggerPaused: boolean;
  currentCallFrameId: string | null;
  knownScripts: Map<string, { scriptId: string; url: string }>;
  executorSessionId: string;
  createdAt: number;
}

export class SessionStore {
  private sessions = new Map<string, SessionState>();
  private maxSessions: number;

  constructor(maxSessions = 10) {
    this.maxSessions = maxSessions;
  }

  createSession(): SessionState {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Session limit reached (${this.maxSessions}). Delete an existing session first.`);
    }
    const id = `sw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const session: SessionState = {
      id,
      cdpSession: null,
      preferredTargetId: null,
      activeAgentId: null,
      consoleLogs: [],
      interceptEnabled: false,
      interceptRules: new Map(),
      interceptNextId: 1,
      networkLog: new Map(),
      refCacheByTab: new Map(),
      lastSnapshot: null,
      debuggerEnabled: false,
      breakpoints: new Map(),
      debuggerPaused: false,
      currentCallFrameId: null,
      knownScripts: new Map(),
      executorSessionId: id,
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  listSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  resetSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.consoleLogs = [];
    session.interceptEnabled = false;
    session.interceptRules.clear();
    session.interceptNextId = 1;
    session.networkLog.clear();
    session.refCacheByTab.clear();
    session.lastSnapshot = null;
    session.debuggerEnabled = false;
    session.breakpoints.clear();
    session.debuggerPaused = false;
    session.currentCallFrameId = null;
    session.knownScripts.clear();
    session.cdpSession = null;
    session.preferredTargetId = null;
    return true;
  }

  get size(): number {
    return this.sessions.size;
  }
}
