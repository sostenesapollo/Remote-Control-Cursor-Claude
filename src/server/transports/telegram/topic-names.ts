/**
 * Forum topic display names — emoji prefix so Cursor vs Claude topics
 * are easy to spot in the Telegram topic list.
 *
 * Internal TopicMapping.windowTitle stays without the emoji (match/logic).
 * Only the Telegram topic `name` shown in the UI gets the prefix.
 *
 * Optional AGENT_NAME / TELEGRAM_AGENT_LABEL (e.g. "Sosteness") inserts a
 * machine tag so two Macs sharing one group stay visually distinct.
 */

export const CURSOR_TOPIC_EMOJI = '🖱️';
export const CLAUDE_TOPIC_EMOJI = '🤖';

function agentTag(): string {
  return (process.env.AGENT_NAME ?? process.env.TELEGRAM_AGENT_LABEL ?? '').trim();
}

export function formatCursorForumTopicName(windowTitle: string, tabTitle: string): string {
  const tag = agentTag();
  const head = tag ? `${CURSOR_TOPIC_EMOJI} ${tag} · ` : `${CURSOR_TOPIC_EMOJI} `;
  return `${head}${windowTitle} — ${tabTitle}`.substring(0, 128);
}

export function formatClaudeForumTopicName(projectLabel: string): string {
  const tag = agentTag();
  const head = tag ? `${CLAUDE_TOPIC_EMOJI} ${tag} · ` : `${CLAUDE_TOPIC_EMOJI} `;
  return `${head}Claude — ${projectLabel}`.substring(0, 128);
}

/** Build the public Telegram name for a stored mapping. */
export function formatForumTopicNameForMapping(mapping: {
  windowId: string;
  windowTitle: string;
  tabTitle: string;
}): string {
  if (
    mapping.windowId.startsWith('claude::') ||
    mapping.windowTitle.startsWith('Claude — ')
  ) {
    const label = mapping.windowTitle.replace(/^Claude — /, '') || mapping.tabTitle;
    return formatClaudeForumTopicName(label);
  }
  return formatCursorForumTopicName(mapping.windowTitle, mapping.tabTitle);
}
