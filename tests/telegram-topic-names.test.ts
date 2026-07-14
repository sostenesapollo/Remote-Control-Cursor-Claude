import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatClaudeForumTopicName,
  formatCursorForumTopicName,
  formatForumTopicNameForMapping,
} from '../src/server/transports/telegram/topic-names.js';
import { TOPIC_BRAND_COLOR, topicIconForBrand } from '../src/server/transports/telegram/topic-icons.js';

describe('topic-names', () => {
  it('formats Cursor and Claude names without emoji', () => {
    delete process.env.AGENT_NAME;
    delete process.env.TELEGRAM_AGENT_LABEL;
    assert.equal(
      formatCursorForumTopicName('perto_app_v2', 'App update'),
      'perto_app_v2 — App update'
    );
    assert.equal(
      formatClaudeForumTopicName('Relay'),
      'Claude — Relay'
    );
    assert.ok(!formatCursorForumTopicName('a', 'b').includes('🖱️'));
    assert.ok(!formatClaudeForumTopicName('x').includes('🤖'));
  });

  it('inserts AGENT_NAME tag when set', () => {
    process.env.AGENT_NAME = 'Sosteness';
    try {
      assert.equal(
        formatCursorForumTopicName('perto_app_v2', 'App update'),
        'Sosteness · perto_app_v2 — App update'
      );
      assert.equal(
        formatClaudeForumTopicName('Relay'),
        'Sosteness · Claude — Relay'
      );
    } finally {
      delete process.env.AGENT_NAME;
    }
  });

  it('picks name from mapping kind', () => {
    delete process.env.AGENT_NAME;
    assert.equal(
      formatForumTopicNameForMapping({
        windowId: 'abc',
        windowTitle: 'CursorRemote',
        tabTitle: 'Chat',
      }),
      'CursorRemote — Chat'
    );
    assert.equal(
      formatForumTopicNameForMapping({
        windowId: 'claude::deadbeef',
        windowTitle: 'Claude — Relay',
        tabTitle: 'Claude',
      }),
      'Claude — Relay'
    );
  });
});

describe('topic-icons brand', () => {
  it('uses blue for Cursor and purple for Claude', () => {
    assert.equal(topicIconForBrand('cursor').iconColor, TOPIC_BRAND_COLOR.cursor);
    assert.equal(topicIconForBrand('claude').iconColor, TOPIC_BRAND_COLOR.claude);
    assert.equal(TOPIC_BRAND_COLOR.cursor, 7322096);
    assert.equal(TOPIC_BRAND_COLOR.claude, 13338331);
  });
});
