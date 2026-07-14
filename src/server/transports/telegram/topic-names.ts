/**
 * Forum topic display names — emoji prefix so Cursor vs Claude topics
 * are easy to spot in the Telegram topic list.
 *
 * Internal TopicMapping.windowTitle stays without the emoji (match/logic).
 * Only the Telegram topic `name` shown in the UI gets the prefix.
 */

export const CURSOR_TOPIC_EMOJI = '🖱️';
export const CLAUDE_TOPIC_EMOJI = '🤖';

export function formatCursorForumTopicName(windowTitle: string, tabTitle: string): string {
  return `${CURSOR_TOPIC_EMOJI} ${windowTitle} — ${tabTitle}`.substring(0, 128);
}

export function formatClaudeForumTopicName(projectLabel: string): string {
  return `${CLAUDE_TOPIC_EMOJI} Claude — ${projectLabel}`.substring(0, 128);
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
