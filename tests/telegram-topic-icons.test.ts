import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPIC_BRAND_COLOR,
  TOPIC_ICON_COLOR,
  topicIconForBrand,
  topicIconForPhase,
  topicIconForSnapshot,
  topicPhaseFromSnapshot,
} from '../src/server/transports/telegram/topic-icons.js';

describe('topic-icons', () => {
  it('maps brands to fixed colors', () => {
    assert.equal(topicIconForBrand('cursor').iconColor, TOPIC_ICON_COLOR.blue);
    assert.equal(topicIconForBrand('claude').iconColor, TOPIC_ICON_COLOR.purple);
    assert.equal(TOPIC_BRAND_COLOR.cursor, TOPIC_ICON_COLOR.blue);
    assert.equal(TOPIC_BRAND_COLOR.claude, TOPIC_ICON_COLOR.purple);
  });

  it('topicIconForPhase is Cursor-brand (status no longer changes color)', () => {
    assert.equal(topicIconForPhase('waiting_approval').iconColor, TOPIC_ICON_COLOR.blue);
    assert.equal(topicIconForPhase('idle').iconColor, TOPIC_ICON_COLOR.blue);
    assert.equal(topicIconForPhase('error').iconColor, TOPIC_ICON_COLOR.blue);
  });

  it('snapshot helpers keep phase metadata', () => {
    assert.equal(topicPhaseFromSnapshot('thinking', 0), 'thinking');
    assert.equal(topicPhaseFromSnapshot('idle', 1), 'waiting_approval');
    assert.equal(topicIconForSnapshot('running_tool', 0).brand, 'cursor');
  });
});
