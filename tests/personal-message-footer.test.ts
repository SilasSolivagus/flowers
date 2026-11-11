import { describe, expect, it } from 'vitest';

import { messageOf } from '../src/core/notify/wecom.js';
import { eventTimeText } from '../src/core/notify/group.js';

/**
 * 私聊消息的末行（2026-11-11）。
 *
 * 起因：李嘉把自己的机器人接到了群里，于是群里出现一串「被搁置：…」，
 * 没有主语也没有时间——私聊模板原来只写「发生了什么」。群播报一直有
 * `谁 · 什么时候`，两个频道说同一件事就不该只在一个频道署名。
 */
describe('私聊消息：谁 · 什么时候', () => {
  it('带 actor 与时间（上海，MM-DD HH:mm）', () => {
    const content = messageOf('PAN-751「企业认证」', '被搁置：整体暂停', {
      actor: '李嘉', at: '2026-11-11T01:45:00.000Z', timeText: eventTimeText,
    });
    expect(content).toContain('PAN-751「企业认证」');
    expect(content).toContain('被搁置：整体暂停。');
    expect(content).toContain('李嘉 · 11-11 09:45');
  });

  it('批量脚本写的 actor=system → 显示「系统」', () => {
    const content = messageOf('PAN-751', '被搁置：x', {
      actor: 'system', at: '2026-11-11T01:45:00.000Z', timeText: eventTimeText,
    });
    expect(content).toContain('系统 · 11-11 09:45');
    expect(content).not.toContain('system ·');
  });

  it('不给 meta 时保持两行（老调用不受影响）', () => {
    expect(messageOf('PAN-1', '一句')).toBe('**PAN-1**\n一句。');
  });
});
