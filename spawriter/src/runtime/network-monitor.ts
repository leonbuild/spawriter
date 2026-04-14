export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  startTime: number;
  endTime?: number;
  error?: string;
  size?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
  hasPostData?: boolean;
  resourceType?: string;
}

export interface InterceptRule {
  id: string;
  urlPattern: string;
  resourceType?: string;
  mockStatus?: number;
  mockHeaders?: Record<string, string>;
  mockBody?: string;
  block?: boolean;
}

export interface ConsoleLogEntry {
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

const MAX_CONSOLE_LOGS = 1000;
const MAX_NETWORK_ENTRIES = 500;

export class NetworkMonitor {
  private consoleLogs: ConsoleLogEntry[] = [];
  private networkLog: Map<string, NetworkEntry> = new Map();
  private interceptEnabled = false;
  private interceptRules: Map<string, InterceptRule> = new Map();
  private interceptNextId = 1;

  addConsoleLog(entry: ConsoleLogEntry) {
    this.consoleLogs.push(entry);
    if (this.consoleLogs.length > MAX_CONSOLE_LOGS) {
      this.consoleLogs.splice(0, this.consoleLogs.length - MAX_CONSOLE_LOGS);
    }
  }

  clearConsoleLogs() {
    this.consoleLogs.length = 0;
  }

  getConsoleLogs(options: { count?: number; level?: string; search?: string } = {}): ConsoleLogEntry[] {
    const count = Math.min(Math.max(options.count || 50, 1), MAX_CONSOLE_LOGS);
    const level = options.level || 'all';
    const search = (options.search || '').toLowerCase();

    let filtered = this.consoleLogs;
    if (level !== 'all') filtered = filtered.filter(log => log.level === level);
    if (search) filtered = filtered.filter(log => log.text.toLowerCase().includes(search));
    return filtered.slice(-count);
  }

  get consoleLogCount(): number {
    return this.consoleLogs.length;
  }

  addNetworkRequest(params: Record<string, unknown>) {
    const request = params.request as Record<string, unknown> | undefined;
    if (!request) return;
    const requestId = params.requestId as string;
    const entry: NetworkEntry = {
      requestId,
      url: request.url as string,
      method: request.method as string,
      startTime: Date.now(),
      requestHeaders: request.headers as Record<string, string>,
      postData: request.postData as string | undefined,
      hasPostData: request.hasPostData as boolean | undefined,
      resourceType: params.type as string | undefined,
    };
    this.networkLog.set(requestId, entry);
    if (this.networkLog.size > MAX_NETWORK_ENTRIES) {
      const firstKey = this.networkLog.keys().next().value;
      if (firstKey) this.networkLog.delete(firstKey);
    }
  }

  setNetworkResponse(params: Record<string, unknown>) {
    const requestId = params.requestId as string;
    const response = params.response as Record<string, unknown> | undefined;
    const entry = this.networkLog.get(requestId);
    if (!entry || !response) return;
    entry.status = response.status as number;
    entry.statusText = response.statusText as string;
    entry.mimeType = response.mimeType as string;
    entry.responseHeaders = response.headers as Record<string, string>;
  }

  setNetworkFinished(params: Record<string, unknown>) {
    const requestId = params.requestId as string;
    const entry = this.networkLog.get(requestId);
    if (!entry) return;
    entry.endTime = Date.now();
    entry.size = params.encodedDataLength as number | undefined;
  }

  setNetworkFailed(params: Record<string, unknown>) {
    const requestId = params.requestId as string;
    const entry = this.networkLog.get(requestId);
    if (!entry) return;
    entry.endTime = Date.now();
    entry.error = (params.errorText as string) || 'unknown';
  }

  clearNetworkLog() {
    this.networkLog.clear();
  }

  getNetworkEntries(options: { count?: number; urlFilter?: string; statusFilter?: string } = {}): NetworkEntry[] {
    const count = Math.min(Math.max(options.count || 50, 1), MAX_NETWORK_ENTRIES);
    const urlFilter = (options.urlFilter || '').toLowerCase();
    const statusFilter = options.statusFilter || 'all';

    let entries = Array.from(this.networkLog.values());
    if (urlFilter) entries = entries.filter(e => e.url.toLowerCase().includes(urlFilter));
    if (statusFilter !== 'all') {
      entries = entries.filter(e => {
        if (statusFilter === 'ok') return e.status !== undefined && e.status >= 200 && e.status < 400;
        if (statusFilter === 'error') return !!e.error || (e.status !== undefined && e.status >= 400);
        if (statusFilter === '4xx') return e.status !== undefined && e.status >= 400 && e.status < 500;
        if (statusFilter === '5xx') return e.status !== undefined && e.status >= 500;
        return true;
      });
    }
    return entries.slice(-count);
  }

  get networkEntryCount(): number {
    return this.networkLog.size;
  }

  getNetworkDetail(requestId: string): NetworkEntry | undefined {
    return this.networkLog.get(requestId);
  }

  get isInterceptEnabled(): boolean {
    return this.interceptEnabled;
  }

  enableIntercept() { this.interceptEnabled = true; }
  disableIntercept() { this.interceptEnabled = false; }

  addInterceptRule(rule: Omit<InterceptRule, 'id'>): InterceptRule {
    const id = `rule-${this.interceptNextId++}`;
    const fullRule = { ...rule, id };
    this.interceptRules.set(id, fullRule);
    return fullRule;
  }

  removeInterceptRule(id: string): boolean {
    return this.interceptRules.delete(id);
  }

  listInterceptRules(): InterceptRule[] {
    return Array.from(this.interceptRules.values());
  }

  findMatchingRule(requestUrl: string, resourceType: string): InterceptRule | null {
    if (!this.interceptEnabled) return null;
    for (const rule of this.interceptRules.values()) {
      const urlMatch = !rule.urlPattern || requestUrl.includes(rule.urlPattern) ||
        new RegExp(rule.urlPattern.replace(/\*/g, '.*')).test(requestUrl);
      const typeMatch = !rule.resourceType || resourceType.toLowerCase() === rule.resourceType.toLowerCase();
      if (urlMatch && typeMatch) return rule;
    }
    return null;
  }

  clearInterceptState() {
    this.interceptEnabled = false;
    this.interceptRules.clear();
    this.interceptNextId = 1;
  }

  clearAll() {
    this.clearConsoleLogs();
    this.clearNetworkLog();
    this.clearInterceptState();
  }
}

export function formatConsoleLogs(logs: ConsoleLogEntry[], totalCount: number): string {
  if (logs.length === 0) return `No console logs captured (${totalCount} total in buffer)`;
  const lines = logs.map(log => {
    const time = new Date(log.timestamp).toISOString().slice(11, 23);
    const loc = log.url ? ` (${log.url}${log.lineNumber !== undefined ? ':' + log.lineNumber : ''})` : '';
    return `[${time}] [${log.level.toUpperCase().padEnd(5)}] ${log.text}${loc}`;
  });
  return `Console logs (${logs.length}/${totalCount} total):\n${lines.join('\n')}`;
}

export function formatNetworkEntries(entries: NetworkEntry[], totalCount: number): string {
  if (entries.length === 0) return `No network entries captured (${totalCount} total in buffer)`;
  const lines = entries.map(e => {
    const st = e.error ? `ERR:${e.error}` : (e.status !== undefined ? `${e.status}` : '...');
    const dur = e.endTime && e.startTime ? `${e.endTime - e.startTime}ms` : '...';
    const sz = e.size ? ` ${(e.size / 1024).toFixed(1)}KB` : '';
    return `[${e.requestId}] ${e.method.padEnd(6)} ${st.padEnd(15)} ${dur.padStart(7)}${sz}  ${e.url}`;
  });
  return `Network (${entries.length}/${totalCount} total):\n${lines.join('\n')}\n\nUse network_detail { requestId: "..." } to inspect headers and body.`;
}
