import { AppError } from './errors.js';

export type State =
  | 'inbox' | 'design' | 'review' | 'queue' | 'ready'
  | 'dev' | 'test' | 'live' | 'rejected' | 'shelved';

export type Transition = {
  from: State; to: State; trigger: string;
  clock?: boolean;
  guard?: 'prd' | 'type' | 'dates' | 'new_due';
};

export const TRANSITIONS: Transition[] = [
  { from: 'inbox',  to: 'design',  trigger: 'evaluate',      guard: 'type' },
  { from: 'inbox',  to: 'review',  trigger: 'submit_review', guard: 'prd'  },
  { from: 'inbox',  to: 'rejected', trigger: 'reject' },
  { from: 'inbox',  to: 'shelved', trigger: 'shelve' },
  { from: 'design', to: 'review',  trigger: 'submit_review', guard: 'prd'  },
  { from: 'review', to: 'queue',   trigger: 'review_pass' },
  { from: 'review', to: 'design',  trigger: 'review_reject' },
  { from: 'queue',  to: 'ready',   trigger: 'schedule',      guard: 'dates' },
  { from: 'ready',  to: 'dev',     trigger: 'clock',         clock: true },
  { from: 'dev',    to: 'test',    trigger: 'clock',         clock: true },
  { from: 'test',   to: 'live',    trigger: 'clock',         clock: true },
  { from: 'test',   to: 'dev',     trigger: 'bounce',        guard: 'new_due' },
  { from: 'shelved', to: 'inbox',  trigger: 'restore' },
];

export function find(from: State, to: State) {
  const t = TRANSITIONS.find((x) => x.from === from && x.to === to);
  if (!t) throw new AppError('illegal_transition', `不能从「${from}」直接到「${to}」`);
  return t;
}

export function assertTransition(
  from: State, to: State, ctx: { hasPrd: boolean; hasType: boolean },
) {
  const t = find(from, to);
  if (t.guard === 'prd' && !ctx.hasPrd) {
    throw new AppError('missing_prd', '直接提交评审必须有正式 PRD 链接');
  }
  if (t.guard === 'type' && !ctx.hasType) {
    throw new AppError('missing_type', '需求必须有类型（商业 / 功能）才能进入下一步');
  }
  return t;
}

export const isClockTransition = (from: State, to: State) => !!find(from, to).clock;
