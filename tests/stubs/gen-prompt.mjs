/**
 * `{prompt}` 模式的 stub：任务包不在 stdin 上，而在 argv 里。
 *
 * `dsh headless {prompt}` 就是这么收 prompt 的。这个 stub 把 argv[2] 当成任务包，
 * 从里面取产物路径并写文件——用来钉住「有 {prompt} 时不再往 stdin 灌东西」。
 * 它同时检查 stdin 是空的：两种模式不能同时生效。
 */
const pack = process.argv[2] ?? '';
if (pack === '') {
  process.stderr.write('stub: argv 里没有任务包\n');
  process.exit(2);
}

let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
if (pack.includes('{prompt}')) {
  process.stderr.write('stub: {prompt} 没有被替换\n');
  process.exit(2);
}

const file = /data\/uemaster\/PAN-\d+\/(?:evaluate|review|inspect)\.html/.exec(pack)?.[0];
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
  '<title>stub prompt 产物</title>',
  `<p data-stdin="${stdin.length}">任务包从 argv 进来。</p>`,
].join('\n'), 'utf8');

process.stdout.write(`stub wrote ${file}\n`);
