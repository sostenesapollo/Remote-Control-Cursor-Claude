import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: string };
    if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
  }
  return parts.join('\n').trim();
}

/** Claude stores project transcripts under ~/.claude/projects/<cwd-with-/-as-->/. */
export function resolveClaudeTranscriptPath(opts: {
  transcript_path?: string;
  session_id?: string;
  cwd?: string;
}): string | null {
  const direct = opts.transcript_path?.trim();
  if (direct && existsSync(direct)) return direct;

  const sessionId = opts.session_id?.trim();
  const cwd = opts.cwd?.trim();
  if (!sessionId || !cwd) return null;

  const encoded = cwd.replace(/\//g, '-');
  const candidate = join(homedir(), '.claude/projects', encoded, `${sessionId}.jsonl`);
  return existsSync(candidate) ? candidate : null;
}

/**
 * Walk the JSONL transcript from the end and return the last message text
 * for the given role (user or assistant). Skips empty / tool-only turns.
 */
export function extractLastRoleText(
  transcriptPath: string,
  role: 'user' | 'assistant'
): string | null {
  if (!existsSync(transcriptPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let obj: {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      continue;
    }
    if (obj.type !== role) continue;
    const msgRole = obj.message?.role;
    if (msgRole && msgRole !== role) continue;
    const text = contentToText(obj.message?.content);
    if (text) return text;
  }
  return null;
}
