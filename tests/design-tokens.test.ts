import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * silas-UX 是**外部真源**（github.com/SilasSolivagus/silas-UX）：颜色、字阶、间距、
 * 圆角、动效都从那里取，本仓库只消费。规矩写在它的 docs/usage.md 里，落成两条可跑的断言。
 *
 * 为什么是断言而不是一份评审清单：`app/tokens.css` 上一版是手抄的，抄完就开始漂
 * （文件头还写着 v1.0.0，真源已经 v1.2.0），而漂的过程没有人看见。这两条用例把
 * 「手抄」和「手写死数值」都堵掉：前者由 `--check` 比对生成物，后者由体检脚本扫。
 */
const ROOT = process.cwd();

function run(script: string, ...args: string[]): string {
  return execFileSync(process.execPath, [join('scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

describe('silas-UX 设计规范', () => {
  it('样式表零违规：颜色只从变量取 / 字号只从七档取 / 间距只用 4 的倍数 / 圆角四档 / 动效三档', () => {
    const violations = JSON.parse(run('check-design-tokens.mjs', '--json')) as unknown[];
    expect(violations).toEqual([]);
  });

  it('app/tokens.css 是 vendor 真源生成的产物，没有被手改', () => {
    // --check 不一致时以非 0 退出；execFileSync 于是抛，用例失败并带上原因。
    expect(() => run('sync-tokens.mjs', '--check')).not.toThrow();
  });
});
