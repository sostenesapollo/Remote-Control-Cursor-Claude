import { basename, join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { ForumTopicOptions, TelegramApiClient, TgKeyboard } from './transports/telegram/tg-types.js';
import { tgKeyboard } from './transports/telegram/tg-types.js';
import type { TopicManager, TopicMapping } from './transports/telegram/topic-manager.js';
import type { SendQueue } from './transports/send-queue.js';
import { topicIconForPhase, type TopicIconPhase } from './transports/telegram/topic-icons.js';
import {
  lookupSessionFromDisk,
  resolveClaudeBinary,
  runClaudePrintPrompt,
} from './claude-prompt.js';

export interface ClaudeHookBody {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  message?: string;
  title?: string;
  notification_type?: string;
  permission_mode?: string;
  [key: string]: unknown;
}

export interface ClaudeTelegramSink {
  getChatId(): number | undefined;
  getApi(): TelegramApiClient | null;
  getSendQueue(): SendQueue | null;
  getTopicManager(): TopicManager | null;
  isReady(): boolean;
}

interface PendingPermission {
  id: string;
  event: 'PermissionRequest' | 'PreToolUse';
  resolve: (decision: Record<string, unknown>) => void;
  createdAt: number;
  threadId: number;
  messageId?: number;
}

const CLAUDE_WINDOW_PREFIX = 'claude::';
const DEFAULT_PERMISSION_TIMEOUT_MS = 280_000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortId(): string {
  return randomBytes(4).toString('hex');
}

function sessionLabel(body: ClaudeHookBody): string {
  const cwd = body.cwd?.trim();
  if (cwd) {
    const base = basename(cwd);
    if (base) return base;
  }
  const sid = body.session_id ?? 'session';
  return sid.length > 12 ? sid.slice(0, 12) : sid;
}

function windowIdForSession(sessionId: string): string {
  return `${CLAUDE_WINDOW_PREFIX}${createHash('sha1').update(sessionId).digest('hex').slice(0, 16)}`;
}

function summarizeToolInput(input: unknown): string {
  if (input == null) return '';
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input, null, 0);
    return s.length > 800 ? `${s.slice(0, 800)}…` : s;
  } catch {
    return String(input);
  }
}

/**
 * Bridges Claude Code HTTP hooks into the same Telegram forum group used by Cursor.
 * Topics are named `Claude — <project>` and use the colored-circle icon palette.
 */
export class ClaudeBridge {
  private sink: ClaudeTelegramSink | null = null;
  private pending = new Map<string, PendingPermission>();
  private topicIconPhase = new Map<number, TopicIconPhase>();
  private permissionTimeoutMs: number;
  /** sessionId → last known cwd / label from hooks */
  private sessions = new Map<string, { cwd: string; label: string; updatedAt: number }>();
  private promptInflight = new Set<string>();

  constructor(permissionTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS) {
    this.permissionTimeoutMs = permissionTimeoutMs;
  }

  setSink(sink: ClaudeTelegramSink | null): void {
    this.sink = sink;
  }

  isPermissionCallback(data: string): boolean {
    return data.startsWith('cla:') || data.startsWith('cld:');
  }

  /** Resolve a Telegram button press for Claude allow/deny. */
  handlePermissionCallback(data: string): boolean {
    const allow = data.startsWith('cla:');
    const id = data.slice(4);
    const pending = this.pending.get(id);
    if (!pending) return false;

    this.pending.delete(id);
    const decision = this.buildDecision(pending.event, allow);
    pending.resolve(decision);

    const api = this.sink?.getApi();
    const chatId = this.sink?.getChatId();
    if (api && chatId != null && pending.messageId != null) {
      const label = allow ? '✅ Allowed from Telegram' : '❌ Denied from Telegram';
      api.editMessageText(chatId, pending.messageId, label).catch(() => {});
    }
    void this.setTopicIcon(pending.threadId, allow ? 'running_tool' : 'error');
    return true;
  }

  async handleHook(eventName: string, body: ClaudeHookBody): Promise<Record<string, unknown>> {
    const event = (body.hook_event_name || eventName || '').trim();
    this.rememberSession(body);
    console.log(`[claude-bridge] hook ${event} session=${(body.session_id ?? '').slice(0, 8)} cwd=${body.cwd ?? ''}`);

    if (!this.sink?.isReady()) {
      // Don't block Claude if Telegram isn't synced yet.
      return {};
    }

    switch (event) {
      case 'PermissionRequest':
        return this.handlePermissionRequest(body);
      case 'PreToolUse':
        // With bypassPermissions most calls never reach PermissionRequest;
        // PreToolUse is still useful to mirror activity. Only hold when
        // permission_mode is ask/default (not bypass).
        if (this.shouldHoldPreToolUse(body)) {
          return this.handlePreToolUseHold(body);
        }
        await this.notifyToolActivity(body, 'running_tool');
        return {};
      case 'PostToolUse':
        await this.notifyToolActivity(body, 'idle');
        return {};
      case 'PostToolUseFailure':
        await this.notifyFailure(body);
        return {};
      case 'Notification':
        await this.notifyUser(body);
        return {};
      case 'Stop':
      case 'SubagentStop':
        await this.notifyStop(body);
        return {};
      case 'SessionStart':
        await this.ensureClaudeTopic(body, 'new');
        return {};
      case 'SessionEnd':
        await this.notifySessionEnd(body);
        return {};
      default:
        return {};
    }
  }

  private shouldHoldPreToolUse(body: ClaudeHookBody): boolean {
    const mode = String(body.permission_mode ?? '').toLowerCase();
    return mode === 'default' || mode === 'ask' || mode === 'acceptedits' || mode === 'plan';
  }

  private buildDecision(
    event: 'PermissionRequest' | 'PreToolUse',
    allow: boolean
  ): Record<string, unknown> {
    if (event === 'PermissionRequest') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: allow ? 'allow' : 'deny',
            ...(allow ? {} : { message: 'Denied from CursorRemote Telegram' }),
          },
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: allow ? 'allow' : 'deny',
        permissionDecisionReason: allow
          ? 'Allowed from CursorRemote Telegram'
          : 'Denied from CursorRemote Telegram',
      },
    };
  }

  private async handlePermissionRequest(body: ClaudeHookBody): Promise<Record<string, unknown>> {
    return this.holdForTelegramDecision(body, 'PermissionRequest');
  }

  private async handlePreToolUseHold(body: ClaudeHookBody): Promise<Record<string, unknown>> {
    return this.holdForTelegramDecision(body, 'PreToolUse');
  }

  private async holdForTelegramDecision(
    body: ClaudeHookBody,
    event: 'PermissionRequest' | 'PreToolUse'
  ): Promise<Record<string, unknown>> {
    const threadId = await this.ensureClaudeTopic(body, 'waiting_approval');
    if (threadId == null) return {};

    const id = shortId();
    const tool = escapeHtml(body.tool_name ?? 'tool');
    const input = escapeHtml(summarizeToolInput(body.tool_input));
    const html =
      `<b>🔐 Claude needs approval</b>\n` +
      `<code>${tool}</code>\n` +
      (input ? `<pre>${input}</pre>\n` : '') +
      `<i>${escapeHtml(sessionLabel(body))}</i>`;

    const keyboard: TgKeyboard = tgKeyboard()
      .text('✅ Allow', `cla:${id}`)
      .text('❌ Deny', `cld:${id}`)
      .build();

    const messageId = await this.sendHtml(threadId, html, keyboard);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        console.warn(`[claude-bridge] Permission ${id} timed out — no Telegram decision`);
        // Stay silent: Claude falls through to its normal local permission UI.
        resolve({});
      }, this.permissionTimeoutMs);

      this.pending.set(id, {
        id,
        event,
        threadId,
        messageId,
        createdAt: Date.now(),
        resolve: (decision) => {
          clearTimeout(timer);
          resolve(decision);
        },
      });
    });
  }

  private async notifyToolActivity(body: ClaudeHookBody, phase: TopicIconPhase): Promise<void> {
    const threadId = await this.ensureClaudeTopic(body, phase);
    if (threadId == null) return;
    const tool = escapeHtml(body.tool_name ?? 'tool');
    const verb = phase === 'running_tool' ? 'Using' : 'Used';
    await this.sendHtml(threadId, `⚙️ <b>${verb}</b> <code>${tool}</code>`);
  }

  private async notifyFailure(body: ClaudeHookBody): Promise<void> {
    const threadId = await this.ensureClaudeTopic(body, 'error');
    if (threadId == null) return;
    const tool = escapeHtml(body.tool_name ?? 'tool');
    await this.sendHtml(threadId, `‼️ <b>Tool failed</b> <code>${tool}</code>`);
  }

  private async notifyUser(body: ClaudeHookBody): Promise<void> {
    const type = body.notification_type ?? '';
    const phase: TopicIconPhase =
      type === 'permission_prompt' || type === 'agent_needs_input' || type === 'idle_prompt'
        ? 'waiting_approval'
        : type === 'agent_completed'
          ? 'idle'
          : 'generating';
    const threadId = await this.ensureClaudeTopic(body, phase);
    if (threadId == null) return;
    const title = body.title ? `<b>${escapeHtml(body.title)}</b>\n` : '';
    const msg = escapeHtml(body.message ?? type ?? 'notification');
    await this.sendHtml(threadId, `🔔 ${title}${msg}`);
  }

  private async notifyStop(body: ClaudeHookBody): Promise<void> {
    const threadId = await this.ensureClaudeTopic(body, 'idle');
    if (threadId == null) return;
    await this.sendHtml(threadId, `✅ <b>Claude finished a turn</b> · ${escapeHtml(sessionLabel(body))}`);
  }

  private async notifySessionEnd(body: ClaudeHookBody): Promise<void> {
    const threadId = await this.ensureClaudeTopic(body, 'idle');
    if (threadId == null) return;
    await this.sendHtml(threadId, `⏹ <b>Claude session ended</b> · ${escapeHtml(sessionLabel(body))}`);
  }

  private async ensureClaudeTopic(
    body: ClaudeHookBody,
    phase: TopicIconPhase
  ): Promise<number | undefined> {
    const sink = this.sink;
    if (!sink?.isReady()) return undefined;
    const api = sink.getApi();
    const chatId = sink.getChatId();
    const topicManager = sink.getTopicManager();
    const queue = sink.getSendQueue();
    if (!api || chatId == null || !topicManager || !queue) return undefined;

    const sessionId = body.session_id || 'unknown';
    const winId = windowIdForSession(sessionId);
    const label = sessionLabel(body);
    const tabTitle = 'Claude';
    const windowTitle = `Claude — ${label}`;

    let threadId = topicManager.getThreadForSnapshot(winId, windowTitle, tabTitle);
    if (!threadId) {
      const icon = topicIconForPhase(phase === 'idle' ? 'new' : phase);
      try {
        const result = await queue.enqueue(
          () => api.createForumTopic(chatId, windowTitle.substring(0, 128), {
            iconColor: icon.iconColor,
          } satisfies ForumTopicOptions),
          'send'
        );
        threadId = result.message_thread_id;
        topicManager.registerMapping({
          threadId,
          windowId: winId,
          windowTitle,
          tabTitle,
          lastActive: Date.now(),
          composerId: sessionId,
        });
        this.topicIconPhase.set(threadId, phase === 'idle' ? 'new' : phase);
        console.log(`[claude-bridge] Created topic ${threadId} for ${windowTitle}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[claude-bridge] Failed to create topic: ${msg}`);
        return undefined;
      }
    }

    await this.setTopicIcon(threadId, phase);
    return threadId;
  }

  private async setTopicIcon(threadId: number, phase: TopicIconPhase): Promise<void> {
    if (this.topicIconPhase.get(threadId) === phase) return;
    const sink = this.sink;
    const api = sink?.getApi();
    const chatId = sink?.getChatId();
    const queue = sink?.getSendQueue();
    if (!api || chatId == null || !queue) return;

    const style = topicIconForPhase(phase);
    try {
      await queue.enqueue(
        () => api.editForumTopic(chatId, threadId, {
          iconCustomEmojiId: '',
          iconColor: style.iconColor,
        }),
        'edit'
      );
      this.topicIconPhase.set(threadId, phase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('TOPIC_NOT_MODIFIED')) {
        console.warn(`[claude-bridge] Icon update failed (${threadId}): ${msg}`);
      } else {
        this.topicIconPhase.set(threadId, phase);
      }
    }
  }

  private async sendHtml(
    threadId: number,
    html: string,
    keyboard?: TgKeyboard
  ): Promise<number | undefined> {
    const sink = this.sink;
    const api = sink?.getApi();
    const chatId = sink?.getChatId();
    const queue = sink?.getSendQueue();
    if (!api || chatId == null || !queue) return undefined;

    try {
      const sent = await queue.enqueue(
        () => api.sendMessage(chatId, html, {
          message_thread_id: threadId,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }),
        'send'
      );
      return sent.message_id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[claude-bridge] Send failed: ${msg}`);
      return undefined;
    }
  }

  private rememberSession(body: ClaudeHookBody): void {
    if (!body.session_id || !body.cwd) return;
    this.sessions.set(body.session_id, {
      cwd: body.cwd,
      label: sessionLabel(body),
      updatedAt: Date.now(),
    });
  }

  private resolveSessionMeta(mapping: TopicMapping): { sessionId: string; cwd: string } | null {
    const sessionId = mapping.composerId?.trim();
    if (!sessionId) return null;

    const cached = this.sessions.get(sessionId);
    if (cached?.cwd) return { sessionId, cwd: cached.cwd };

    const disk = lookupSessionFromDisk(sessionId);
    if (disk?.cwd) {
      this.sessions.set(sessionId, {
        cwd: disk.cwd,
        label: disk.name ?? sessionLabel({ cwd: disk.cwd, session_id: sessionId }),
        updatedAt: Date.now(),
      });
      return { sessionId, cwd: disk.cwd };
    }

    // Guess ~/dev/<folder> from topic title "Claude — <folder>"
    const m = /^Claude — (.+)$/.exec(mapping.windowTitle);
    if (m) {
      const folder = m[1];
      for (const base of [join(homedir(), 'dev', folder), join(homedir(), 'Dev', folder)]) {
        if (existsSync(base)) return { sessionId, cwd: base };
      }
    }
    return null;
  }

  /**
   * Handle a Telegram text message in a Claude topic: run
   * `claude -p --resume <session>` and post the reply into the same topic.
   */
  async handleTelegramPrompt(mapping: TopicMapping, text: string): Promise<void> {
    const threadId = mapping.threadId;
    const meta = this.resolveSessionMeta(mapping);
    if (!meta) {
      await this.sendHtml(
        threadId,
        '⚠️ Não achei a sessão Claude deste tópico.\n' +
        'Abre o projeto no Claude Code/Desktop uma vez (para o hook gravar o session id) e tenta de novo.'
      );
      return;
    }

    if (this.promptInflight.has(meta.sessionId)) {
      await this.sendHtml(threadId, '⏳ Já há um prompt a correr nesta sessão. Espera a resposta.');
      return;
    }

    const binary = resolveClaudeBinary();
    if (!binary) {
      await this.sendHtml(
        threadId,
        '⚠️ Binário do Claude não encontrado.\n' +
        'Instala Claude Desktop / Claude Code, ou define <code>CLAUDE_BIN</code>.'
      );
      return;
    }

    this.promptInflight.add(meta.sessionId);
    await this.setTopicIcon(threadId, 'generating');
    const statusId = await this.sendHtml(
      threadId,
      `⏳ <b>Claude</b> a processar…\n<code>${escapeHtml(text.slice(0, 200))}</code>`
    );

    console.log(`[claude-bridge] Prompt → session=${meta.sessionId.slice(0, 8)} cwd=${meta.cwd}`);
    try {
      const result = await runClaudePrintPrompt({
        sessionId: meta.sessionId,
        cwd: meta.cwd,
        prompt: text,
        binary,
      });

      const reply = result.ok
        ? escapeHtml(result.text).slice(0, 3800)
        : `⚠️ Claude falhou: ${escapeHtml(result.error ?? 'unknown')}` +
          (result.text ? `\n\n<pre>${escapeHtml(result.text).slice(0, 2000)}</pre>` : '');

      const api = this.sink?.getApi();
      const chatId = this.sink?.getChatId();
      const queue = this.sink?.getSendQueue();
      if (api && chatId != null && queue && statusId != null && result.ok) {
        try {
          await queue.enqueue(
            () => api.editMessageText(chatId, statusId, reply, { parse_mode: 'HTML' }),
            'edit'
          );
        } catch {
          await this.sendHtml(threadId, reply);
        }
      } else {
        await this.sendHtml(threadId, reply);
      }
      await this.setTopicIcon(threadId, result.ok ? 'idle' : 'error');
    } finally {
      this.promptInflight.delete(meta.sessionId);
    }
  }
}

export function isClaudeWindowId(windowId: string): boolean {
  return windowId.startsWith(CLAUDE_WINDOW_PREFIX);
}
