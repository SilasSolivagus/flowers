import { describe, expect, it } from 'vitest';
import { filterCards, formatDigest, parseArgs, type Card } from '../scripts/audit-schedule-vs-git.js';

const now = new Date('2026-11-23T00:00:00Z');
const card = (overrides: Partial<Card> = {}): Card => ({ number: 8, title: 'Audit', state: 'ready', enteredAt: '2026-11-20T00:00:00Z', dueAt: null, testAt: null, ...overrides });
describe('audit schedule vs git', () => {
  it('filters due, testing, overdue and stuck cards', () => {
    expect(filterCards([card({ dueAt: '2026-11-27T00:00:00Z' }), card({ testAt: '2026-11-28T00:00:00Z' }), card({ state: 'dev', enteredAt: '2026-11-01T00:00:00Z' }), card()], now)).toHaveLength(3);
  });
  it('parses dry run and rejects unknown args', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(() => parseArgs(['--send'])).toThrow();
  });
  it('formats schedule and git comparison and caps output at 600 chars', () => {
    const digest = formatDigest(Array.from({ length: 40 }, (_, i) => card({ number: i + 1, title: 'A long card title for truncation coverage', dueAt: '2026-11-20T00:00:00Z' })), [], now);
    expect(digest).toContain('逾期');
    expect(digest).toContain('近 7 天提交');
    expect(digest.length).toBeLessThanOrEqual(600);
  });
  it('renders a no-alert state', () => expect(formatDigest([], [], now)).toContain('近期无'));
});
