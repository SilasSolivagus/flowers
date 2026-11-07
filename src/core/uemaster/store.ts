import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';
import {
  ARTIFACT_DIR_NAME, LEGACY_DATA_DIR, ensureDataRoot, moveInto, moveOnto, pruneEmptyDir,
} from '../runtime-dir.js';
import { isStage, type Stage } from './packs.js';

/**
 * 产物的**磁盘**位置与站内**名字**之间的唯一一套翻译。
 *
 * P2.5 之前产物落在 `public/uemaster/`：那是 Next 的静态根，一个 agent 写出来的
 * `<script>` 会带着**本站的 origin 与 cookie** 在那个地址上执行——同一份文件既被
 * 当成「下载物」，又被当成「本站代码」。把根挪到 `data/uemaster/`（不在静态树里、
 * git 忽略）之后，站内这个名字 `/uemaster/...` 由一个动态路由负责，那个路由会给
 * 每份文件加上 `Content-Security-Policy: sandbox`（见 `app/uemaster/[...path]/route.ts`）：
 * 文档被放进一个不透明源，仍能渲染，但读不到本站的 cookie、storage 与接口。
 *
 * ── 根为什么在**仓库外**（2026-11-08）
 *
 * 以前根是 `<仓库>/data/uemaster`：`data/` 被 git 忽略，一次 `git clean -fdx` 就把它
 * 连会话密钥一起删掉——库里 `uemaster_artifacts` 的行全在，抽屉里那条 `/uemaster/...`
 * 的链接点开是 404「产物不存在」，而 `git status` 干净、没人当场发现。
 * 产物不可重建（那是别人生成并评审过的材料），所以它的家必须在任何 git 清理都走不到的
 * 地方：默认 `~/Library/Application Support/flowers/uemaster`（Linux 是
 * `$XDG_DATA_HOME/flowers/uemaster`），`FLOWERS_DATA_DIR` 可覆盖。
 *
 * 位置只由 `src/core/runtime-dir.ts` 决定，本文件不再自己拼路径——第二份路径逻辑
 * 的下场是「迁一半」：密钥搬走了、产物还在仓库里，同一次 `git clean -fdx` 仍然删得掉。
 *
 * 为什么仍不认 `process.cwd()`（沿用 P2 的口径）：第二个调用方是 MCP server，它被
 * **别人的客户端**起在任意目录里；按 cwd 找根就等于「从 /tmp 启动就永远报产物文件
 * 不存在」，而文件明明在。
 *
 * 仓库内 `data/uemaster` 仍然存在，但它是一条**指向这里的软链**（`runtime-dir` 建）：
 * 任务包对外部 CLI 说的仍是「写到本项目根目录下的 data/uemaster/…」，字节落在仓库外。
 */
const RUNTIME = ensureDataRoot();

/** 站内路径的固定前缀：产物只能落在这个名字下（路由也挂在这里）。 */
export const ARTIFACT_PREFIX = '/uemaster/';

/** 产物的磁盘根（仓库外）。 */
export const ARTIFACT_ROOT = RUNTIME.artifactRoot;

/** 手工交回的文件大小上限。 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * 站内路径的两种合法形状里，站内那一种的判定文案。
 *
 * 与 `attach.ts` 共用同一句：同一个错误从哪一层出去，用户读到的都是同一句话。
 * 收紧了「站内路径」的口径——`/uemaster/` 之前的前缀不再接受，因为静态根已经
 * 搬走，`/foo/bar.html` 这种名字在这个系统里不再指向任何可服务的文件。
 */
export const BAD_URL = `产物链接必须是以 http:// 或 https:// 开头的完整链接，或以 ${ARTIFACT_PREFIX} 开头的站内路径`;

/**
 * 站内路径 → 磁盘路径，**并且**保证结果落在 `data/uemaster` 里。
 *
 * 两条守卫缺一不可：
 * 1. 形状：必须是 `/uemaster/...`。别的站内名字没有路由，交回来只会是条 404 链接。
 * 2. 围栏：`path.resolve` 会把 `..` 折掉，折完再回头确认仍在根里——否则
 *    `/uemaster/../../.env` 能读到仓库里任意文件，而这条路径是**调用方给的**。
 *
 * 这里的越界抛 `invalid_url`（而不是 404）：调用方给了一个不该给的名字，这是
 * 一次非法输入，不是「文件恰好不在」。
 */
export function artifactFile(url: string): string {
  if (!url.startsWith(ARTIFACT_PREFIX)) throw new AppError('invalid_url', BAD_URL);
  const abs = path.resolve(ARTIFACT_ROOT, `.${url.slice('/uemaster'.length)}`);
  const rel = path.relative(ARTIFACT_ROOT, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AppError('invalid_url', BAD_URL);
  }
  return abs;
}

/**
 * 磁盘路径 → 站内路径（`saveUploaded` 的返回，也是落库的那一列）。
 *
 * 反向也过一遍围栏：写文件的地方用的是自己拼的名字，但「拼对了」不该靠记忆，
 * 该靠这一段和 `artifactFile` 互相钉住。
 */
export function artifactUrl(file: string): string {
  const rel = path.relative(ARTIFACT_ROOT, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AppError('invalid_url', BAD_URL);
  }
  return `${ARTIFACT_PREFIX}${rel.split(path.sep).join('/')}`;
}

/**
 * 收下一份**写错地方**的产物：外部生成器按任务包里的相对路径写到了仓库内
 * `data/uemaster/...`，而真正的产物根在仓库外——搬过来。
 *
 * 为什么需要它：任务包（`packs.ts`）对外部 CLI 说的仍是「写到本项目根目录下的
 * `data/uemaster/<PAN-n>/<stage>.html`」。这句话不能改成仓库外的绝对路径——agent CLI
 * 的写权限经常被限制在 cwd 之内，指一个家目录外的路径只会得到「拒绝了这次写入」。
 * 而产物根又必须离开仓库（2026-11-08：`git clean -fdx` 把它连会话密钥一起删了）。
 * 两件事同时成立，就只能由这一层负责最后一段搬运：包怎么说就怎么写，落点归我们收拾。
 *
 * 调用点两处，缺一不可：
 * - `attachArtifact`（本文件的调用方 `attach.ts`）：agent / 脚本交回链接时；
 * - `start.ts` 的 `runJob`：它要在搬运之后 stat 一遍 mtime，否则「文件到底是不是这次
 *   写的」会判错（旧文件没搬、新文件搬了）。
 *
 * 搬运用 `runtime-dir` 的 `moveInto`（临时名 + fsync + rename）：产物也是不可重建的，
 * 搬一半崩掉同样会让库里那条链接变 404。目标已存在时**不搬**（目标赢：新版本不该被
 * 仓库里的残留覆盖），返回 `null`。
 */
export function adoptLegacyArtifact(url: string): string | null {
  const file = artifactFile(url);
  const rel = path.relative(ARTIFACT_ROOT, file);
  const legacyRoot = path.join(LEGACY_DATA_DIR, ARTIFACT_DIR_NAME);
  const legacy = path.resolve(legacyRoot, rel);
  const fenced = path.relative(legacyRoot, legacy);
  if (fenced.startsWith('..') || path.isAbsolute(fenced)) return null;
  if (!existsSync(legacy)) return null;

  /** 搬完把仓库里那串空目录收掉：留着它们，下一次 `git clean -fdx` 的受害者名单会重新
   *  长出 `data/uemaster/PAN-n/`，也让人误以为「产物还在仓库里」。 */
  const prune = (): void => {
    pruneEmptyDir(path.dirname(legacy));
    pruneEmptyDir(legacyRoot);
    pruneEmptyDir(LEGACY_DATA_DIR);
  };

  if (existsSync(file)) {
    /**
     * 目标已有：**谁新听谁的**。
     *
     * 两种现实情况都会走到这里：
     * 1. 上一次搬到一半崩了（两边同名、内容相同）→ 删掉仓库里那份；
     * 2. 重做一次，agent 又写了一份新的到仓库里 → 它更新，覆盖仓库外那版。
     * 「只留目标、直接忽略仓库里那份」会让第 2 种静默变成「重做无效」；而反过来
     * 无条件「目标赢」会把仓库里的残留留到下一轮，被当成一次新产物认领——那是最坏
     * 的一种假成功（失败的生成看起来成功了）。
     */
    const newer = statSync(legacy).mtimeMs > statSync(file).mtimeMs;
    if (newer) {
      mkdirSync(path.dirname(file), { recursive: true });
      moveOnto(legacy, file);
      prune();
      return file;
    }
    rmSync(legacy, { force: true });
    prune();
    return null;
  }

  mkdirSync(path.dirname(file), { recursive: true });
  moveInto(legacy, file);
  prune();
  return file;
}

/** 手工交回的一份文件：只取落盘需要的三样，不把 Web 的 `File` 拖进领域层。 */
export type Upload = {
  /** 浏览器给的原文件名。只用它判扩展名，不拿它拼路径。 */
  name: string;
  size: number;
  bytes: Uint8Array;
};

/**
 * 交回文件的落地名字：`<stage>-<timestamp>.html`。
 *
 * 为什么不用原文件名：原文件名是**调用方给的**，`../../x.html`、`a b.html`、两个
 * 同名文件互相覆盖，三件事都从它来。名字只由 stage 与时间戳拼，路径就永远只由
 * 我们自己决定；原文件名退化成「只用来判扩展名」的一列。
 *
 * 时间戳取毫秒：同一 stage 重交一次就是一份新版本（与 MCP 那条路同一条规矩，
 * 旧文件不被覆盖）。`now` 可传入是为了用例能钉死输出。
 */
export function uploadFileName(stage: Stage, now: Date): string {
  return `${stage}-${now.getTime()}.html`;
}

/** `PAN-7` 这个目录名：编号必须是正整数，别的形状不拼进路径。 */
function panDir(number: unknown): string {
  const n = typeof number === 'number' ? number : Number.parseInt(String(number ?? ''), 10);
  if (!Number.isInteger(n) || n <= 0) throw new AppError('invalid', '需求编号不合法');
  return `PAN-${n}`;
}

/**
 * 校验一份手工交回的文件，写到 `data/uemaster/<PAN-n>/<stage>-<ts>.html`，返回站内路径。
 *
 * 校验只有两条（扩展名与大小），因为**内容不该在收的时候就判**：产物是一份 HTML，
 * 它能做什么由服务它的那份 CSP 决定（路由那一层），而不是由收件箱里的一个正则决定。
 * 「看起来像 HTML」这种检查会挡掉合法产物、又挡不住恶意产物——两头都不讨好。
 *
 * 只认 `.html` / `.htm`：`accept` 属性只是浏览器侧的提示，可以被绕过，所以真正的
 * 那道门在这里。大小上限同理：5 MB 是「一份自足的 HTML」的天花板，超了就是别的
 * 东西（打包物、视频），它也不该由这条路径进来。
 */
export async function saveUploaded(
  number: unknown,
  stage: unknown,
  upload: Upload,
  now: Date = new Date(),
): Promise<string> {
  if (!isStage(stage)) throw new AppError('invalid_stage', '阶段只能是 evaluate、review、inspect 之一');
  if (!/\.html?$/i.test(upload.name)) throw new AppError('invalid_upload', '只收 .html 文件');
  if (upload.size <= 0) throw new AppError('invalid_upload', '文件是空的');
  if (upload.size > MAX_UPLOAD_BYTES) throw new AppError('invalid_upload', '文件不能超过 5 MB');

  const file = path.join(ARTIFACT_ROOT, panDir(number), uploadFileName(stage, now));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, upload.bytes);
  return artifactUrl(file);
}
