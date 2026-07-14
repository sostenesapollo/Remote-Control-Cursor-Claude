import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAskUserQuestionHtml,
  parseAskUserQuestionInput,
} from '../src/server/claude-ask.js';

describe('claude-ask', () => {
  it('parses AskUserQuestion tool_input', () => {
    const parsed = parseAskUserQuestionInput({
      questions: [
        {
          question: 'O que você quer criar?',
          header: 'Tipo',
          multiSelect: false,
          options: [
            { label: 'Nova ferramenta (tool)', description: 'Nova página/tool' },
            { label: 'Novo portal', description: 'Novo app em apps/' },
          ],
        },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed!.questions.length, 1);
    assert.equal(parsed!.questions[0].options.length, 2);
  });

  it('formats without dumping raw JSON', () => {
    const parsed = parseAskUserQuestionInput({
      questions: [
        {
          question: 'O que você quer criar?',
          header: 'Tipo',
          options: [
            { label: 'Nova ferramenta (tool)', description: 'em portal' },
            { label: 'Novo portal' },
          ],
        },
      ],
    });
    const html = formatAskUserQuestionHtml(parsed!, 'Relay');
    assert.match(html, /Claude pergunta/);
    assert.match(html, /O que você quer criar/);
    assert.match(html, /A\).*Nova ferramenta/);
    assert.match(html, /B\).*Novo portal/);
    assert.ok(!html.includes('"questions"'));
  });
});
