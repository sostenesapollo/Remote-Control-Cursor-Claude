import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer, type Socket } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import type { ServerConfig, CursorState, CommandPayload, CommandResult } from './types.js';
import type { StateManager } from './state-manager.js';
import type { CommandExecutor } from './command-executor.js';
import type { CDPBridge } from './cdp-bridge.js';
import { markdownToWebHtml, readPlanFile } from './plan-files.js';
import {
  WEBAPP_SESSION_COOKIE,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from './webapp-sessions.js';
import { createPairCodeStore, type PairCodeStore } from './pair-codes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const LOGIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#0d0d12">
  <title>CursorRemote — Pair</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: radial-gradient(ellipse at top, #161623 0%, #0d0d12 60%);
      color: rgba(235,235,245,0.92);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100dvh;
      padding: 24px;
      -webkit-font-smoothing: antialiased;
    }
    .pair-card {
      width: 100%; max-width: 380px; padding: 36px 28px;
      background: rgba(28,28,40,0.72); backdrop-filter: blur(20px);
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }
    .logo {
      width: 56px; height: 56px; margin: 0 auto 20px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 16px; display: flex; align-items: center; justify-content: center;
      font-size: 28px;
    }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; text-align: center; letter-spacing: -0.02em; }
    .subtitle { font-size: 14px; color: rgba(235,235,245,0.5); margin-bottom: 28px; text-align: center; line-height: 1.5; }
    .code-input {
      width: 100%; padding: 14px 16px; font-size: 22px; font-weight: 600;
      text-align: center; letter-spacing: 0.1em; text-transform: uppercase;
      background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
      color: rgba(235,235,245,0.95); outline: none; font-family: 'SF Mono', 'Fira Code', monospace;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .code-input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.18); }
    .code-input::placeholder { color: rgba(235,235,245,0.25); letter-spacing: 0.1em; }
    button {
      width: 100%; padding: 14px; margin-top: 16px; font-size: 16px; font-weight: 600;
      background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; border-radius: 12px; cursor: pointer;
      transition: opacity 0.15s, transform 0.1s;
    }
    button:hover { opacity: 0.9; }
    button:active { transform: scale(0.98); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .error { color: #f87171; font-size: 13px; margin-top: 12px; text-align: center; display: none; }
    .hint { font-size: 12px; color: rgba(235,235,245,0.35); margin-top: 20px; text-align: center; line-height: 1.5; }
  </style>
</head>
<body>
  <form class="pair-card" id="form">
    <div class="logo">⚡</div>
    <h1>Connect</h1>
    <p class="subtitle">Enter the pairing code from your CursorRemote setup</p>
    <input type="text" class="code-input" id="code" placeholder="XXX-XXX" autocomplete="one-time-code" autofocus required>
    <button type="submit" id="btn">Pair device</button>
    <p class="error" id="err"></p>
    <p class="hint">Find the code in Cursor: Command Palette → CursorRemote: Setup</p>
  </form>
  <script>
    const form = document.getElementById('form');
    const codeInput = document.getElementById('code');
    const btn = document.getElementById('btn');
    const err = document.getElementById('err');
    codeInput.addEventListener('input', () => {
      let v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (v.length > 3) v = v.slice(0,3) + '-' + v.slice(3,6);
      codeInput.value = v;
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.style.display = 'none';
      try {
        const res = await fetch('/api/pair', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: codeInput.value }),
        });
        const data = await res.json();
        if (res.ok && data.token) {
          localStorage.setItem('cursor-remote-token', data.token);
          window.location.href = '/';
        } else {
          err.textContent = data.error || 'Invalid code';
          err.style.display = 'block';
        }
      } catch {
        err.textContent = 'Network error';
        err.style.display = 'block';
      }
      btn.disabled = false;
    });
  </script>
</body>
</html>`;

export class Relay {
  private config: ServerConfig;
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private io: SocketServer;
  private stateManager: StateManager;
  private commandExecutor: CommandExecutor;
  private cdpBridge: CDPBridge;

  private sessionStore: WebappSessionStore;
  private pairCodeStore: PairCodeStore;
  private loginAttempts = new Map<string, RateLimitEntry>();

  /** Max-Age for session cookie (30 days), aligned with typical “stay signed in” expectation. */
  private static readonly SESSION_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;

  /** Auth is enabled if a password is set OR pairing is enabled (default). */
  private get authEnabled(): boolean {
    return this.config.webappPassword.length > 0 || this.config.pairingEnabled;
  }

  /** Legacy password auth only — pairing uses its own flow. */
  private get passwordAuthEnabled(): boolean {
    return this.config.webappPassword.length > 0;
  }

  constructor(
    config: ServerConfig,
    stateManager: StateManager,
    commandExecutor: CommandExecutor,
    cdpBridge: CDPBridge
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.commandExecutor = commandExecutor;
    this.cdpBridge = cdpBridge;
    this.sessionStore = createWebappSessionStore(config.dataDir);
    this.pairCodeStore = createPairCodeStore(config.dataDir);

    this.app = express();
    this.httpServer = createServer(this.app);
    this.io = new SocketServer(this.httpServer, {
      serveClient: false,
      cors: {
        origin: true,
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    this.setupRoutes();
    this.setupSocketHandlers();
    this.setupStateForwarding();

    if (this.passwordAuthEnabled) {
      console.log('[relay] Web app password protection enabled');
    }
    if (this.config.pairingEnabled) {
      console.log('[relay] Pairing-code auth enabled');
    }
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.serverPort, this.config.serverHost, () => {
        console.log(
          `[relay] Server listening on http://${this.config.serverHost}:${this.config.serverPort}`
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.io.close();
    return new Promise((resolve) => {
      this.httpServer.close(() => resolve());
    });
  }

  private getClientIp(req: express.Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
    return req.socket.remoteAddress ?? 'unknown';
  }

  private checkRateLimit(ip: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const entry = this.loginAttempts.get(ip);

    if (!entry || now >= entry.resetAt) {
      this.loginAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, retryAfter: 0 };
    }

    if (entry.count >= 10) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.count++;
    return { allowed: true, retryAfter: 0 };
  }

  /** First matching credential that exists in the persisted session store. */
  private resolveHttpSession(req: express.Request): string | undefined {
    if (!this.authEnabled) return undefined;
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (this.sessionStore.has(t)) return t;
    }
    const fromCookie = parseSessionCookie(req.headers.cookie, WEBAPP_SESSION_COOKIE);
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private resolveSocketSession(socket: Socket): string | undefined {
    if (!this.authEnabled) return undefined;
    const raw = socket.handshake.auth?.token;
    const bearer = typeof raw === 'string' ? raw.trim() : '';
    if (bearer && this.sessionStore.has(bearer)) return bearer;
    const cookieHeader = socket.handshake.headers.cookie;
    const fromCookie = parseSessionCookie(
      typeof cookieHeader === 'string' ? cookieHeader : undefined,
      WEBAPP_SESSION_COOKIE
    );
    if (fromCookie && this.sessionStore.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private setupRoutes(): void {
    const clientDir = join(__dirname, '..', 'client');

    this.app.use(express.json());

    this.app.get('/login', (_req, res) => {
      if (!this.authEnabled) return res.redirect('/');
      res.type('html').send(LOGIN_PAGE_HTML);
    });

    // --- Pairing: generate a code (extension calls this) ---
    this.app.post('/api/pair/code', (req, res) => {
      if (!this.config.pairingEnabled) {
        return res.status(403).json({ error: 'Pairing disabled' });
      }
      // Optional shared secret to restrict who can mint codes. Defaults to none
      // (extension is trusted since it spawns the server locally).
      const expectedSecret = process.env.PAIR_CODE_SECRET ?? '';
      if (expectedSecret) {
        const provided = req.headers['x-pair-secret'];
        if (typeof provided !== 'string' || provided !== expectedSecret) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
      }
      const code = this.pairCodeStore.generate();
      console.log('[relay] Generated pairing code');
      res.json({ code, expiresInMs: 10 * 60 * 1000 });
    });

    // --- Pairing: redeem a code (web/mobile client calls this) ---
    this.app.post('/api/pair', (req, res) => {
      if (!this.config.pairingEnabled) {
        return res.status(403).json({ error: 'Pairing disabled' });
      }
      const ip = this.getClientIp(req);
      const { allowed, retryAfter } = this.checkRateLimit(ip);
      if (!allowed) {
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfter}s.` });
      }
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      if (!code) {
        return res.status(400).json({ error: 'Code required' });
      }
      const ok = this.pairCodeStore.consume(code);
      if (!ok) {
        console.warn(`[relay] Failed pairing attempt from ${ip}`);
        return res.status(401).json({ error: 'Invalid or expired code' });
      }
      const token = randomBytes(32).toString('hex');
      this.sessionStore.add(token);
      console.log(`[relay] Successful pairing from ${ip}`);
      res.setHeader(
        'Set-Cookie',
        [
          `${WEBAPP_SESSION_COOKIE}=${token}`,
          'HttpOnly',
          'Path=/',
          'SameSite=Lax',
          `Max-Age=${Relay.SESSION_COOKIE_MAX_AGE_SEC}`,
        ].join('; ')
      );
      return res.json({ token });
    });

    this.app.post('/api/login', (req, res) => {
      if (!this.passwordAuthEnabled) {
        // Pairing-only mode: legacy login disabled
        if (this.config.pairingEnabled) {
          return res.status(403).json({ error: 'Use pairing code' });
        }
        return res.json({ token: 'no-auth' });
      }

      const ip = this.getClientIp(req);
      const { allowed, retryAfter } = this.checkRateLimit(ip);
      if (!allowed) {
        console.warn(`[relay] Rate limited login from ${ip}`);
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: `Too many attempts. Retry in ${retryAfter}s.` });
      }

      const password = req.body?.password;
      if (typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ error: 'Password required' });
      }

      const expected = Buffer.from(this.config.webappPassword);
      const received = Buffer.from(password);
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        console.warn(`[relay] Failed login attempt from ${ip}`);
        return res.status(401).json({ error: 'Invalid password' });
      }

      const token = randomBytes(32).toString('hex');
      this.sessionStore.add(token);
      console.log(`[relay] Successful login from ${ip}`);
      res.setHeader(
        'Set-Cookie',
        [
          `${WEBAPP_SESSION_COOKIE}=${token}`,
          'HttpOnly',
          'Path=/',
          'SameSite=Lax',
          `Max-Age=${Relay.SESSION_COOKIE_MAX_AGE_SEC}`,
        ].join('; ')
      );
      return res.json({ token });
    });

    this.app.get('/health', (req, res) => {
      const state = this.stateManager.getCurrentState();
      const sessionOk = !this.authEnabled || this.resolveHttpSession(req) !== undefined;
      res.json({
        ok: true,
        authRequired: this.authEnabled,
        pairingEnabled: this.config.pairingEnabled,
        sessionValid: sessionOk,
        connected: state.connected,
        extractorStatus: state.extractorStatus,
        lastExtractionAt: state.lastExtractionAt,
        consecutiveExtractionFailures: state.consecutiveExtractionFailures,
        lastExtractionError: state.lastExtractionError,
        agentStatus: state.agentStatus,
        clients: this.io.engine.clientsCount,
        uptime: process.uptime(),
        windows: state.windows,
        activeWindowId: state.activeWindowId,
        mode: state.mode?.current ?? null,
        model: state.model?.current ?? null,
        chatTabCount: state.chatTabs?.length ?? 0,
        pendingApprovalCount: state.pendingApprovals?.length ?? 0,
        generation: this.stateManager.generation,
      });
    });

    this.app.get('/debug/state', (req, res) => {
      if (this.authEnabled && this.resolveHttpSession(req) === undefined) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const state = this.stateManager.getCurrentState();
      res.json({
        activeWindowId: state.activeWindowId,
        agentStatus: state.agentStatus,
        agentActivityText: state.agentActivityText,
        agentActivityLive: state.agentActivityLive,
        pendingApprovals: state.pendingApprovals,
        chatTabs: state.chatTabs.map((t) => ({
          isActive: t.isActive,
          title: t.title,
          composerId: t.composerId.substring(0, 16),
        })),
        windows: state.windows.map((w) => ({ id: w.id.substring(0, 8), title: w.title })),
        messageCount: state.messages.length,
        lastMessages: state.messages.slice(-3).map((m) => ({
          type: m.type,
          flatIndex: m.flatIndex,
          ...(m.type === 'tool' || m.type === 'run_command' ? {
            actions: 'actions' in m ? m.actions?.length ?? 0 : 0,
          } : {}),
        })),
        generation: this.stateManager.generation,
      });
    });

    const cacheBust = Date.now().toString(36);
    this.app.get('/', (_req, res) => {
      const htmlPath = join(clientDir, 'index.html');
      try {
        let html = readFileSync(htmlPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)\.(js|css)"/g, `$1="$2.$3?v=${cacheBust}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html);
      } catch (err) {
        console.error(`[relay] Failed to serve index.html: ${err}`);
        res.status(500).send('Client files not found');
      }
    });

    this.app.use(express.static(clientDir, {
      etag: true,
      lastModified: true,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      },
    }));

    const authMiddleware: express.RequestHandler = (req, res, next) => {
      if (!this.authEnabled) return next();

      if (this.resolveHttpSession(req)) return next();

      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/login');
    };

    this.app.use(authMiddleware);
  }

  private setupSocketHandlers(): void {
    if (this.authEnabled) {
      this.io.use((socket, next) => {
        const resolved = this.resolveSocketSession(socket);
        if (resolved) return next();
        const raw = socket.handshake.auth?.token;
        const hint =
          typeof raw === 'string' && raw.length > 0
            ? raw.slice(0, 8) + '...'
            : parseSessionCookie(
                typeof socket.handshake.headers.cookie === 'string'
                  ? socket.handshake.headers.cookie
                  : undefined,
                WEBAPP_SESSION_COOKIE
              )
              ? 'cookie-present'
              : 'empty';
        console.warn(`[relay] Socket.io auth rejected (${socket.id}) — ${hint}`);
        next(new Error('Unauthorized'));
      });
    }

    this.io.on('connection', (socket) => {
      console.log(`[relay] Client connected: ${socket.id}`);

      socket.emit('state:full', this.stateManager.getCurrentState());

      socket.on('command:send_message', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.text) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or text',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: send_message from ${socket.id}`);
        const result = await this.commandExecutor.sendMessage(
          payload.commandId,
          payload.text
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve from ${socket.id}`);
        const result = await this.commandExecutor.clickApproval(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:approve_all', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: approve_all from ${socket.id}`);
        const result = await this.commandExecutor.approveAll(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:reject', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: reject from ${socket.id}`);
        const result = await this.commandExecutor.reject(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_tab', async (payload: CommandPayload) => {
        if (!payload.commandId || (!payload.tabTitle && !payload.selectorPath)) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId and tab target',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_tab to "${payload.tabTitle ?? payload.selectorPath}" from ${socket.id}`);
        const result = await this.commandExecutor.switchTab(
          payload.commandId,
          payload.tabTitle ?? '',
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:new_chat', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: new_chat from ${socket.id}`);
        const result = await this.commandExecutor.newChat(payload.commandId);
        socket.emit('command:result', result);
      });

      socket.on('command:set_mode', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modeId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modeId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_mode to ${payload.modeId} from ${socket.id}`);
        const result = await this.commandExecutor.setMode(
          payload.commandId,
          payload.modeId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.modelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or modelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_model to ${payload.modelId} from ${socket.id}`);
        const result = await this.commandExecutor.setModel(
          payload.commandId,
          payload.modelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getModelOptions(
          payload.commandId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:get_plan_full', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.planLabel) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or planLabel',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_full for ${payload.planLabel} from ${socket.id}`);
        const planFile = readPlanFile(payload.planLabel);
        if (!planFile) {
          socket.emit('command:result', {
            commandId: payload.commandId,
            ok: false,
            error: 'Plan file not found',
          } satisfies CommandResult);
          return;
        }
        socket.emit('command:result', {
          commandId: payload.commandId,
          ok: true,
          data: {
            todos: planFile.todos,
            body: planFile.body,
            bodyHtml: markdownToWebHtml(planFile.body),
          },
        } satisfies CommandResult);
      });

      socket.on('command:get_plan_model_options', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: get_plan_model_options from ${socket.id}`);
        const result = await this.commandExecutor.getPlanModelOptions(
          payload.commandId,
          payload.selectorPath
        );
        socket.emit('command:result', result);
      });

      socket.on('command:set_plan_model', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath || !payload.planModelId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId, selectorPath, or planModelId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: set_plan_model to ${payload.planModelId} from ${socket.id}`);
        const result = await this.commandExecutor.setPlanModel(
          payload.commandId,
          payload.selectorPath,
          payload.planModelId
        );
        socket.emit('command:result', result);
      });

      socket.on('command:click_action', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.selectorPath) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or selectorPath',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: click_action from ${socket.id}`);
        const result = await this.commandExecutor.clickAction(
          payload.commandId,
          payload.selectorPath,
          payload.actionLabel
        );
        socket.emit('command:result', result);
      });

      socket.on('command:switch_window', async (payload: CommandPayload) => {
        if (!payload.commandId || !payload.windowId) {
          socket.emit('command:result', {
            commandId: payload.commandId ?? 'unknown',
            ok: false,
            error: 'Missing commandId or windowId',
          } satisfies CommandResult);
          return;
        }
        console.log(`[relay] Command: switch_window to ${payload.windowId} from ${socket.id}`);
        try {
          await this.cdpBridge.switchWindow(payload.windowId);
          socket.emit('command:result', { commandId: payload.commandId, ok: true });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          socket.emit('command:result', { commandId: payload.commandId, ok: false, error: msg });
        }
      });

      socket.on('disconnect', (reason) => {
        console.log(`[relay] Client disconnected: ${socket.id} (${reason})`);
      });
    });
  }

  private setupStateForwarding(): void {
    this.stateManager.on('state:patch', (patch: Partial<CursorState>) => {
      this.io.emit('state:patch', patch);
    });

    this.stateManager.on('connection:changed', (connected: boolean) => {
      this.io.emit('connection:status', { connected });
    });
  }
}
