import { hostname as osHostname } from 'os';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { io, type Socket } from 'socket.io-client';
import type { CommandExecutor } from './command-executor.js';
import type { StateManager } from './state-manager.js';
import type { WindowMonitor } from './window-monitor.js';
import type { CommandPayload, CommandResult, CursorState } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CloudTunnelStatus {
  connected: boolean;
  agentId: string;
  pairCode: string;
  hubUrl: string;
  error: string | null;
}

/**
 * Outbound tunnel: local Cursor relay → cloud hub.
 * Phone clients hit the hub; commands come back here.
 */
export class CloudTunnel {
  private socket: Socket | null = null;
  private hubUrl: string;
  private agentId = '';
  private pairCode = '';
  private error: string | null = null;
  private version: string;
  private name: string;

  constructor(
    hubUrl: string,
    private stateManager: StateManager,
    private commandExecutor: CommandExecutor,
    private windowMonitor: WindowMonitor,
    name?: string
  ) {
    this.hubUrl = hubUrl.replace(/\/$/, '');
    this.name = name || osHostname() || 'Cursor';
    this.version = this.readVersion();
  }

  getStatus(): CloudTunnelStatus {
    return {
      connected: !!this.socket?.connected,
      agentId: this.agentId,
      pairCode: this.pairCode,
      hubUrl: this.hubUrl,
      error: this.error,
    };
  }

  start(): void {
    if (this.socket) return;
    console.log(`[cloud-tunnel] Connecting to hub ${this.hubUrl}`);

    this.socket = io(this.hubUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 15000,
      auth: (cb) => {
        cb({
          role: 'agent',
          agentId: this.agentId || undefined,
          name: this.name,
          version: this.version,
          hostname: osHostname(),
        });
      },
    });

    this.socket.on('connect', () => {
      this.error = null;
      console.log('[cloud-tunnel] Connected to hub');
    });

    this.socket.on('connect_error', (err) => {
      this.error = err.message;
      console.warn(`[cloud-tunnel] Connect error: ${err.message}`);
    });

    this.socket.on('agent:registered', (payload: { agentId: string; pairCode: string }) => {
      this.agentId = payload.agentId;
      this.pairCode = payload.pairCode;
      console.log(`[cloud-tunnel] Registered agentId=${this.agentId} pair=${this.pairCode}`);
      this.pushFullState();
    });

    this.socket.on('agent:pair-code', (payload: { pairCode: string }) => {
      this.pairCode = payload.pairCode;
      console.log(`[cloud-tunnel] Pair code updated: ${this.pairCode}`);
    });

    this.socket.on('agent:request-state', () => this.pushFullState());

    this.socket.on('agent:command', async (msg: { event: string; payload: CommandPayload }) => {
      const result = await this.dispatch(msg.event, msg.payload);
      this.socket?.emit('agent:command:result', result);
    });

    this.stateManager.on('state:full', (state: CursorState) => {
      this.socket?.emit('agent:state:full', state);
    });
    this.stateManager.on('state:patch', (patch: Partial<CursorState>) => {
      this.socket?.emit('agent:state:patch', patch);
    });
  }

  stop(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  private pushFullState(): void {
    if (!this.socket?.connected) return;
    this.socket.emit('agent:state:full', this.stateManager.getCurrentState());
    this.socket.emit('agent:windows:snapshots', this.windowMonitor.getSnapshotsForClient());
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

  private async dispatch(event: string, payload: CommandPayload): Promise<CommandResult> {
    const id = payload.commandId ?? 'unknown';
    try {
      switch (event) {
        case 'command:send_message':
          if (!payload.text) return { commandId: id, ok: false, error: 'Missing text' };
          return await this.commandExecutor.sendMessage(id, payload.text);
        case 'command:approve':
          if (!payload.selectorPath) return { commandId: id, ok: false, error: 'Missing selectorPath' };
          return await this.commandExecutor.clickApproval(id, payload.selectorPath);
        case 'command:approve_all':
          return await this.commandExecutor.approveAll(id);
        case 'command:reject':
          if (!payload.selectorPath) return { commandId: id, ok: false, error: 'Missing selectorPath' };
          return await this.commandExecutor.reject(id, payload.selectorPath);
        case 'command:switch_tab':
          return await this.commandExecutor.switchTab(id, payload.tabTitle ?? '', payload.selectorPath);
        case 'command:new_chat':
          return await this.commandExecutor.newChat(id);
        case 'command:set_mode':
          if (!payload.mode) return { commandId: id, ok: false, error: 'Missing mode' };
          return await this.commandExecutor.setMode(id, payload.mode);
        case 'command:set_model':
          if (!payload.modelId) return { commandId: id, ok: false, error: 'Missing modelId' };
          return await this.commandExecutor.setModel(id, payload.modelId);
        case 'command:get_model_options':
          return await this.commandExecutor.getModelOptions(id);
        case 'command:click_action':
          if (!payload.selectorPath) return { commandId: id, ok: false, error: 'Missing selectorPath' };
          return await this.commandExecutor.clickAction(id, payload.selectorPath);
        case 'command:switch_window':
          if (!payload.windowId) return { commandId: id, ok: false, error: 'Missing windowId' };
          // window switch is handled by window monitor via command executor if available
          if (typeof (this.commandExecutor as unknown as { switchWindow?: Function }).switchWindow === 'function') {
            return await (this.commandExecutor as unknown as { switchWindow: (a: string, b: string) => Promise<CommandResult> })
              .switchWindow(id, payload.windowId);
          }
          return { commandId: id, ok: false, error: 'switch_window not available' };
        case 'command:get_plan_model_options':
          if (!payload.selectorPath) return { commandId: id, ok: false, error: 'Missing selectorPath' };
          return await this.commandExecutor.getPlanModelOptions(id, payload.selectorPath);
        case 'command:set_plan_model':
          if (!payload.selectorPath || !payload.planModelId) {
            return { commandId: id, ok: false, error: 'Missing selectorPath or planModelId' };
          }
          return await this.commandExecutor.setPlanModel(id, payload.selectorPath, payload.planModelId);
        case 'command:answer_questionnaire':
        case 'command:skip_questionnaire':
        case 'command:get_plan_full':
          return { commandId: id, ok: false, error: `${event} must be handled on hub/local relay` };
        default:
          return { commandId: id, ok: false, error: `Unknown event ${event}` };
      }
    } catch (err) {
      return { commandId: id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
