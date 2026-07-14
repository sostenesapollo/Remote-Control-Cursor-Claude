import type { AgentStatus } from '../../types.js';

/**
 * Telegram forum topic icon colors (createForumTopic only).
 * @see https://core.telegram.org/bots/api#createforumtopic
 */
export const TOPIC_ICON_COLOR = {
  blue: 7322096, // 0x6FB9F0
  yellow: 16766590, // 0xFFD67E
  purple: 13338331, // 0xCB86DB
  green: 9367192, // 0x8EEE98
  pink: 16749490, // 0xFF93B2
  red: 16478047, // 0xFB6F5F
} as const;

/**
 * Fixed custom-emoji IDs from getForumTopicIconStickers (set "Topics").
 * Safe to hardcode — Telegram publishes this catalog for all bots.
 */
export const TOPIC_ICON_EMOJI = {
  /** New / just created */
  star: '5235579393115438657', // ⭐️
  /** Thinking */
  brain: '5237889595894414384', // 🧠
  /** Generating / chatting */
  chat: '5417915203100613993', // 💬
  /** Running a tool */
  bolt: '5312016608254762256', // ⚡️
  /** Waiting for approval */
  alert: '5379748062124056162', // ❗️
  /** Finished / idle */
  check: '5237699328843200968', // ✅
  /** Error */
  doubleAlert: '5377498341074542641', // ‼️
  /** Cool / fresh */
  cool: '5420216386448270341', // 🆒
} as const;

export type TopicIconPhase =
  | 'new'
  | 'thinking'
  | 'generating'
  | 'running_tool'
  | 'waiting_approval'
  | 'idle'
  | 'error';

export interface TopicIconStyle {
  phase: TopicIconPhase;
  /** Used only when creating the topic. */
  iconColor: number;
  /** Used on create and on later editForumTopic updates. */
  iconCustomEmojiId: string;
}

/**
 * Resolve the visual phase for a live window snapshot.
 * Pending approvals win over raw agentStatus so the icon reflects the blocker.
 */
export function topicPhaseFromSnapshot(
  agentStatus: AgentStatus,
  pendingApprovalCount = 0
): TopicIconPhase {
  if (pendingApprovalCount > 0) return 'waiting_approval';
  switch (agentStatus) {
    case 'thinking':
      return 'thinking';
    case 'generating':
      return 'generating';
    case 'running_tool':
      return 'running_tool';
    case 'waiting_approval':
      return 'waiting_approval';
    case 'error':
      return 'error';
    case 'idle':
    default:
      return 'idle';
  }
}

export function topicIconForPhase(phase: TopicIconPhase): TopicIconStyle {
  switch (phase) {
    case 'new':
      return {
        phase,
        iconColor: TOPIC_ICON_COLOR.blue,
        iconCustomEmojiId: TOPIC_ICON_EMOJI.star,
      };
    case 'thinking':
      return {
        phase,
        iconColor: TOPIC_ICON_COLOR.purple,
        iconCustomEmojiId: TOPIC_ICON_EMOJI.brain,
      };
    case 'generating':
      return {
        phase,
        iconColor: TOPIC_ICON_COLOR.blue,
        iconCustomEmojiId: TOPIC_ICON_EMOJI.chat,
      };
    case 'running_tool':
      return {
        phase,
        iconColor: TOPIC_ICON_COLOR.yellow,
        iconCustomEmojiId: TOPIC_ICON_EMOJI.bolt,
      };
    case 'waiting_approval':
      return {
        phase,
        iconColor: TOPIC_ICON_COLOR.pink,
        iconCustomEmojiId: TOPIC_ICON_EMOJI.alert,
      };
    case 'error':
      return {
        phase,
        iconColor: TOPIC_ICON_COLOR.red,
        iconCustomEmojiId: TOPIC_ICON_EMOJI.doubleAlert,
      };
    case 'idle':
    default:
      return {
        phase: 'idle',
        iconColor: TOPIC_ICON_COLOR.green,
        iconCustomEmojiId: TOPIC_ICON_EMOJI.check,
      };
  }
}

export function topicIconForSnapshot(
  agentStatus: AgentStatus,
  pendingApprovalCount = 0
): TopicIconStyle {
  return topicIconForPhase(topicPhaseFromSnapshot(agentStatus, pendingApprovalCount));
}
