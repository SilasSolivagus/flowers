#!/usr/bin/env node
/**
 * flowers-ops CLI（2026-11-11）。
 *
 * 一个文件、零依赖：只做「拼 URL、带 token、打印 JSON」。规则不在这里——不能做什么、
 * 为什么不能，看 MCP 工具描述或 `/api/v1/meta`；这里只负责把请求发出去、把服务端的
 * 中文原文照原样打出来（改了就等于替服务端编理由）。
 *
 * 用法：
 *   FLOWERS_API=https://flower.dirctable.com FLOWERS_TOKEN=flw_… \
 *     node flowers.mjs list --state=queue --q=直链 --limit=20
 *
 * 命令：board / list / get / create / update / claim / assign / action / attach / plan
 *       / prd / members / releases / skills / meta
 */
import { readFileSync } from 'node:fs';

const API = (process.env.FLOWERS_API ?? '').replace(/\/+$/, '');
const TOKEN = process.env.FLOWERS_TOKEN ?? '';

function die(message) {
  console.error(message);
  process.exit(1);
}

if (API === '') die('请先设置 FLOWERS_API（例如 https://flower.dirctable.com）');

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg.startsWith('--')) {
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) flags[key] = inline;
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) { flags[key] = rest[i + 1]; i += 1; }
    else flags[key] = true;
  } else positional.push(arg);
}

function body() {
  if (typeof flags.json === 'string') {
    if (flags.json.trim().startsWith('{')) return JSON.parse(flags.json);
    return JSON.parse(readFileSync(flags.json, 'utf8'));
  }
  return {};
}

async function call(method, path, payload, { auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) {
    if (TOKEN === '') die('请先设置 FLOWERS_TOKEN（设置页生成，flw_ 开头）');
    headers.authorization = `Bearer ${TOKEN}`;
  }
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  console.log(JSON.stringify(parsed, null, 2));
  // 写操作不自动重试：状态动作不是幂等的。退出码留给脚本判断。
  if (!res.ok) process.exit(res.status === 401 || res.status === 403 ? 2 : 1);
}

const q = new URLSearchParams();
for (const key of ['state', 'owner', 'q', 'number', 'offset', 'limit', 'mine']) {
  if (flags[key] !== undefined) q.set(key, String(flags[key]));
}
const query = q.toString() === '' ? '' : `?${q}`;
const id = positional[0];

switch (command) {
  case 'meta': await call('GET', '/api/v1/meta', null, { auth: false }); break;
  case 'skills': await call('GET', '/api/v1/skills/flowers-ops', null, { auth: false }); break;
  case 'board': await call('GET', '/api/v1/board'); break;
  case 'list': await call('GET', `/api/v1/requirements${query}`); break;
  case 'get': if (!id) die('用法：get <编号或UUID>'); await call('GET', `/api/v1/requirements/${id}`); break;
  case 'create': await call('POST', '/api/v1/requirements', body()); break;
  case 'update': if (!id) die('用法：update <UUID> --json patch.json'); await call('PATCH', `/api/v1/requirements/${id}`, body()); break;
  case 'claim': if (!id) die('用法：claim <UUID>'); await call('POST', `/api/v1/requirements/${id}/claim`, {}); break;
  case 'assign': if (!id || !flags.member) die('用法：assign <UUID> --member <成员UUID>'); await call('POST', `/api/v1/requirements/${id}/assign`, { ownerMemberId: flags.member }); break;
  case 'action': {
    if (!id || !positional[1]) die('用法：action <UUID> <动作> [--json …]');
    await call('POST', `/api/v1/requirements/${id}/actions/${positional[1]}`, body());
    break;
  }
  case 'attach': {
    if (!id || !positional[1] || !flags.url) die('用法：attach <UUID> <evaluate|review|inspect> --url <链接或站内路径>');
    await call('POST', `/api/v1/requirements/${id}/artifacts`, { stage: positional[1], url: flags.url });
    break;
  }
  case 'upload': {
    if (!id || !positional[1] || !flags.file) die('用法：upload <UUID> <evaluate|review|inspect> --file ./x.html');
    if (TOKEN === '') die('请先设置 FLOWERS_TOKEN');
    const bytes = readFileSync(flags.file);
    const form = new FormData();
    form.set('stage', positional[1]);
    form.set('file', new Blob([bytes], { type: 'text/html' }), flags.file.split('/').pop());
    const res = await fetch(`${API}/api/v1/requirements/${id}/artifacts/upload`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: form,
    });
    console.log(JSON.stringify(await res.json(), null, 2));
    if (!res.ok) process.exit(1);
    break;
  }
  case 'plan': {
    if (!id || !positional[1]) die('用法：plan <UUID> <evaluate|review|inspect>');
    await call('POST', `/api/v1/requirements/${id}/plan`, { stage: positional[1] });
    break;
  }
  case 'prd': if (!id) die('用法：prd <UUID>'); await call('GET', `/api/v1/requirements/${id}/prd`); break;
  case 'members': await call('GET', '/api/v1/members'); break;
  case 'releases': await call('GET', '/api/v1/releases'); break;
  default:
    die('命令：meta / skills / board / list / get / create / update / claim / assign / action / attach / plan / prd / members / releases');
}
