import { createServer } from 'http';
import express from 'express';
import { Server as SocketServer, type Socket } from 'socket.io';
import { timingSafeEqual, randomBytes, createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { ServerConfig, CursorState, CommandPayload } from './types.js';
import { AgentRegistry } from './agent-registry.js';
import {
  WEBAPP_SESSION_COOKIE,
  createWebappSessionStore,
  parseSessionCookie,
  type WebappSessionStore,
} from './webapp-sessions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ADMIN_COOKIE = 'cursor_remote_admin';
const SESSION_MAX_AGE = 10 * 365 * 24 * 60 * 60;

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function adminToken(password: string): string {
  return createHash('sha256').update(`admin:${password}`).digest('hex');
}

export class CloudHub {
  private config: ServerConfig;
  private app = express();
  private httpServer = createServer(this.app);
  private io = new SocketServer(this.httpServer, {
    serveClient: false,
    cors: { origin: true, methods: ['GET', 'POST'], credentials: true },
    maxHttpBufferSize: 5e6,
  });
  private agents = new AgentRegistry();
  private sessions: WebappSessionStore;
  private packageVersion: string;
  private lastState = new Map<string, CursorState>();
  private adminPassword: string;

  constructor(config: ServerConfig) {
    this.config = config;
    this.sessions = createWebappSessionStore(config.dataDir);
    this.adminPassword = config.adminPassword;
    this.packageVersion = this.readVersion();
    this.setupRoutes();
    this.setupSockets();
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.config.serverPort, this.config.serverHost, () => {
        console.log(`[cloud-hub] Listening on http://${this.config.serverHost}:${this.config.serverPort}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.io.close();
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  private readVersion(): string {
    for (const p of [join(__dirname, '..', '..', 'package.json'), join(__dirname, '..', 'package.json')]) {
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf-8')) as { name?: string; version?: string };
        if (pkg.name === 'cursor-remote' && pkg.version) return pkg.version;
      } catch { /* next */ }
    }
    return '0.0.0';
  }

  private resolveSession(req: express.Request): string | undefined {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      const t = auth.slice(7).trim();
      if (this.sessions.has(t)) return t;
    }
    const fromCookie = parseSessionCookie(req.headers.cookie, WEBAPP_SESSION_COOKIE);
    if (fromCookie && this.sessions.has(fromCookie)) return fromCookie;
    return undefined;
  }

  private isAdmin(req: express.Request): boolean {
    const c = parseSessionCookie(req.headers.cookie, ADMIN_COOKIE);
    return !!c && safeEqual(c, adminToken(this.adminPassword));
  }

  private setupRoutes(): void {
    const clientDir = join(__dirname, '..', 'client');
    const landingDir = join(__dirname, '..', 'landing');
    const downloadsDir = join(__dirname, '..', 'downloads');
    const cacheBust = Date.now().toString(36);

    this.app.use(express.json({ limit: '2mb' }));
    this.app.use(express.urlencoded({ extended: false }));

    this.app.get('/health', (_req, res) => {
      res.json({
        ok: true,
        mode: 'cloud-hub',
        version: this.packageVersion,
        agents: this.agents.list().length,
        authRequired: true,
        pairingEnabled: true,
      });
    });

    // --- Landing + downloads (same as relay) ---
    this.app.get('/', (_req, res) => {
      try {
        let html = readFileSync(join(landingDir, 'index.html'), 'utf-8');
        html = html.replace(/(href)="(\/landing\.css)"/g, `$1="$2?v=${cacheBust}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html);
      } catch {
        res.status(500).send('Landing missing');
      }
    });
    this.app.get('/landing.css', (_req, res) => {
      res.sendFile(join(landingDir, 'landing.css'), (err) => { if (err) res.status(404).end(); });
    });
    this.app.get('/download/cursor-remote.vsix', (_req, res) => {
      res.download(join(downloadsDir, 'cursor-remote.vsix'), `cursor-remote-${this.packageVersion}.vsix`, (err) => {
        if (err) res.status(404).type('text').send('VSIX not found');
      });
    });
    this.app.get('/download/cursor-remote.apk', (_req, res) => {
      res.download(join(downloadsDir, 'cursor-remote.apk'), 'cursor-remote-mobile.apk', (err) => {
        if (err) res.status(404).type('text').send('APK not found');
      });
    });

    const sendApp = (_req: express.Request, res: express.Response) => {
      try {
        let html = readFileSync(join(clientDir, 'index.html'), 'utf-8');
        if (!html.includes('<base ')) html = html.replace('<head>', '<head>\n  <base href="/app/">');
        html = html.replace(/(src|href)="(?!https?:|\/)([^"]+)\.(js|css|webmanifest|png)"/g, `$1="$2.$3?v=${cacheBust}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.type('html').send(html);
      } catch {
        res.status(500).send('Client missing');
      }
    };
    this.app.get('/app', sendApp);
    this.app.get('/app/', sendApp);
    this.app.use('/app', express.static(clientDir, { etag: true }));

    // Pairing against an online agent
    this.app.post('/api/pair', (req, res) => {
      const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
      const agent = this.agents.byPairCode(code);
      if (!agent) return res.status(404).json({ error: 'Invalid or expired code' });
      const token = randomBytes(32).toString('hex');
      this.sessions.add(token);
      this.agents.bindSession(token, agent.id);
      // rotate code after use (single-use)
      this.agents.rotatePairCode(agent.id);
      const sock = this.io.sockets.sockets.get(agent.socketId);
      sock?.emit('agent:pair-code', { pairCode: this.agents.get(agent.id)?.pairCode });
      res.setHeader(
        'Set-Cookie',
        [
          `${WEBAPP_SESSION_COOKIE}=${encodeURIComponent(token)}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          `Max-Age=${SESSION_MAX_AGE}`,
        ].join('; ')
      );
      console.log(`[cloud-hub] Paired client → agent ${agent.id} (${agent.name})`);
      return res.json({ token, agentId: agent.id, agentName: agent.name });
    });

    // Agents mint codes via socket; HTTP kept for diagnostics
    this.app.post('/api/pair/code', (req, res) => {
      const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : '';
      const agent = agentId ? this.agents.get(agentId) : undefined;
      if (!agent) return res.status(404).json({ error: 'Agent offline' });
      const pairCode = this.agents.rotatePairCode(agent.id) ?? agent.pairCode;
      return res.json({ code: pairCode, expiresInMs: null, agentId: agent.id });
    });

    this.app.get('/login', (_req, res) => {
      res.redirect('/app');
    });

    // --- Admin ---
    this.app.get('/list-table', (req, res) => {
      if (!this.isAdmin(req)) {
        res.type('html').send(adminLoginHtml());
        return;
      }
      res.type('html').send(adminTableHtml(this.agents.list(), this.packageVersion));
    });

    this.app.post('/list-table/login', (req, res) => {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!safeEqual(password, this.adminPassword)) {
        return res.status(401).type('html').send(adminLoginHtml('Senha incorreta'));
      }
      res.setHeader(
        'Set-Cookie',
        [
          `${ADMIN_COOKIE}=${adminToken(this.adminPassword)}`,
          'Path=/',
          'HttpOnly',
          'SameSite=Lax',
          `Max-Age=${7 * 24 * 60 * 60}`,
        ].join('; ')
      );
      return res.redirect('/list-table');
    });

    this.app.post('/list-table/kick', (req, res) => {
      if (!this.isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const id = typeof req.body?.agentId === 'string' ? req.body.agentId : '';
      const kicked = this.agents.kick(id);
      if (kicked) {
        const sock = this.io.sockets.sockets.get(kicked.socketId);
        sock?.disconnect(true);
        this.io.to(`agent:${id}`).emit('hub:agent-offline', { agentId: id });
      }
      return res.redirect('/list-table');
    });

    this.app.post('/list-table/rotate', (req, res) => {
      if (!this.isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const id = typeof req.body?.agentId === 'string' ? req.body.agentId : '';
      const code = this.agents.rotatePairCode(id);
      const agent = this.agents.get(id);
      if (agent && code) {
        this.io.sockets.sockets.get(agent.socketId)?.emit('agent:pair-code', { pairCode: code });
      }
      return res.redirect('/list-table');
    });

    this.app.get('/list-table/api.json', (req, res) => {
      if (!this.isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      return res.json({ agents: this.agents.list(), version: this.packageVersion });
    });
  }

  private setupSockets(): void {
    this.io.use((socket, next) => {
      const role = socket.handshake.auth?.role;
      if (role === 'agent') return next();

      const raw = socket.handshake.auth?.token;
      const bearer = typeof raw === 'string' ? raw.trim() : '';
      if (bearer && this.sessions.has(bearer) && this.agents.agentForSession(bearer)) {
        (socket.data as { sessionToken?: string; agentId?: string }).sessionToken = bearer;
        (socket.data as { agentId?: string }).agentId = this.agents.agentForSession(bearer);
        return next();
      }
      const cookie = parseSessionCookie(
        typeof socket.handshake.headers.cookie === 'string' ? socket.handshake.headers.cookie : undefined,
        WEBAPP_SESSION_COOKIE
      );
      if (cookie && this.sessions.has(cookie) && this.agents.agentForSession(cookie)) {
        (socket.data as { sessionToken?: string; agentId?: string }).sessionToken = cookie;
        (socket.data as { agentId?: string }).agentId = this.agents.agentForSession(cookie);
        return next();
      }
      next(new Error('Unauthorized'));
    });

    this.io.on('connection', (socket) => {
      const role = socket.handshake.auth?.role;
      if (role === 'agent') {
        this.handleAgent(socket);
        return;
      }
      this.handleClient(socket);
    });
  }

  private handleAgent(socket: Socket): void {
    const auth = socket.handshake.auth ?? {};
    const info = this.agents.register({
      id: typeof auth.agentId === 'string' ? auth.agentId : undefined,
      name: typeof auth.name === 'string' ? auth.name : 'Cursor',
      version: typeof auth.version === 'string' ? auth.version : 'unknown',
      hostname: typeof auth.hostname === 'string' ? auth.hostname : 'unknown',
      socketId: socket.id,
    });
    socket.join(`agent-host:${info.id}`);
    socket.emit('agent:registered', {
      agentId: info.id,
      pairCode: info.pairCode,
      hubPublicUrl: this.config.cloudPublicUrl || undefined,
    });
    console.log(`[cloud-hub] Agent online: ${info.name} (${info.id}) code=${info.pairCode}`);

    socket.on('agent:state:full', (state: CursorState) => {
      this.agents.touch(info.id, {
        connected: !!state?.connected,
        agentStatus: state?.agentStatus ?? 'idle',
        lastStateAt: Date.now(),
      });
      this.lastState.set(info.id, state);
      this.io.to(`agent:${info.id}`).emit('state:full', state);
    });

    socket.on('agent:state:patch', (patch: Partial<CursorState>) => {
      this.agents.touch(info.id, {
        connected: patch.connected,
        agentStatus: patch.agentStatus,
        lastStateAt: Date.now(),
      });
      const prev = this.lastState.get(info.id);
      if (prev) this.lastState.set(info.id, { ...prev, ...patch } as CursorState);
      this.io.to(`agent:${info.id}`).emit('state:patch', patch);
    });

    socket.on('agent:windows:snapshots', (payload: unknown) => {
      this.io.to(`agent:${info.id}`).emit('windows:snapshots', payload);
    });

    socket.on('agent:command:result', (result: unknown) => {
      this.io.to(`agent:${info.id}`).emit('command:result', result);
    });

    socket.on('disconnect', () => {
      const gone = this.agents.unregisterSocket(socket.id);
      if (gone) {
        console.log(`[cloud-hub] Agent offline: ${gone.name} (${gone.id})`);
        this.io.to(`agent:${gone.id}`).emit('hub:agent-offline', { agentId: gone.id });
        this.lastState.delete(gone.id);
      }
    });
  }

  private handleClient(socket: Socket): void {
    const agentId = (socket.data as { agentId?: string }).agentId;
    if (!agentId) {
      socket.disconnect(true);
      return;
    }
    const agent = this.agents.get(agentId);
    if (!agent) {
      socket.emit('hub:agent-offline', { agentId });
      socket.disconnect(true);
      return;
    }

    socket.join(`agent:${agentId}`);
    const room = this.io.sockets.adapter.rooms.get(`agent:${agentId}`);
    this.agents.setClientCount(agentId, room?.size ?? 1);
    console.log(`[cloud-hub] Client ${socket.id} → agent ${agentId}`);

    const cached = this.lastState.get(agentId);
    if (cached) socket.emit('state:full', cached);
    else {
      socket.emit('state:full', {
        connected: false,
        extractorStatus: 'idle',
        lastExtractionAt: null,
        consecutiveExtractionFailures: 0,
        lastExtractionError: null,
        agentStatus: 'idle',
        agentActivityText: null,
        agentActivityLive: false,
        agentActivitySource: 'none',
        messages: [],
        pendingApprovals: [],
        inputAvailable: false,
        chatTabs: [],
        activeComposerId: '',
        mode: { current: 'agent', available: [] },
        model: { current: 'Auto', currentId: '' },
        windows: [],
        activeWindowId: '',
        composerQueue: { items: [] },
        questionnaire: null,
      } satisfies CursorState);
      // ask agent to push fresh state
      this.io.to(`agent-host:${agentId}`).emit('agent:request-state');
    }

    const forward = (event: string) => {
      socket.on(event, (payload: CommandPayload) => {
        this.io.to(`agent-host:${agentId}`).emit('agent:command', { event, payload });
      });
    };
    for (const ev of [
      'command:send_message',
      'command:approve',
      'command:approve_all',
      'command:reject',
      'command:switch_tab',
      'command:new_chat',
      'command:set_mode',
      'command:set_model',
      'command:get_model_options',
      'command:get_plan_full',
      'command:get_plan_model_options',
      'command:set_plan_model',
      'command:click_action',
      'command:switch_window',
      'command:answer_questionnaire',
      'command:skip_questionnaire',
    ]) {
      forward(ev);
    }

    socket.on('disconnect', () => {
      const r = this.io.sockets.adapter.rooms.get(`agent:${agentId}`);
      this.agents.setClientCount(agentId, r?.size ?? 0);
    });
  }
}

function adminLoginHtml(error = ''): string {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin — CursorRemote</title>
<style>
body{font-family:system-ui,sans-serif;background:#0a0b0d;color:#f2f0ea;min-height:100dvh;display:grid;place-items:center;margin:0}
form{width:min(360px,92vw);padding:28px;border:1px solid rgba(255,255,255,.1);border-radius:14px;background:#12141a}
h1{font-size:1.2rem;margin:0 0 16px}
input{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#0a0b0d;color:#fff;margin-bottom:12px}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#e8a54b;color:#1a1208;font-weight:700;cursor:pointer}
.err{color:#f87171;font-size:.9rem;margin-bottom:10px}
</style></head><body>
<form method="POST" action="/list-table/login">
<h1>Admin CursorRemote</h1>
${error ? `<p class="err">${error}</p>` : ''}
<input type="password" name="password" placeholder="Senha" autofocus required/>
<button type="submit">Entrar</button>
</form></body></html>`;
}

function adminTableHtml(agents: ReturnType<AgentRegistry['list']>, version: string): string {
  const rows = agents.map((a) => {
    const age = Math.round((Date.now() - a.lastSeenAt) / 1000);
    return `<tr>
      <td><code>${a.id}</code></td>
      <td>${escapeHtml(a.name)}<br/><span class="muted">${escapeHtml(a.hostname)}</span></td>
      <td>${a.connected ? 'CDP ok' : 'sem CDP'} · ${escapeHtml(a.agentStatus)}</td>
      <td>${a.clientCount}</td>
      <td><code>${a.pairCode}</code></td>
      <td>${age}s</td>
      <td class="actions">
        <form method="POST" action="/list-table/rotate"><input type="hidden" name="agentId" value="${a.id}"/><button type="submit">Novo código</button></form>
        <form method="POST" action="/list-table/kick"><input type="hidden" name="agentId" value="${a.id}"/><button type="submit" class="danger">Kick</button></form>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agents — CursorRemote</title>
<meta http-equiv="refresh" content="8"/>
<style>
body{font-family:system-ui,sans-serif;background:#0a0b0d;color:#f2f0ea;margin:0;padding:24px}
h1{font-size:1.4rem;margin:0 0 6px}
.sub{color:rgba(242,240,234,.5);margin-bottom:20px}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid rgba(255,255,255,.08);vertical-align:top}
th{color:rgba(242,240,234,.55);font-weight:600}
code{font-family:ui-monospace,monospace;font-size:.85em}
.muted{color:rgba(242,240,234,.4);font-size:.85em}
.actions{display:flex;gap:6px;flex-wrap:wrap}
button{padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:#1a1c22;color:#f2f0ea;cursor:pointer}
button.danger{border-color:#f87171;color:#f87171}
.empty{padding:40px;text-align:center;color:rgba(242,240,234,.45)}
</style></head><body>
<h1>Agents online</h1>
<p class="sub">Hub v${escapeHtml(version)} · ${agents.length} agent(s) · auto-refresh 8s</p>
${agents.length === 0 ? '<p class="empty">Nenhum agent conectado. A extensão precisa apontar CLOUD_HUB_URL para este hub.</p>' : `
<table>
<thead><tr><th>ID</th><th>Nome</th><th>Status</th><th>Clients</th><th>Pair code</th><th>Seen</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>`}
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
