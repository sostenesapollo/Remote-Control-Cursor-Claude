import { basename, join } from 'path';
import { createHash, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { ForumTopicOptions, TelegramApiClient, TgKeyboard } from './transports/telegram/tg-types.js';
import { tgKeyboard } from './transports/telegram/tg-types.js';
import type { TopicManager, TopicMapping } from './transports/telegram/topic-manager.js';
import type { SendQueue } from './transports/send-queue.js';
import { topicIconForPhase, type TopicIconPhase } from './transports/telegram/topic-icons.js';
import { formatClaudeForumTopicName } from './transports/telegram/topic-names.js';
import {
  lookupSessionFromDisk,
  resolveClaudeBinary,
  runClaudePrintPrompt,
} from './claude-prompt.js';
import {
  extractLastRoleText,
  resolveClaudeTranscriptPath,
} from './claude-transcript.js';
import {
  formatAskUserQuestionHtml,
  optionLetter,
  parseAskUserQuestionInput,
  type AskUserQuestionInput,
} from './claude-ask.js';

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
  /** When set, Telegram option buttons answer AskUserQuestion via updatedInput. */
  ask?: AskUserQuestionInput;
  /** Accumulated answers keyed by question text (multi-question). */
  answers?: Record<string, string>;
  activeQuestionIndex?: number;
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

function windowIdForProject(body: ClaudeHookBody): string {
  // Stable per project folder so session restarts reuse the same Telegram topic.
  const key = (body.cwd?.trim() || body.session_id || 'unknown').toLowerCase();
  return `${CLAUDE_WINDOW_PREFIX}${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}

function isDeadTopicError(msg: string): boolean {
  return /TOPIC_ID_INVALID|message thread not found|TOPIC_NOT_FOUND/i.test(msg);
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
 * Topics are named `🤖 Claude — <project>` and use the colored-circle icon palette.
 */
export class ClaudeBridge {
  private sink: ClaudeTelegramSink | null = null;
  private pending = new Map<string, PendingPermission>();
  private topicIconPhase = new Map<number, TopicIconPhase>();
  /** Threads that already have 🤖 in the Telegram topic name. */
  private topicNameEnsured = new Set<number>();
  private permissionTimeoutMs: number;
  /** sessionId → last known cwd / label from hooks */
  private sessions = new Map<string, { cwd: string; label: string; updatedAt: number }>();
  private promptInflight = new Set<string>();
  /** Last assistant text posted per session — avoid duplicate Stop spam. */
  private lastPostedAssistant = new Map<string, string>();
  /** Skip UserPromptSubmit echo right after a Telegram→Claude prompt. */
  private lastTelegramPromptAt = 0;
  private lastTelegramPromptText = '';
  /** AskUserQuestion tool_use_id already shown in Telegram — skip duplicate hooks. */
  private askShownToolUses = new Set<string>();

  constructor(permissionTimeoutMs = DEFAULT_PERMISSION_TIMEOUT_MS) {
    this.permissionTimeoutMs = permissionTimeoutMs;
  }

  setSink(sink: ClaudeTelegramSink | null): void {
    this.sink = sink;
  }

  isPermissionCallback(data: string): boolean {
    return data.startsWith('cla:') || data.startsWith('cld:') || data.startsWith('clq:');
  }

  /** Resolve a Telegram button press for Claude allow/deny/question answers. */
  handlePermissionCallback(data: string): boolean {
    if (data.startsWith('clq:')) {
      return this.handleAskOptionCallback(data);
    }

    const allow = data.startsWith('cla:');
    const id = data.slice(4);
    const pending = this.pending.get(id);
    if (!pending) return false;

    // AskUserQuestion without picking an option: Allow alone is useless — ignore.
    if (pending.ask && allow) return true;

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

  private handleAskOptionCallback(data: string): boolean {
    // clq:{id}:{questionIndex}:{optionIndex}
    const parts = data.split(':');
    if (parts.length < 4) return false;
    const id = parts[1];
    const qi = parseInt(parts[2], 10);
    const oi = parseInt(parts[3], 10);
    const pending = this.pending.get(id);
    if (!pending?.ask || Number.isNaN(qi) || Number.isNaN(oi)) return false;

    const q = pending.ask.questions[qi];
    const opt = q?.options[oi];
    if (!q || !opt) return false;

    const answers = { ...(pending.answers ?? {}) };
    answers[q.question] = opt.label;
    pending.answers = answers;

    const nextUnanswered = pending.ask.questions.findIndex((qq) => !(qq.question in answers));
    if (nextUnanswered >= 0) {
      pending.activeQuestionIndex = nextUnanswered;
      const api = this.sink?.getApi();
      const chatId = this.sink?.getChatId();
      if (api && chatId != null && pending.messageId != null) {
        const html = formatAskUserQuestionHtml(pending.ask, '') +
          `\n\n✅ <b>${escapeHtml(optionLetter(oi))})</b> ${escapeHtml(opt.label)}` +
          `\n\n👉 Próxima pergunta…`;
        const keyboard = this.buildAskKeyboard(pending.id, pending.ask, nextUnanswered);
        api.editMessageText(chatId, pending.messageId, html, {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }).catch(() => {});
      }
      return true;
    }

    // All answered — resolve with updatedInput
    this.pending.delete(id);
    pending.resolve(this.buildAskAnswerDecision(pending.event, pending.ask, answers));

    const api = this.sink?.getApi();
    const chatId = this.sink?.getChatId();
    if (api && chatId != null && pending.messageId != null) {
      const summary = Object.entries(answers)
        .map(([qq, a]) => `• ${escapeHtml(qq)}\n  → <b>${escapeHtml(a)}</b>`)
        .join('\n');
      api.editMessageText(
        chatId,
        pending.messageId,
        `✅ <b>Respondido no Telegram</b>\n${summary}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    void this.setTopicIcon(pending.threadId, 'running_tool');
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
        // Always hold AskUserQuestion so Telegram can answer with buttons.
        // Other tools: only hold when permission_mode is ask/default.
        if (body.tool_name === 'AskUserQuestion' || this.shouldHoldPreToolUse(body)) {
          return this.handlePreToolUseHold(body);
        }
        await this.ensureClaudeTopic(body, 'running_tool');
        return {};
      case 'PostToolUse':
        if (body.tool_name === 'AskUserQuestion') {
          await this.ensureClaudeTopic(body, 'idle');
          return {};
        }
        await this.ensureClaudeTopic(body, 'idle');
        return {};
      case 'PostToolUseFailure':
        await this.notifyFailure(body);
        return {};
      case 'Notification':
        await this.notifyUser(body);
        return {};
      case 'UserPromptSubmit':
        await this.notifyUserPrompt(body);
        return {};
      case 'Stop':
        await this.notifyStop(body);
        return {};
      case 'SubagentStop':
        // Avoid double-posting with Stop — icon tick only.
        await this.ensureClaudeTopic(body, 'idle');
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

  private buildAskAnswerDecision(
    event: 'PermissionRequest' | 'PreToolUse',
    ask: AskUserQuestionInput,
    answers: Record<string, string>
  ): Record<string, unknown> {
    const updatedInput = {
      questions: ask.questions.map((q) => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect ?? false,
        options: q.options.map((o) => ({
          label: o.label,
          description: o.description,
        })),
      })),
      answers,
    };

    if (event === 'PermissionRequest') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedInput,
          },
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Answered from CursorRemote Telegram',
        updatedInput,
      },
    };
  }

  private buildAskKeyboard(
    pendingId: string,
    ask: AskUserQuestionInput,
    questionIndex: number
  ): TgKeyboard {
    const q = ask.questions[questionIndex] ?? ask.questions[0];
    const kb = tgKeyboard();
    q.options.forEach((opt, oi) => {
      const letter = optionLetter(oi);
      const label = `${letter}) ${opt.label}`.slice(0, 64);
      kb.text(label, `clq:${pendingId}:${questionIndex}:${oi}`);
      kb.row();
    });
    kb.text('❌ Cancelar', `cld:${pendingId}`);
    return kb.build();
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
    const ask =
      body.tool_name === 'AskUserQuestion'
        ? parseAskUserQuestionInput(body.tool_input)
        : null;
    const toolUseId = typeof body.tool_use_id === 'string' ? body.tool_use_id : '';

    // PreToolUse + PermissionRequest can both fire for the same AskUserQuestion.
    // Only one Telegram prompt; the second hook auto-allows.
    if (ask && toolUseId && this.askShownToolUses.has(toolUseId)) {
      return this.buildDecision(event, true);
    }

    const id = shortId();
    if (ask && toolUseId) this.askShownToolUses.add(toolUseId);

    let html: string;
    let keyboard: TgKeyboard;

    if (ask) {
      html = formatAskUserQuestionHtml(ask, sessionLabel(body));
      keyboard = this.buildAskKeyboard(id, ask, 0);
    } else {
      const tool = escapeHtml(body.tool_name ?? 'tool');
      const input = escapeHtml(summarizeToolInput(body.tool_input));
      html =
        `<b>🔐 Claude needs approval</b>\n` +
        `<code>${tool}</code>\n` +
        (input ? `<pre>${input}</pre>\n` : '') +
        `<i>${escapeHtml(sessionLabel(body))}</i>`;
      keyboard = tgKeyboard()
        .text('✅ Allow', `cla:${id}`)
        .text('❌ Deny', `cld:${id}`)
        .build();
    }

    const messageId = await this.deliverHtml(body, 'waiting_approval', html, keyboard);
    const threadId =
      this.sink?.getTopicManager()?.getAllMappings().find(
        (m) => m.windowId === windowIdForProject(body)
      )?.threadId ?? 0;

    return new Promise((resolve) => {
      const clearAsk = () => {
        if (toolUseId) this.askShownToolUses.delete(toolUseId);
      };
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearAsk();
        console.warn(`[claude-bridge] Permission ${id} timed out — no Telegram decision`);
        resolve({});
      }, this.permissionTimeoutMs);

      this.pending.set(id, {
        id,
        event,
        threadId,
        messageId,
        createdAt: Date.now(),
        ask: ask ?? undefined,
        answers: {},
        activeQuestionIndex: 0,
        resolve: (decision) => {
          clearTimeout(timer);
          clearAsk();
          resolve(decision);
        },
      });
    });
  }

  private async notifyToolActivity(body: ClaudeHookBody, phase: TopicIconPhase): Promise<void> {
    await this.ensureClaudeTopic(body, phase);
  }

  private async notifyFailure(body: ClaudeHookBody): Promise<void> {
    const tool = escapeHtml(body.tool_name ?? 'tool');
    await this.deliverHtml(
      body,
      'error',
      `‼️ <b>Tool failed</b> <code>${tool}</code>`
    );
  }

  private async notifyUser(body: ClaudeHookBody): Promise<void> {
    const type = body.notification_type ?? '';
    const phase: TopicIconPhase =
      type === 'permission_prompt' || type === 'agent_needs_input' || type === 'idle_prompt'
        ? 'waiting_approval'
        : type === 'agent_completed'
          ? 'idle'
          : 'generating';
    const title = body.title ? `<b>${escapeHtml(body.title)}</b>\n` : '';
    const msg = escapeHtml(body.message ?? type ?? 'notification');
    await this.deliverHtml(body, phase, `🔔 ${title}${msg}`);
  }

  private async notifyUserPrompt(body: ClaudeHookBody): Promise<void> {
    const path = resolveClaudeTranscriptPath(body);
    const fromDisk = path ? extractLastRoleText(path, 'user') : null;
    const prompt =
      fromDisk ||
      (typeof body.prompt === 'string' ? body.prompt : null) ||
      (typeof body.message === 'string' ? body.message : null);
    if (!prompt?.trim()) {
      await this.ensureClaudeTopic(body, 'generating');
      return;
    }

    // Don't echo prompts we just injected from Telegram.
    const trimmed = prompt.trim();
    if (
      this.promptInflight.has(body.session_id ?? '') ||
      (Date.now() - this.lastTelegramPromptAt < 120_000 &&
        trimmed === this.lastTelegramPromptText)
    ) {
      await this.ensureClaudeTopic(body, 'generating');
      return;
    }

    await this.deliverHtml(
      body,
      'generating',
      `<b>You:</b> ${escapeHtml(trimmed).slice(0, 3500)}`
    );
  }

  private async notifyStop(body: ClaudeHookBody): Promise<void> {
    const path = resolveClaudeTranscriptPath(body);
    const answer = path ? extractLastRoleText(path, 'assistant') : null;
    const sid = body.session_id ?? '';
    if (answer?.trim()) {
      const text = answer.trim();
      if (this.lastPostedAssistant.get(sid) === text) {
        await this.ensureClaudeTopic(body, 'idle');
        return;
      }
      this.lastPostedAssistant.set(sid, text);
      await this.deliverHtml(
        body,
        'idle',
        escapeHtml(text).slice(0, 3800)
      );
      return;
    }
    await this.deliverHtml(
      body,
      'idle',
      `✅ <b>Claude finished a turn</b> · ${escapeHtml(sessionLabel(body))}`
    );
  }

  private async notifySessionEnd(body: ClaudeHookBody): Promise<void> {
    await this.deliverHtml(
      body,
      'idle',
      `⏹ <b>Claude session ended</b> · ${escapeHtml(sessionLabel(body))}`
    );
  }

  /** Send HTML into the Claude topic; recreate the topic once if Telegram says it's gone. */
  private async deliverHtml(
    body: ClaudeHookBody,
    phase: TopicIconPhase,
    html: string,
    keyboard?: TgKeyboard
  ): Promise<number | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const threadId = await this.ensureClaudeTopic(body, phase, { forceNew: attempt > 0 });
      if (threadId == null) return undefined;
      const result = await this.sendHtml(threadId, html, keyboard);
      if (result.messageId != null) return result.messageId;
      if (!result.deadTopic) return undefined;
      console.warn(`[claude-bridge] Topic ${threadId} dead — recreating`);
    }
    return undefined;
  }

  private dropStaleClaudeMappings(winId: string, windowTitle: string): void {
    const topicManager = this.sink?.getTopicManager();
    if (!topicManager) return;
    for (const m of topicManager.getAllMappings()) {
      const sameProject =
        m.windowId === winId ||
        m.windowTitle === windowTitle ||
        (m.windowTitle.startsWith('Claude — ') && m.windowTitle === windowTitle);
      if (!sameProject) continue;
      if (!m.windowId.startsWith(CLAUDE_WINDOW_PREFIX) && !m.windowTitle.startsWith('Claude — ')) {
        continue;
      }
      topicManager.removeMapping(m.threadId);
      this.topicIconPhase.delete(m.threadId);
      console.log(`[claude-bridge] Dropped stale mapping thread=${m.threadId} title=${m.windowTitle}`);
    }
  }

  private async ensureClaudeTopic(
    body: ClaudeHookBody,
    phase: TopicIconPhase,
    opts?: { forceNew?: boolean }
  ): Promise<number | undefined> {
    const sink = this.sink;
    if (!sink?.isReady()) return undefined;
    const api = sink.getApi();
    const chatId = sink.getChatId();
    const topicManager = sink.getTopicManager();
    const queue = sink.getSendQueue();
    if (!api || chatId == null || !topicManager || !queue) return undefined;

    const sessionId = body.session_id || 'unknown';
    const winId = windowIdForProject(body);
    const label = sessionLabel(body);
    const tabTitle = 'Claude';
    const windowTitle = `Claude — ${label}`;

    if (opts?.forceNew) {
      this.dropStaleClaudeMappings(winId, windowTitle);
    }

    let threadId = topicManager.getThreadForSnapshot(winId, windowTitle, tabTitle);
    if (!threadId) {
      // Reclaim orphan title mappings (old session-hash windowIds) for this project.
      for (const m of topicManager.getAllMappings()) {
        if (m.windowTitle === windowTitle && m.tabTitle === tabTitle) {
          threadId = m.threadId;
          topicManager.updateMappingTarget(m.threadId, winId, windowTitle, tabTitle);
          const cur = topicManager.resolveThread(m.threadId);
          if (cur && sessionId !== 'unknown') {
            cur.composerId = sessionId;
            cur.lastActive = Date.now();
            topicManager.persistInPlace();
          }
          break;
        }
      }
    }

    if (!threadId) {
      const icon = topicIconForPhase(phase === 'idle' ? 'new' : phase);
      try {
        const result = await queue.enqueue(
          () => api.createForumTopic(chatId, formatClaudeForumTopicName(label), {
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
        this.topicNameEnsured.add(threadId);
        console.log(`[claude-bridge] Created topic ${threadId} for ${windowTitle}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[claude-bridge] Failed to create topic: ${msg}`);
        return undefined;
      }
    } else if (sessionId && sessionId !== 'unknown') {
      const existing = topicManager.resolveThread(threadId);
      if (existing && existing.composerId !== sessionId) {
        topicManager.registerMapping({
          ...existing,
          windowId: winId,
          lastActive: Date.now(),
          composerId: sessionId,
        });
      }
    }

    const iconOk = await this.setTopicIcon(threadId, phase);
    if (!iconOk) {
      // Dead topic discovered via icon edit — recreate once.
      if (!opts?.forceNew) {
        return this.ensureClaudeTopic(body, phase, { forceNew: true });
      }
      return undefined;
    }
    return threadId;
  }

  /** @returns false when the Telegram topic no longer exists */
  private async setTopicIcon(threadId: number, phase: TopicIconPhase): Promise<boolean> {
    const sink = this.sink;
    const api = sink?.getApi();
    const chatId = sink?.getChatId();
    const queue = sink?.getSendQueue();
    const topicManager = sink?.getTopicManager();
    if (!api || chatId == null || !queue) return true;

    const needName = !this.topicNameEnsured.has(threadId);
    if (this.topicIconPhase.get(threadId) === phase && !needName) return true;

    const style = topicIconForPhase(phase);
    const mapping = topicManager?.resolveThread(threadId);
    const opts: { iconCustomEmojiId: string; iconColor: number; name?: string } = {
      iconCustomEmojiId: '',
      iconColor: style.iconColor,
    };
    if (needName && mapping) {
      const label = mapping.windowTitle.replace(/^Claude — /, '') || 'project';
      opts.name = formatClaudeForumTopicName(label);
    } else if (needName) {
      opts.name = formatClaudeForumTopicName('project');
    }

    try {
      await queue.enqueue(
        () => api.editForumTopic(chatId, threadId, opts),
        'edit'
      );
      this.topicIconPhase.set(threadId, phase);
      if (needName) this.topicNameEnsured.add(threadId);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isDeadTopicError(msg)) {
        topicManager?.removeMapping(threadId);
        this.topicIconPhase.delete(threadId);
        this.topicNameEnsured.delete(threadId);
        console.warn(`[claude-bridge] Icon update hit dead topic ${threadId} — mapping dropped`);
        return false;
      }
      if (!msg.includes('TOPIC_NOT_MODIFIED')) {
        console.warn(`[claude-bridge] Icon update failed (${threadId}): ${msg}`);
      } else {
        this.topicIconPhase.set(threadId, phase);
        if (needName) this.topicNameEnsured.add(threadId);
      }
      return true;
    }
  }

  private async sendHtml(
    threadId: number,
    html: string,
    keyboard?: TgKeyboard
  ): Promise<{ messageId?: number; deadTopic?: boolean }> {
    const sink = this.sink;
    const api = sink?.getApi();
    const chatId = sink?.getChatId();
    const queue = sink?.getSendQueue();
    const topicManager = sink?.getTopicManager();
    if (!api || chatId == null || !queue) return {};

    try {
      const sent = await queue.enqueue(
        () => api.sendMessage(chatId, html, {
          message_thread_id: threadId,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        }),
        'send'
      );
      return { messageId: sent.message_id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[claude-bridge] Send failed: ${msg}`);
      if (isDeadTopicError(msg)) {
        topicManager?.removeMapping(threadId);
        this.topicIconPhase.delete(threadId);
        return { deadTopic: true };
      }
      return {};
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
   * `claude -p -c` in the project cwd and post the reply into the same topic.
   */
  async handleTelegramPrompt(mapping: TopicMapping, text: string): Promise<void> {
    const meta = this.resolveSessionMeta(mapping);
    const body: ClaudeHookBody = {
      session_id: meta?.sessionId ?? mapping.composerId,
      cwd: meta?.cwd,
    };

    if (!meta) {
      await this.sendHtml(
        mapping.threadId,
        '⚠️ Não achei a sessão Claude deste tópico.\n' +
        'Abre o projeto no Claude Code/Desktop uma vez (para o hook gravar o session id) e tenta de novo.'
      );
      return;
    }

    if (this.promptInflight.has(meta.sessionId)) {
      await this.deliverHtml(body, 'generating', '⏳ Já há um prompt a correr nesta sessão. Espera a resposta.');
      return;
    }

    const binary = resolveClaudeBinary();
    if (!binary) {
      await this.deliverHtml(
        body,
        'error',
        '⚠️ Binário do Claude não encontrado.\n' +
        'Instala Claude Desktop / Claude Code, ou define <code>CLAUDE_BIN</code>.'
      );
      return;
    }

    this.promptInflight.add(meta.sessionId);
    this.lastTelegramPromptAt = Date.now();
    this.lastTelegramPromptText = text.trim();
    const statusId = await this.deliverHtml(
      body,
      'generating',
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
      console.log(`[claude-bridge] Prompt done ok=${result.ok} len=${result.text.length} err=${result.error ?? ''}`);

      // Keep the useful answer; strip classifier sermons that sometimes get
      // appended when the local transcript is messy.
      let answer = result.text;
      const cut = answer.search(/\n\nAnd flagging|\n\nI'm not going to|\n\nThis message contains/i);
      if (cut > 0) answer = answer.slice(0, cut).trim();

      const reply = result.ok && answer
        ? escapeHtml(answer).slice(0, 3800)
        : `⚠️ Claude falhou: ${escapeHtml(result.error ?? 'sem resposta')}` +
          (answer ? `\n\n<pre>${escapeHtml(answer).slice(0, 1500)}</pre>` : '');

      await this.deliverHtml(body, result.ok ? 'idle' : 'error', reply);
      if (statusId != null) {
        const api = this.sink?.getApi();
        const chatId = this.sink?.getChatId();
        const queue = this.sink?.getSendQueue();
        if (api && chatId != null && queue) {
          try {
            await queue.enqueue(
              () => api.editMessageText(
                chatId,
                statusId,
                result.ok ? '✅ Respondido abaixo' : '⚠️ Falhou — ver mensagem abaixo',
                { parse_mode: 'HTML' }
              ),
              'edit'
            );
          } catch { /* ok */ }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[claude-bridge] Prompt exception: ${msg}`);
      await this.deliverHtml(body, 'error', `⚠️ Erro ao chamar Claude: ${escapeHtml(msg)}`);
    } finally {
      this.promptInflight.delete(meta.sessionId);
    }
  }
}

export function isClaudeWindowId(windowId: string): boolean {
  return windowId.startsWith(CLAUDE_WINDOW_PREFIX);
}
