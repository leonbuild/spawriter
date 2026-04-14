import type { Hono } from 'hono';
import type { SessionStore } from './session-store.js';
import type { ExecutorManager } from '../pw-executor.js';
import { injectSpawriterGlobals, type ToolContext } from './cli-globals.js';
import { getRelayToken } from '../utils.js';

export function registerControlRoutes(
  app: Hono,
  sessionStore: SessionStore,
  executorManager: ExecutorManager,
  toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  app.use('/cli/*', async (c, next) => {
    const secFetchSite = c.req.header('sec-fetch-site');
    if (secFetchSite && secFetchSite !== 'none' && secFetchSite !== 'same-origin') {
      return c.json({ error: 'Cross-origin requests not allowed' }, 403);
    }

    if (c.req.method === 'POST') {
      const contentType = c.req.header('content-type');
      if (!contentType?.includes('application/json')) {
        return c.json({ error: 'Content-Type must be application/json' }, 400);
      }
    }

    const token = getRelayToken();
    if (token) {
      const auth = c.req.header('authorization');
      if (auth !== `Bearer ${token}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
    }

    await next();
  });

  app.post('/cli/execute', async (c) => {
    try {
      const body = (await c.req.json()) as {
        sessionId: string;
        code: string;
        timeout?: number;
        cwd?: string;
      };

      let session = sessionStore.getSession(body.sessionId);
      if (!session) {
        return c.json({ error: `Session not found: ${body.sessionId}` }, 404);
      }

      const executor = executorManager.getOrCreate(body.sessionId);

      const toolCtx: ToolContext = {
        executeTool: toolExecutor,
      };
      injectSpawriterGlobals(executor, body.sessionId, toolCtx);

      const result = await executor.execute(body.code, body.timeout || 10000);

      return c.json({
        text: result.text,
        images: (result as any).images || [],
        isError: result.isError,
      });
    } catch (error: any) {
      return c.json({ text: error.message, images: [], isError: true }, 500);
    }
  });

  app.post('/cli/tool', async (c) => {
    try {
      const { sessionId, name, args } = await c.req.json();
      const session = sessionStore.getSession(sessionId);
      if (!session) return c.json({ error: 'Session not found' }, 404);

      const result = await toolExecutor(name, args || {});
      return c.json(result);
    } catch (error: any) {
      return c.json({ error: error.message }, 500);
    }
  });

  app.post('/cli/session/new', async (c) => {
    try {
      const session = sessionStore.createSession();
      return c.json({ id: session.id });
    } catch (error: any) {
      return c.json({ error: error.message }, 400);
    }
  });

  app.get('/cli/sessions', (c) => {
    const sessions = sessionStore.listSessions();
    return c.json({
      sessions: sessions.map(s => ({
        id: s.id,
        createdAt: s.createdAt,
      })),
    });
  });

  app.post('/cli/session/delete', async (c) => {
    const { sessionId } = await c.req.json();
    const ok = sessionStore.deleteSession(sessionId);
    if (!ok) return c.json({ error: 'Session not found' }, 404);
    await executorManager.remove(sessionId).catch(() => {});
    return c.json({ success: true });
  });

  app.post('/cli/session/reset', async (c) => {
    const { sessionId } = await c.req.json();
    const ok = sessionStore.resetSession(sessionId);
    if (!ok) return c.json({ error: 'Session not found' }, 404);

    const executor = executorManager.get(sessionId);
    if (executor) {
      await executor.reset();
    }

    return c.json({ success: true });
  });
}
