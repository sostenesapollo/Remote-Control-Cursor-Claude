import { randomBytes } from 'crypto';

export interface AgentInfo {
  id: string;
  name: string;
  version: string;
  hostname: string;
  socketId: string;
  connectedAt: number;
  lastSeenAt: number;
  pairCode: string;
  clientCount: number;
  connected: boolean;
  agentStatus: string;
  lastStateAt: number | null;
}

function makeId(): string {
  return randomBytes(8).toString('hex');
}

function makePairCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let raw = '';
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i++) raw += alphabet[bytes[i]! % alphabet.length];
  return `${raw.slice(0, 3)}-${raw.slice(3)}`;
}

export class AgentRegistry {
  private byId = new Map<string, AgentInfo>();
  private socketToAgent = new Map<string, string>();
  private pairToAgent = new Map<string, string>();
  /** sessionToken → agentId */
  private sessionToAgent = new Map<string, string>();

  register(input: {
    id?: string;
    name: string;
    version: string;
    hostname: string;
    socketId: string;
  }): AgentInfo {
    const existingId = input.id && this.byId.has(input.id) ? input.id : undefined;
    if (existingId) {
      const prev = this.byId.get(existingId)!;
      this.socketToAgent.delete(prev.socketId);
      this.pairToAgent.delete(prev.pairCode);
    }

    const id = existingId ?? makeId();
    const pairCode = makePairCode();
    const now = Date.now();
    const info: AgentInfo = {
      id,
      name: input.name || 'Cursor',
      version: input.version || 'unknown',
      hostname: input.hostname || 'unknown',
      socketId: input.socketId,
      connectedAt: existingId ? this.byId.get(existingId)!.connectedAt : now,
      lastSeenAt: now,
      pairCode,
      clientCount: existingId ? this.byId.get(existingId)!.clientCount : 0,
      connected: false,
      agentStatus: 'idle',
      lastStateAt: existingId ? this.byId.get(existingId)!.lastStateAt : null,
    };
    this.byId.set(id, info);
    this.socketToAgent.set(input.socketId, id);
    this.pairToAgent.set(pairCode, id);
    return info;
  }

  touch(agentId: string, patch?: Partial<Pick<AgentInfo, 'connected' | 'agentStatus' | 'lastStateAt'>>): void {
    const a = this.byId.get(agentId);
    if (!a) return;
    a.lastSeenAt = Date.now();
    if (patch?.connected !== undefined) a.connected = patch.connected;
    if (patch?.agentStatus !== undefined) a.agentStatus = patch.agentStatus;
    if (patch?.lastStateAt !== undefined) a.lastStateAt = patch.lastStateAt;
  }

  rotatePairCode(agentId: string): string | undefined {
    const a = this.byId.get(agentId);
    if (!a) return undefined;
    this.pairToAgent.delete(a.pairCode);
    a.pairCode = makePairCode();
    this.pairToAgent.set(a.pairCode, agentId);
    return a.pairCode;
  }

  unregisterSocket(socketId: string): AgentInfo | undefined {
    const id = this.socketToAgent.get(socketId);
    if (!id) return undefined;
    const a = this.byId.get(id);
    this.socketToAgent.delete(socketId);
    if (a) {
      this.pairToAgent.delete(a.pairCode);
      this.byId.delete(id);
    }
    return a;
  }

  get(agentId: string): AgentInfo | undefined {
    return this.byId.get(agentId);
  }

  bySocket(socketId: string): AgentInfo | undefined {
    const id = this.socketToAgent.get(socketId);
    return id ? this.byId.get(id) : undefined;
  }

  byPairCode(code: string): AgentInfo | undefined {
    const id = this.pairToAgent.get(code.trim().toUpperCase());
    return id ? this.byId.get(id) : undefined;
  }

  bindSession(token: string, agentId: string): void {
    this.sessionToAgent.set(token, agentId);
  }

  agentForSession(token: string): string | undefined {
    return this.sessionToAgent.get(token);
  }

  unbindSession(token: string): void {
    this.sessionToAgent.delete(token);
  }

  setClientCount(agentId: string, count: number): void {
    const a = this.byId.get(agentId);
    if (a) a.clientCount = count;
  }

  list(): AgentInfo[] {
    return [...this.byId.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  kick(agentId: string): AgentInfo | undefined {
    const a = this.byId.get(agentId);
    if (!a) return undefined;
    this.socketToAgent.delete(a.socketId);
    this.pairToAgent.delete(a.pairCode);
    this.byId.delete(agentId);
    for (const [token, id] of this.sessionToAgent) {
      if (id === agentId) this.sessionToAgent.delete(token);
    }
    return a;
  }
}
