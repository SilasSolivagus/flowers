/**
 * stdout 模式的 stub：**不写任何文件**，只把 HTML 打到 stdout。
 *
 * 它代表 `ollama run <模型名>` 这一类纯管道生成器——它们不会用写文件工具落盘，
 * 交东西的方式就是 stdout。生成器那一层要能从一段带着人话前缀的输出里认出文档，
 * 自己写进产物路径；认不出来，ollama 这条路就永远走不通。
 *
 * 故意先打两句人话（agent CLI 都会这么干），证明取出的是「包含」而不是「以…开头」。
 */
let input = '';
for await (const chunk of process.stdin) input += chunk;

process.stdout.write('好的，我来生成这个页面。\n\n');
process.stdout.write('<!doctype html>\n<meta charset="utf-8">\n<title>stub stdout</title>\n<p>hello</p>\n');
