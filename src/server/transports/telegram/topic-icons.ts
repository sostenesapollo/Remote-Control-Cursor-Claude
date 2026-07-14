import type { AgentStatus } from '../../types.js';

/**
 * Telegram forum topic icon colors — shown as solid colored circles when no
 * custom emoji is set. Valid both on createForumTopic and editForumTopic
 * (edit accepts icon_color in practice even though older docs omit it).
 * @see https://core.telegram.org/bots/api#createforumtopic
 */
export const TOPIC_ICON_COLOR = {
  blue: 7322096, // 0x6FB9F0 — 🔵
  yellow: 16766590, // 0xFFD67E — 🟡
  purple: 13338331, // 0xCB86DB — 🟣
  green: 9367192, // 0x8EEE98 — 🟢
  pink: 16749490, // 0xFF93B2 — 🩷
  red: 16478047, // 0xFB6F5F — 🔴
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
  /** Colored circle (Telegram forum topic color). */
  iconColor: number;
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

/**
 * Colored-circle palette (no custom emoji — Telegram's built-in topic dots).
 *
 *   🩷 new          pink
 *   🟣 thinking     purple
 *   🟡 generating   yellow
 *   🟡 running_tool yellow
 *   🔵 waiting      blue   ← user request
 *   🟢 idle/done    green
 *   🔴 error        red
 */
export function topicIconForPhase(phase: TopicIconPhase): TopicIconStyle {
  switch (phase) {
    case 'new':
      return { phase, iconColor: TOPIC_ICON_COLOR.pink };
    case 'thinking':
      return { phase, iconColor: TOPIC_ICON_COLOR.purple };
    case 'generating':
    case 'running_tool':
      return { phase, iconColor: TOPIC_ICON_COLOR.yellow };
    case 'waiting_approval':
      return { phase, iconColor: TOPIC_ICON_COLOR.blue };
    case 'error':
      return { phase, iconColor: TOPIC_ICON_COLOR.red };
    case 'idle':
    default:
      return { phase: 'idle', iconColor: TOPIC_ICON_COLOR.green };
  }
}

export function topicIconForSnapshot(
  agentStatus: AgentStatus,
  pendingApprovalCount = 0
): TopicIconStyle {
  return topicIconForPhase(topicPhaseFromSnapshot(agentStatus, pendingApprovalCount));
}
