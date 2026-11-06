/**
 * 成功的生成器 stub：读 stdin 的任务包，按包里的路径写一份已知 HTML，退出 0。
 *
 * 它存在的理由（与 gen-fail / gen-hang / gen-silent 一起）：本机两个 agent CLI 的
 * 登录都过期了，真跑一次只会拿到 `Failed to authenticate`。要证明的是**管线**——
 * 作业 running → done、产物落盘、attach、页面变成链接——而管线与「谁来写这份 HTML」
 * 无关。这个 stub 就是那个「谁来」的替身：它认的输入与真 CLI 完全一样（stdin 上的
 * 完整任务包），写的路径也是包自己指定的那一条。
 */
let input = '';
for await (const chunk of process.stdin) input += chunk;

const file = /data\/uemaster\/PAN-\d+\/(?:evaluate|review|inspect)\.html/.exec(input)?.[0];
if (!file) {
  process.stderr.write('stub: 任务包里没有产物路径\n');
  process.exit(2);
}

const { mkdir, writeFile } = await import('node:fs/promises');
const path = await import('node:path');
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, [
  '<!doctype html>',
  '<meta charset="utf-8">',
  '<title>stub 产物</title>',
  '<p data-stub="ok">这是测试 stub 写出来的材料，不是模型生成的。</p>',
].join('\n'), 'utf8');

process.stdout.write(`stub wrote ${file}\n`);
