import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import type { WecomBindingView } from '../src/core/read/wecom-binding.js';
import {
  BIND_WHY, BindPanel, ROBOT_WHY, RobotPanel, USERID_HOW, WecomBinding,
} from '../app/settings/WecomBinding';

/**
 * 设置 · 我的 →「企微」那两行**在屏上长什么样**（2026-11-10）。
 *
 * 服务层已经有 21 条用例（`wecom-binding.test.ts`）证明「验证真的查通讯录」「webhook
 * 真的只回显末 4 位」。这一组只回答一个问题：**这些事实有没有被画出来**。
 * 它对着渲染出来的 HTML 断言，而不是对着一个辅助函数——辅助函数对、而页面没用它，
 * 正是「加了一个没人看得到的功能」的标准坏法。
 *
 * `useRouter` / server actions 在用例进程里起不来（`app/actions.ts` 是 `'use server'`），
 * 所以把它们换掉：这一组测的是**文案与状态**，不是点了之后服务端做什么。
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock('../app/actions', () => ({
  bindWecomAction: vi.fn(async () => ({ ok: true, userid: 'lvpin', name: '吕品', cleared: false })),
  lookupWecomAction: vi.fn(async () => ({ ok: true, name: '吕品', userid: 'lvpin', cached: true })),
  saveWebhookAction: vi.fn(async () => ({ ok: true, masked: null, cleared: true })),
  testWebhookAction: vi.fn(async () => ({ ok: true, message: '已发出' })),
}));

function htmlOf(view: WecomBindingView): string {
  return renderToStaticMarkup(<WecomBinding view={view} />);
}

const UNBOUND: WecomBindingView = {
  state: 'unbound', stateLabel: '未绑定', userid: null,
  webhook: null, webhookSet: false, lastLookupDay: null,
};

const BOUND: WecomBindingView = {
  state: 'bound', stateLabel: '已绑定', userid: 'lvpin',
  webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=****wxyz',
  webhookSet: true, lastLookupDay: '2026-11-10',
};

const FAILED: WecomBindingView = {
  state: 'failed', stateLabel: '验证失败', userid: null,
  webhook: null, webhookSet: false, lastLookupDay: '2026-11-09',
};

describe('企微那两行', () => {
  it('未绑定：两行都在，各自有一个动作', () => {
    const html = htmlOf(UNBOUND);
    expect(html).toContain('绑定企微');
    expect(html).toContain('未绑定');
    expect(html).toContain('用自己的机器人');
    expect(html).toContain('未设置');
    expect(html).toContain('>绑定<');
    expect(html).toContain('>设置<');
  });

  it('已绑定：显示 userid（要能认出「这不是我」），动作变成「改」', () => {
    const html = htmlOf(BOUND);
    expect(html).toContain('已绑定');
    expect(html).toContain('lvpin');
    expect(html).toContain('>改<');
  });

  it('验证失败：多一句「上次验证没通过」+ 那一天（否则读起来像未绑定）', () => {
    const html = htmlOf(FAILED);
    expect(html).toContain('验证失败');
    expect(html).toContain('上次验证没通过');
    expect(html).toContain('2026-11-09');
  });

  it('webhook 只出现掩码：整串 key 一个字都不许进 HTML', () => {
    const html = htmlOf(BOUND);
    expect(html).toContain('****wxyz');
    expect(html).not.toContain('abcd-1234');
  });

  it('收起时不占版面：说明只在展开之后出现', () => {
    const collapsed = htmlOf(UNBOUND);
    expect(collapsed).not.toContain('私聊发到你的企微');
    expect(collapsed).not.toContain('webhook');
  });

  it('展开的绑定面板：两句用途说明 + 「userid 从哪来」+ 验证/按名字查两条动作', () => {
    const html = renderToStaticMarkup(<BindPanel view={UNBOUND} onChanged={() => undefined} />);
    // 一、用途（私聊通知）。
    expect(html).toContain('私聊发到你的企微');
    // 二、怎么拿到自己的 userid（企业微信里那条路 + 管理员那条路）。
    expect(html).toContain('企业微信 → 我 → 资料页');
    expect(html).toContain('通讯录');
    // 三、输入框与「验证」。
    expect(html).toContain('placeholder="例如：lvpin"');
    expect(html).toContain('>验证<');
    // 四、不知道自己的 userid 时那条老路还在（复用「查一下」）。
    expect(html).toContain('按名字查');
    // 未绑定时没有「解绑」——那个动作只在已绑定时才说得通。
    expect(html).not.toContain('>解绑<');
  });

  it('已绑定时展开面板多一个「解绑」', () => {
    const html = renderToStaticMarkup(<BindPanel view={BOUND} onChanged={() => undefined} />);
    expect(html).toContain('>解绑<');
    // 输入框预填当前绑着的 userid：改的时候不用重新抄一遍。
    expect(html).toContain('value="lvpin"');
  });

  it('展开的机器人面板：可选/只对自己/只回显末 4 位 + 测试与保存', () => {
    const html = renderToStaticMarkup(<RobotPanel view={BOUND} onChanged={() => undefined} />);
    expect(html).toContain('不再走共用那条路');
    expect(html).toContain('只存在这个部署的库里');
    expect(html).toContain('只显示末 4 位');
    expect(html).toContain('>测试<');
    expect(html).toContain('>保存<');
    // 已设置时才有「清除」。
    expect(html).toContain('>清除<');
    // 面板里的输入框永远是空的：**不回显**（连掩码也不回填，避免把两条地址混起来）。
    expect(html).not.toContain('****wxyz');
  });

  it('三段说明各自只说一件事（文案本身不退化成一串功能清单）', () => {
    expect(BIND_WHY).toContain('私聊');
    expect(BIND_WHY).toContain('没绑定也能用');
    expect(USERID_HOW).toContain('资料页');
    expect(ROBOT_WHY).toContain('可选');
    // 「存在本地」这件事必须在，因为它是「我凭什么敢填」的依据。
    expect(ROBOT_WHY).toContain('库里');
  });
});
