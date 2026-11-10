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

/**
 * 产物路径从包正文里抠出来。2026-11-10 起包里带版本号（`evaluate-v003.html`），
 * 所以版本段是可选的——老包（没有版本号）与存量用例都还这么写。
 */
const file = /data\/uemaster\/PAN-\d+\/(?:evaluate|review|inspect)(?:-v\d+)?\.html/.exec(input)?.[0];
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
  // 把「写的是哪个文件」也写进正文：这样才能证明两次生成落的是**两份不同的文件**，
  // 而不是同一份被覆盖了两次（那正是 2026-11-10 要修的那个 bug）。
  `<p data-stub-file="${file}">${file}</p>`,
].join('\n'), 'utf8');

process.stdout.write(`stub wrote ${file}\n`);
