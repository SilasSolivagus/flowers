'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  bindWecomAction, lookupWecomAction, saveWebhookAction, testWebhookAction,
} from '../actions';
import type { WecomBindingView } from '../../src/core/read/wecom-binding';

/**
 * 设置 · 我的 →「企微」那两行（2026-11-10）：**绑定我的 userid** 与 **用我自己的机器人**。
 *
 * 为什么要有这两行：在它们之前，`企微账号` 是**别人**替你看的一个值（超管点「查一下」，
 * 名字去通讯录里匹配一次，命中就写进库）。于是普通人既看不到「我现在算绑上了没有」，
 * 也没有任何一条路能自己绑——他能做的只有找超管。而「用自己的机器人（分流到我们组的群）」
 * 这件事根本不存在。
 *
 * 四个组件、两条规矩：
 * - `WecomBinding` 只画两**行**（状态 + 一个动作）；展开的面板各自是独立组件
 *   （`BindPanel` / `RobotPanel`），它们自己拿状态、自己调动作。这样「面板长什么样」
 *   能被单独渲染出来验证（见 `tests/wecom-binding-ui.test.tsx`），而不是藏在一个
 *   `useState` 后面——「加了一个没人看得到的说明」正是这一条要防的坏法。
 * - 失败文案一律**服务层原文**：`企微通讯录里没有 userid 为「lvpin2」的人…` 这句话本身
 *   就是下一步；改写成「验证失败，请重试」等于把线索扔了。
 *
 * 界面上的三条口径：
 * 1. **状态先说**（`已绑定` / `未绑定` / `验证失败`）。三者里只有 `验证失败` 需要一句
 *    额外的话（「上次试过、没成」），否则它读起来像 `未绑定`，而两者的下一步不一样。
 * 2. **说明只有两句**，说的是**用途**（私聊通知），不是功能清单。设置页原来那条
 *    「不出现解释性文案」的规矩在这里让位：「绑定企微」对普通成员是全新的东西，
 *    第一次出现时必须有一句为什么。
 * 3. **webhook 只回显末 4 位**（`view.webhook` 已经是掩码，这一层不碰真值）。整串等于
 *    一个能往群里发消息的凭证——一次投屏就没了。
 */

export function WecomBinding({ view }: { view: WecomBindingView }) {
  const router = useRouter();
  const [bindOpen, setBindOpen] = useState(false);
  const [robotOpen, setRobotOpen] = useState(false);

  return (
    <>
      <div className="i gen-row" data-bind="wecom">
        <div className="l"><b>绑定企微</b></div>
        <div className="v gen-actions">
          {/* 未激活用 warn 而不是 no：绑定是对的，只是还差一个动作，不是失败。 */}
          <span className={`pill ${view.state === 'bound' ? 'ok' : view.state === 'need_init' ? 'warn' : 'no'}`}>
            {view.stateLabel}
          </span>
          {(view.state === 'bound' || view.state === 'need_init') && view.userid !== null && (
            <span className="wx-id">{view.userid}</span>
          )}
          <button
            className="btn ghost sm"
            type="button"
            aria-expanded={bindOpen}
            onClick={() => setBindOpen((was) => !was)}
          >
            {bindOpen ? '取消' : (view.state === 'bound' ? '改' : '绑定')}
          </button>
        </div>
      </div>

      {/* `验证失败` 要多一句：不然它读起来像「未绑定」，而下一步完全不同。 */}
      {view.state === 'failed' && (
        <div className="i gen-detail">
          <div className="wx-note">
            {`上次验证没通过${view.lastLookupDay === null ? '' : `（${view.lastLookupDay}）`}：`
              + '账号没对上，通知发不出来。把 userid 核对一遍再验证一次。'}
          </div>
        </div>
      )}

      {bindOpen && (
        <BindPanel
          view={view}
          onChanged={() => {
            setBindOpen(false);
            router.refresh();
          }}
        />
      )}

      <div className="i gen-row" data-bind="robot">
        <div className="l"><b>用自己的机器人</b></div>
        <div className="v gen-actions">
          <span className={`pill ${view.webhookSet ? 'ok' : 'no'}`}>
            {view.webhookSet ? '已设置' : '未设置'}
          </span>
          {/* 只回显掩码：整串 webhook 等于一个能往群里发消息的凭证。 */}
          {view.webhook !== null && <span className="wx-hook">{view.webhook}</span>}
          <button
            className="btn ghost sm"
            type="button"
            aria-expanded={robotOpen}
            onClick={() => setRobotOpen((was) => !was)}
          >
            {robotOpen ? '取消' : (view.webhookSet ? '改' : '设置')}
          </button>
        </div>
      </div>

      {robotOpen && (
        <RobotPanel
          view={view}
          onChanged={() => {
            setRobotOpen(false);
            router.refresh();
          }}
        />
      )}
    </>
  );
}

/** 「绑定企微」的展开面板（导出是为了能被单独渲染出来验证文案）。 */
export function BindPanel({ view, onChanged }: {
  view: WecomBindingView;
  onChanged: () => void;
}) {
  const [userid, setUserid] = useState(view.userid ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const submit = async (value: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    const form = new FormData();
    form.set('userid', value);
    try {
      const result = await bindWecomAction(form);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNote(result.cleared ? '已解绑' : `已绑定 · ${result.name}`);
      onChanged();
    } catch {
      setError('验证没有送达');
    } finally {
      setBusy(false);
    }
  };

  /** 「按名字查」：复用已有的那条路（`lookupWecomAction`），把 userid 填进框里等人确认。 */
  const fillFromName = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await lookupWecomAction();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setUserid(result.userid);
      setNote(`通讯录里你是「${result.name}」——按「验证」把这条绑上`);
    } catch {
      setError('查询没有送达');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="i gen-detail mk-form" data-panel="bind">
      <div className="wx-note">{BIND_WHY}</div>
      <div className="wx-note">{USERID_HOW}</div>
      <label className="mk-f">
        <span>userid</span>
        <input
          className="gen-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="例如：lvpin"
          value={userid}
          onChange={(event) => setUserid(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit(userid.trim());
          }}
        />
      </label>
      <div className="mk-acts">
        <button
          className="btn sm primary"
          type="button"
          disabled={busy || userid.trim() === ''}
          onClick={() => void submit(userid.trim())}
        >
          {busy ? '验证中' : '验证'}
        </button>
        <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void fillFromName()}>
          按名字查
        </button>
        {view.state === 'bound' && (
          <button className="btn ghost sm" type="button" disabled={busy} onClick={() => void submit('')}>
            解绑
          </button>
        )}
      </div>
      {error !== null && <div className="gen-msg bad">{error}</div>}
      {note !== null && <div className="gen-msg">{note}</div>}
    </div>
  );
}

/** 「用自己的机器人」的展开面板。 */
export function RobotPanel({ view, onChanged }: {
  view: WecomBindingView;
  onChanged: () => void;
}) {
  const [webhook, setWebhook] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (kind: 'test' | 'save', value: string): Promise<void> => {
    setBusy(kind);
    setError(null);
    setNote(null);
    const form = new FormData();
    form.set('webhook', value);
    try {
      if (kind === 'test') {
        const result = await testWebhookAction(form);
        if (!result.ok) setError(result.message);
        else setNote(result.message);
        return;
      }
      const result = await saveWebhookAction(form);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setNote(result.cleared ? '已清除：通知回到共用的机器人' : `已保存（${result.masked ?? ''}）`);
      setWebhook('');
      onChanged();
    } catch {
      setError('请求没有送达');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="i gen-detail mk-form" data-panel="robot">
      <div className="wx-note">{ROBOT_WHY}</div>
      <label className="mk-f">
        <span>webhook</span>
        <input
          className="gen-input"
          type="url"
          spellCheck={false}
          autoComplete="off"
          placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
          value={webhook}
          onChange={(event) => setWebhook(event.target.value)}
        />
      </label>
      <div className="mk-acts">
        <button className="btn sm" type="button" disabled={busy !== null} onClick={() => void run('test', webhook)}>
          {busy === 'test' ? '发送中' : '测试'}
        </button>
        <button
          className="btn sm primary"
          type="button"
          disabled={busy !== null || webhook.trim() === ''}
          onClick={() => void run('save', webhook)}
        >
          {busy === 'save' ? '保存中' : '保存'}
        </button>
        {view.webhookSet && (
          <button className="btn ghost sm" type="button" disabled={busy !== null} onClick={() => void run('save', '')}>
            清除
          </button>
        )}
      </div>
      {error !== null && <div className="gen-msg bad">{error}</div>}
      {note !== null && <div className="gen-msg">{note}</div>}
    </div>
  );
}

/**
 * 绑定那两句（**用途**，不是功能清单）。导出是为了让用例能逐字钉住它们：
 * 「私聊通知」与「怎么拿到 userid」这两件事，是这次要补的全部引导。
 */
export const BIND_WHY = '绑定之后，需要你动手的需求和评审结果会直接私聊发到你的企微，'
  + '不用回站内看。没绑定也能用，只是收不到这些通知。'
  + '注意：共用的那台是个人机器人，只有它的主人能收到，别人点开会提示「无法与它聊天」。'
  + '所以除了主人以外的成员，要收到私聊只有一个办法——在下面「用自己的机器人」里填一个群机器人 webhook。';

/**
 * 「userid 从哪来」（2026-11-11 纠正）。
 *
 * 上一版写的是「企业微信 → 我 → 资料页（工号那一栏就是它）」——**错的**：
 * 手机端「我」里只有姓名、部门、手机、邮箱，看不到 UserID；工号是另一列，很多企业还没填。
 * 而且这个账号常常是一串 `wou…` 这样的 id，让人手抄不现实。
 *
 * 所以主路径是**按钮**：点「按名字查」，服务端去通讯录按姓名查，查到就把 userid 填进框里。
 * 手抄那条只留给管理员（且只在后台能看到），写清具体入口，不写「资料页」。
 */
export const USERID_HOW = '拿到 userid 最快的办法：点下面「按名字查」，系统去企微通讯录按你的姓名查，'
  + '查到就自动填进框里，再按「验证」。手机上「我 → 个人信息」看不到这串账号（那里只有姓名、部门、手机）。'
  + '要自己去后台看：管理员登录 work.weixin.qq.com →「通讯录」→ 点开成员 → 「账号」那一栏就是它。';

/** 机器人的那一段说明：可选、只对自己生效、存在本地、只回显末 4 位。 */
export const ROBOT_WHY = '可选。设了之后，私聊推送发到这个机器人，不再走共用那条路'
  + '（组里想分流到自己群时用）。群播报不受影响：产品群是公共频道，所有人看到的是同一批'
  + '消息——「测试」按钮也只验证这条私聊链路。地址只存在这个部署的库里，界面上只显示末 4 位。';

export default WecomBinding;
