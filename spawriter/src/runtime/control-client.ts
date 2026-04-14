export class ControlClient {
  private token?: string;

  constructor(private baseUrl: string, token?: string) {
    this.token = token;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  private async request<T = unknown>(path: string, options?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        headers: { ...this.getHeaders(), ...options?.headers as Record<string, string> },
      });
    } catch (err) {
      throw new Error(`Cannot connect to relay at ${this.baseUrl}. Is the relay running? (spawriter relay)`);
    }
    const data = await res.json() as any;
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status} from ${path}`);
    }
    return data as T;
  }

  async executeCode(sessionId: string, code: string, opts?: { timeout?: number; cwd?: string }) {
    return this.request<{ text: string; images: Array<{ data: string; mimeType: string }>; isError: boolean }>(
      '/cli/execute',
      { method: 'POST', body: JSON.stringify({ sessionId, code, timeout: opts?.timeout || 10000, cwd: opts?.cwd }) },
    );
  }

  async createSession(opts?: { cwd?: string }) {
    return this.request<{ id: string }>('/cli/session/new', {
      method: 'POST',
      body: JSON.stringify(opts || {}),
    });
  }

  async listSessions() {
    return this.request<{ sessions: Array<{ id: string; connected: boolean; stateKeys: string[] }> }>('/cli/sessions');
  }

  async deleteSession(sessionId: string) {
    return this.request('/cli/session/delete', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
  }

  async resetSession(sessionId: string) {
    return this.request<{ success: boolean; pageUrl?: string; pagesCount?: number }>('/cli/session/reset', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
  }
}
