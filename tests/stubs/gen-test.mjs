/**
 * 设置页那 10 秒小测的 stub：**文件模式**。
 *
 * 它不是产物生成器（没有 PAN 编号、没有产物路径）：`TEST_PACK` 只要求「生成一个 HTML
 * 文档」。所以它在当前工作目录（小测的临时目录）写一个 `hello.html`，退出 0——
 * 这正是 `claude -p` / `codex exec` 交东西的方式。
 */
for await (const _ of process.stdin) { /* 读空 stdin */ }

const { writeFile } = await import('node:fs/promises');
await writeFile('hello.html', [
  '<!doctype html>',
  '<meta charset="utf-8">',
  '<title>flowers</title>',
  '<p>hello</p>',
].join('\n'), 'utf8');

process.stdout.write('stub: wrote hello.html\n');
