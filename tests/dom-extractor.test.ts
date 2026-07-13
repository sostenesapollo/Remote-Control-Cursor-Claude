import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractionFunction } from '../src/server/dom-extractor.js';
import type { CursorState } from '../src/server/types.js';

function withDom(html: string): CursorState {
  const dom = new JSDOM(html);
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const nodeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: dom.window.Node,
  });
  try {
    const state = extractionFunction(
      ['#root'],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      []
    );
    assert.ok(state, 'expected extractionFunction to return state');
    return state;
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    } else {
      delete globalThis.document;
    }
    if (nodeDescriptor) {
      Object.defineProperty(globalThis, 'Node', nodeDescriptor);
    } else {
      delete globalThis.Node;
    }
  }
}

describe('extractionFunction', () => {
  it('emits Cursor 3.8 activity tool-placeholder rows without data-message-role', () => {
    const state = withDom(`
      <main id="root">
        <div data-find-row-key="tool-placeholder:call-1">
          <article data-flat-index="0" data-react-transcript-row-kind="activity" data-message-id="m-tool">
            <div data-tool-call-id="call-1" data-tool-status="completed">
              <span class="ui-tool-call-line-action">Read</span>
              <span class="ui-tool-call-line-details">src/server/dom-extractor.ts</span>
            </div>
          </article>
        </div>
      </main>
    `);

    const tool = state.messages.find((message) => message.type === 'tool');

    assert.ok(tool, 'expected a tool element to be emitted');
    assert.equal(tool.toolCallId, 'call-1');
    assert.equal(tool.action, 'Read');
  });

  it('uses anchored selector paths for data-click-ready questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
          <section class="composer-questionnaire-toolbar-actions">
            <div data-click-ready="true">
              <span><span class="truncate">Skip</span></span>
            </div>
            <div class="shortcut">Esc</div>
            <div data-click-ready="true" data-disabled="true">
              <span><span class="truncate">Continue</span></span>
            </div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(1)'
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      '.composer-questionnaire-toolbar-actions > div[data-click-ready]:nth-child(3)'
    );
    assert.equal(state.questionnaire.continueDisabled, true);
  });

  it('emits anchored option-row selector paths for questionnaire options (public#50)', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <div class="composer-questionnaire-toolbar-stepper-label">1 of 1</div>
          <div class="composer-questionnaire-toolbar-questions">
            <div class="composer-questionnaire-toolbar-question composer-questionnaire-toolbar-question-active">
              <div class="composer-questionnaire-toolbar-question-number">1.</div>
              <div class="composer-questionnaire-toolbar-options">
                <div class="composer-questionnaire-toolbar-option" role="button">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">A</button>
                  <span class="composer-questionnaire-toolbar-option-label">Explore the codebase</span>
                </div>
                <div class="composer-questionnaire-toolbar-option composer-questionnaire-toolbar-option-freeform" role="button">
                  <button class="composer-questionnaire-toolbar-option-letter" type="button">B</button>
                  <textarea class="composer-questionnaire-toolbar-freeform-input"></textarea>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    const [question] = state.questionnaire.questions;
    assert.equal(question.options.length, 2);
    assert.equal(question.options[0].label, 'Explore the codebase');
    assert.equal(
      question.options[0].selectorPath,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(1)'
    );
    assert.equal(question.options[1].label, 'Other');
    assert.equal(question.options[1].isFreeform, true);
    assert.equal(
      question.options[1].selectorPath,
      '.composer-questionnaire-toolbar-question:nth-of-type(1) .composer-questionnaire-toolbar-option:nth-of-type(2)'
    );
  });

  it('keeps buildSelectorPath selectors for legacy questionnaire actions', () => {
    const state = withDom(`
      <main id="root"></main>
      <div id="composer-toolbar-section">
        <div class="composer-questionnaire-toolbar">
          <section class="composer-questionnaire-toolbar-actions">
            <div class="composer-skip-button">Skip</div>
            <div class="composer-run-button" data-disabled="false">Continue</div>
          </section>
        </div>
      </div>
    `);

    assert.ok(state.questionnaire);
    assert.equal(
      state.questionnaire.skipSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(1)'
    );
    assert.equal(
      state.questionnaire.continueSelectorPath,
      'div#composer-toolbar-section > div > section > div:nth-of-type(2)'
    );
    assert.equal(state.questionnaire.continueDisabled, false);
  });

  it('does not surface approvals for completed shell tool cards', () => {
    const state = withDom(`
      <main id="root">
        <div data-tool-call-id="shell-done" data-tool-status="completed" class="ui-tool-call-card">
          <div class="ui-shell-tool-call__approval-row">
            <button class="ui-shell-tool-call__run-btn">Run</button>
            <button class="ui-shell-tool-call__skip-btn">Skip</button>
          </div>
          <div class="ui-shell-tool-call__command">aws ec2 describe-instances</div>
        </div>
      </main>
    `);

    assert.equal(state.pendingApprovals.length, 0);
    assert.notEqual(state.agentStatus, 'waiting_approval');
  });

  it('does not surface hidden approval buttons from stale DOM', () => {
    const state = withDom(`
      <main id="root">
        <div data-tool-call-id="shell-stale" data-tool-status="loading" class="ui-tool-call-card" hidden>
          <div class="ui-shell-tool-call__approval-row">
            <button class="ui-shell-tool-call__run-btn" aria-label="Accept">Run</button>
            <button class="ui-shell-tool-call__skip-btn" aria-label="Reject">Skip</button>
          </div>
        </div>
      </main>
    `);

    assert.equal(state.pendingApprovals.length, 0);
  });

  it('does not attach actions to completed tool messages', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="0" data-message-role="ai" data-message-kind="tool">
          <div data-tool-call-id="fetch-done" data-tool-status="completed">
            <div class="composer-tool-former-message">
              <div class="composer-tool-call-status-row">
                <button class="composer-skip-button">Skip</button>
                <button class="composer-run-button anysphere-secondary-button">Allow</button>
              </div>
            </div>
          </div>
        </article>
      </main>
    `);

    const tool = state.messages.find((message) => message.type === 'tool');
    assert.ok(tool);
    assert.equal(tool.actions, undefined);
  });

  it('ignores stale approval rows from older messages in the transcript', () => {
    const state = withDom(`
      <main id="root">
        <article data-flat-index="1" data-message-role="ai" data-message-kind="tool">
          <div data-tool-call-id="old-shell" data-tool-status="loading" class="ui-tool-call-card">
            <div class="ui-shell-tool-call__approval-row">
              <button class="ui-shell-tool-call__run-btn">Run</button>
              <button class="ui-shell-tool-call__skip-btn">Skip</button>
            </div>
            <div class="ui-shell-tool-call__command">aws ec2 describe-instances</div>
          </div>
        </article>
        <article data-flat-index="5" data-message-role="ai" data-message-kind="tool">
          <div data-tool-call-id="new-shell" data-tool-status="completed" class="ui-tool-call-card">
            <div class="ui-shell-tool-call__command">tail -f /var/log/bake.log</div>
          </div>
        </article>
      </main>
    `);

    assert.equal(state.pendingApprovals.length, 0);
  });
});
