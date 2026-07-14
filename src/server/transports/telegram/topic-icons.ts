import type { AgentStatus } from '../../types.js';

/**
 * Telegram forum topic icon colors — solid colored circles (no custom emoji).
 * Valid on createForumTopic / editForumTopic.
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

export type TopicBrand = 'cursor' | 'claude';

/**
 * Fixed brand colors so Cursor vs Claude is obvious in the topic list.
 *   Cursor → blue
 *   Claude → purple
 * Status (thinking/idle/…) is no longer encoded in the circle.
 */
export const TOPIC_BRAND_COLOR: Record<TopicBrand, number> = {
  cursor: TOPIC_ICON_COLOR.blue,
  claude: TOPIC_ICON_COLOR.purple,
};

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
  brand: TopicBrand;
}

export function topicIconForBrand(
  brand: TopicBrand,
  phase: TopicIconPhase = 'idle'
): TopicIconStyle {
  return { brand, phase, iconColor: TOPIC_BRAND_COLOR[brand] };
}

/**
 * Resolve the visual phase for a live window snapshot.
 * Kept for activity messaging; brand color no longer follows phase.
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

/** @deprecated Prefer topicIconForBrand('cursor'|'claude'). Phase ignored for color. */
export function topicIconForPhase(phase: TopicIconPhase): TopicIconStyle {
  return topicIconForBrand('cursor', phase);
}

export function topicIconForSnapshot(
  agentStatus: AgentStatus,
  pendingApprovalCount = 0
): TopicIconStyle {
  return topicIconForBrand(
    'cursor',
    topicPhaseFromSnapshot(agentStatus, pendingApprovalCount)
  );
}
