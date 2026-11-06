import { rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../src/db/client';
import { AppError } from '../src/core/errors';
import { attachArtifact } from '../src/core/uemaster/attach';
import { artifactFile, saveUploaded } from '../src/core/uemaster/store';

/**
 * 抽屉「交回材料」那张表单 → 领域入参的**唯一**一段翻译，故意不挂在 `'use server'`
 * 文件里。
 *
 * 为什么分出来：`attachAction` 的最后一步是 `revalidatePath`，而那一步只有在请求
 * 上下文里才有意义（在用例里调它抛的是 Next 的内部 invariant）。把「取字段 → 存文件
 * → attach」放在一个不碰 Next 的普通函数里，`tests/uemaster-upload.test.ts` 就能用
 * 真的 `FormData` + 真的 `File` 把整条路跑一遍——包括 multipart 那一段，而这一段
 * 恰好是浏览器之外最难验的部分。
 *
 * 这里**不做任何校验**：扩展名、5 MB、stage、编号、文件写在哪，全在 `saveUploaded`
 * 与 `attachArtifact` 里（一条写路径、一套中文消息）。这一层只回答一件事：这次提交
 * 交回的是**哪一份**（文件优先，其次链接）。
 *
 * 它也不是纯粹的翻译：先写文件、再 attach，所以本层是唯一知道「哪个文件是这一次写的」
 * 的地方。attach 说不的时候，那份文件由这里收回去（见 `attachFromForm` 里 catch 那段）
 * ——领域层不知道上传这条路的存在，也不该知道。
 */
export type Attached = { url: string };

/**
 * FormData 里的 `file`：只有真的选了文件才算一份文件。
 *
 * 空的 `<input type="file">` 照样提交一项（名字空、大小 0 的 File），所以「有没有
 * 文件」不能只看 null，要看 `size`。用鸭子类型而不是 `instanceof File`：这个对象
 * 来自运行时的 FormData（undici），`File` 是 Node 的全局——两者是不是同一个构造器
 * 取决于 Node 版本，不值得把交回材料这条路押在这上面。
 */
function uploaded(value: FormDataEntryValue | null): File | null {
  if (typeof value !== 'object' || value === null) return null;
  const file = value as File;
  if (typeof file.arrayBuffer !== 'function' || typeof file.name !== 'string') return null;
  return file.size > 0 ? file : null;
}

/** 表单字段：缺失 / 非字符串都归一到空串，交给领域层报它自己的中文错误。 */
function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function attachFromForm(
  db: Db,
  actor: string,
  formData: FormData,
): Promise<Attached> {
  const file = uploaded(formData.get('file'));
  // 两个进法合成一次提交，**文件优先**：一份刚生成的产物比一个手打的老链接新，
  // 而猜错的代价只是再交一次。
  const uploadedPath = file === null
    ? null
    : await saveUploaded(field(formData, 'number'), field(formData, 'stage'), {
      name: file.name,
      size: file.size,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  const target = uploadedPath ?? field(formData, 'url');

  // 两条都空：这是用户的手误，不是领域错误，给它一句自己的话。
  if (target === '') throw new AppError('invalid', '请粘贴链接或选择文件');

  try {
    await attachArtifact(db, actor, {
      requirementId: field(formData, 'id'),
      stage: field(formData, 'stage'),
      url: target,
    });
  } catch (error) {
    /**
     * 落库失败就把刚写的文件收回去（R-P2-9 顺手修的一条）。
     *
     * 顺序本来是「先写文件、再 attach」，而 attach 会在四件事上说不：需求不存在、
     * stage 不合法、站内链接没有文件、评估缺类型。前一种最常见——打错一个编号。
     * 失败之后那份文件没有任何一行指向它：`data/uemaster/` 里躺着永远不会被服务到、
     * 也永远不会被清理的 HTML，目录越攒越像一堆来路不明的材料。
     *
     * 三条边界：
     * - 只回收**这一次**自己写的那个文件（`uploadedPath`，名字由 stage+时间戳拼、
     *   路径由我们自己定）；用户贴进来的链接一律不碰——那可能是别人还要用的文件。
     * - 先 unlink 文件，再试着 rmdir 父目录；目录非空时 rmdir 失败是可预期的，
     *   吞掉它。这样失败的提交在磁盘上留下的东西和对齐前的状态一致。
     * - 回收本身失败（权限、文件被移走）不掩盖原始错误：用户该读到的是
     *   「需求不存在」，不是一句 ENOENT。
     */
    if (uploadedPath !== null) {
      const stale = artifactFile(uploadedPath);
      await unlink(stale).catch(() => undefined);
      await rmdir(path.dirname(stale)).catch(() => undefined);
    }
    throw error;
  }
  return { url: target };
}
