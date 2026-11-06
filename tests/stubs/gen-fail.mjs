/**
 * 失败的生成器 stub：原样复述真 CLI 今天的那句认证错误，退出 1。
 *
 * 这句英文是要点：界面上应当出现「生成失败：Failed to authenticate: OAuth session
 * expired and could not be refreshed」——用户一眼知道该去登录，而不是一句「生成失败」。
 */
let input = '';
for await (const chunk of process.stdin) input += chunk;

process.stderr.write('Failed to authenticate: OAuth session expired and could not be refreshed\n');
process.exit(1);
