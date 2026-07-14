/**
 * Forum topic display names.
 *
 * Brand identity uses Telegram's colored topic circle (see topic-icons),
 * not emoji in the title. Optional AGENT_NAME / TELEGRAM_AGENT_LABEL still
 * prefixes the machine so two Macs in one group stay distinct.
 */

function agentTag(): string {
  return (process.env.AGENT_NAME ?? process.env.TELEGRAM_AGENT_LABEL ?? '').trim();
}

/** Strip legacy emoji prefixes (🖱️ / 🤖) from names we rename. */
export function stripTopicNameDecorations(name: string): string {
  return name
    .replace(/^[🖱️🤖]\s*/u, '')
    .replace(/^(🖱️|🤖)\s*/u, '')
    .trim();
}

export function formatCursorForumTopicName(windowTitle: string, tabTitle: string): string {
  const tag = agentTag();
  const head = tag ? `${tag} · ` : '';
  return `${head}${windowTitle} — ${tabTitle}`.substring(0, 128);
}

export function formatClaudeForumTopicName(projectLabel: string): string {
  const tag = agentTag();
  const head = tag ? `${tag} · ` : '';
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

export function isClaudeTopicMapping(mapping: {
  windowId: string;
  windowTitle: string;
}): boolean {
  return (
    mapping.windowId.startsWith('claude::') ||
    mapping.windowTitle.startsWith('Claude — ')
  );
}
