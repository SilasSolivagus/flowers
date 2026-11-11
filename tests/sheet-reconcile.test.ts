import { describe, expect, it } from 'vitest';

import { normTitle, reconcile, type SheetRow } from '../src/core/sheet/reconcile.js';

/**
 * 企微表核对（2026-11-11，H4）。
 *
 * 纯函数，钉的是「建议对不对」：同名在收集 → 挪；已在做 → 不动；没有 → 新建。
 * 落库那一步由 `applyReconcile` 负责（有事件、有 batch，见导入脚本同一套口径）。
 */
const row = (num: string, title: string): SheetRow => ({
  num, title, owner: '赵越', priority: 'P0', platforms: 'Web', prdUrl: 'https://doc/x',
});

describe('标题归一', () => {
  it('去括号注记与标点', () => {
    expect(normTitle('S3 协议支持（上迭代遗留）')).toBe('s3协议支持');
    expect(normTitle('【白名单】解约30天')).toBe('白名单解约30天');
  });
});

describe('给建议', () => {
  const existing = [
    { id: 'a', number: 380, title: 'S3 协议支持', state: 'inbox' },
    { id: 'b', number: 772, title: '123云盘-联想PC端联运版', state: 'ready' },
  ];

  it('同名在收集 → 挪进待排期', () => {
    const [item] = reconcile([row('3', 'S3 协议支持（上迭代遗留）')], existing);
    expect(item!.action).toBe('move');
    expect(item!.match?.number).toBe(380);
  });

  it('已经在做 → 不动', () => {
    const [item] = reconcile([row('11', '123云盘-联想PC端联运版')], existing);
    expect(item!.action).toBe('keep');
  });

  it('池里没有 → 新建', () => {
    const [item] = reconcile([row('20', '账号绑定与QQ登录')], existing);
    expect(item!.action).toBe('create');
    expect(item!.match).toBeNull();
  });

  it('一行表对应多条时取「标题最像」的那条', () => {
    const many = [
      { id: 'x', number: 900, title: '分享创建页改版', state: 'inbox' },
      { id: 'y', number: 901, title: '分享创建页改版-网页分享', state: 'inbox' },
    ];
    const [item] = reconcile([row('6', '分享创建页改版-网页分享')], many);
    expect(item!.match?.number).toBe(901);
  });
});
