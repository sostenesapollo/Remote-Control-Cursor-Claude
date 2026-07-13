import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { WindowSnapshot } from './window-monitor.js';

interface PersistedSnapshot {
  windowId: string;
  windowTitle: string;
  messages: WindowSnapshot['messages'];
  chatTabs: WindowSnapshot['chatTabs'];
  pendingApprovals: WindowSnapshot['pendingApprovals'];
  agentStatus: WindowSnapshot['agentStatus'];
  agentActivityText: WindowSnapshot['agentActivityText'];
  agentActivityLive: WindowSnapshot['agentActivityLive'];
  agentActivitySource: WindowSnapshot['agentActivitySource'];
  composerQueue: WindowSnapshot['composerQueue'];
  mode: WindowSnapshot['mode'];
  model: WindowSnapshot['model'];
  questionnaire: WindowSnapshot['questionnaire'];
  activeComposerId: WindowSnapshot['activeComposerId'];
  lastUpdated: number;
}

interface PersistedData {
  snapshots: Record<string, PersistedSnapshot>;
}

const SAVE_DEBOUNCE_MS = 3000;

export class SnapshotStore {
  private persistPath: string | null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(persistPath?: string) {
    this.persistPath = persistPath ?? null;
  }

  load(): Map<string, WindowSnapshot> {
    const out = new Map<string, WindowSnapshot>();
    if (!this.persistPath || !existsSync(this.persistPath)) return out;

    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedData;
      for (const snap of Object.values(data.snapshots ?? {})) {
        if (!snap.windowId) continue;
        out.set(snap.windowId, {
          windowId: snap.windowId,
          windowTitle: snap.windowTitle,
          messages: snap.messages ?? [],
          chatTabs: snap.chatTabs ?? [],
          pendingApprovals: snap.pendingApprovals ?? [],
          agentStatus: snap.agentStatus ?? 'idle',
          agentActivityText: snap.agentActivityText ?? null,
          agentActivityLive: !!snap.agentActivityLive,
          agentActivitySource: snap.agentActivitySource ?? 'none',
          composerQueue: snap.composerQueue ?? { items: [] },
          mode: snap.mode ?? { current: 'agent', available: [] },
          model: snap.model ?? { current: 'Auto', currentId: '' },
          questionnaire: snap.questionnaire ?? null,
          activeComposerId: snap.activeComposerId ?? '',
          lastUpdated: snap.lastUpdated ?? 0,
        });
      }
      console.log(`[snapshot-store] Loaded ${out.size} window snapshot(s) from disk`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[snapshot-store] Failed to load: ${msg}`);
    }
    return out;
  }

  scheduleSave(snapshots: Map<string, WindowSnapshot>): void {
    if (!this.persistPath) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.write(snapshots);
    }, SAVE_DEBOUNCE_MS);
  }

  flush(snapshots: Map<string, WindowSnapshot>): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) this.write(snapshots);
  }

  private write(snapshots: Map<string, WindowSnapshot>): void {
    if (!this.persistPath) return;
    this.dirty = false;
    const data: PersistedData = { snapshots: {} };
    for (const [id, snap] of snapshots) {
      data.snapshots[id] = {
        windowId: snap.windowId,
        windowTitle: snap.windowTitle,
        messages: snap.messages,
        chatTabs: snap.chatTabs,
        pendingApprovals: snap.pendingApprovals,
        agentStatus: snap.agentStatus,
        agentActivityText: snap.agentActivityText,
        agentActivityLive: snap.agentActivityLive,
        agentActivitySource: snap.agentActivitySource,
        composerQueue: snap.composerQueue,
        mode: snap.mode,
        model: snap.model,
        questionnaire: snap.questionnaire,
        activeComposerId: snap.activeComposerId,
        lastUpdated: snap.lastUpdated,
      };
    }
    try {
      writeFileSync(this.persistPath, JSON.stringify(data));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[snapshot-store] Failed to persist: ${msg}`);
    }
  }
}
