/**
 * Format Claude AskUserQuestion tool_input for Telegram (Cursor-style).
 */

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface AskUserQuestionInput {
  questions: AskQuestion[];
  answers?: Record<string, string>;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function parseAskUserQuestionInput(input: unknown): AskUserQuestionInput | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as { questions?: unknown };
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) return null;

  const questions: AskQuestion[] = [];
  for (const q of raw.questions) {
    if (!q || typeof q !== 'object') continue;
    const qq = q as {
      question?: unknown;
      header?: unknown;
      multiSelect?: unknown;
      options?: unknown;
    };
    const question = typeof qq.question === 'string' ? qq.question.trim() : '';
    if (!question) continue;
    const options: AskOption[] = [];
    if (Array.isArray(qq.options)) {
      for (const o of qq.options) {
        if (!o || typeof o !== 'object') continue;
        const oo = o as { label?: unknown; description?: unknown };
        const label = typeof oo.label === 'string' ? oo.label.trim() : '';
        if (!label) continue;
        options.push({
          label,
          description: typeof oo.description === 'string' ? oo.description.trim() : undefined,
        });
      }
    }
    questions.push({
      question,
      header: typeof qq.header === 'string' ? qq.header.trim() : undefined,
      multiSelect: qq.multiSelect === true,
      options,
    });
  }
  return questions.length ? { questions } : null;
}

/** Pretty HTML matching Cursor questionnaire style. */
export function formatAskUserQuestionHtml(
  parsed: AskUserQuestionInput,
  sessionLabel: string
): string {
  const lines: string[] = [];
  lines.push('❓ <b>Claude pergunta</b>');
  if (sessionLabel) lines.push(`<i>${escapeHtml(sessionLabel)}</i>`);

  parsed.questions.forEach((q, qi) => {
    lines.push('');
    const head = q.header ? `<b>${escapeHtml(q.header)}</b> · ` : '';
    lines.push(`${head}${escapeHtml(q.question)}`);
    if (q.multiSelect) lines.push('<i>(pode escolher vários)</i>');
    q.options.forEach((opt, oi) => {
      const letter = LETTERS[oi] ?? String(oi + 1);
      const desc = opt.description ? ` — <i>${escapeHtml(opt.description)}</i>` : '';
      lines.push(`  <b>${letter})</b> ${escapeHtml(opt.label)}${desc}`);
    });
    if (qi === 0 && q.options.length === 0) {
      lines.push('<i>Responde com texto neste tópico.</i>');
    }
  });

  return lines.join('\n');
}

export function optionLetter(index: number): string {
  return LETTERS[index] ?? String(index + 1);
}
