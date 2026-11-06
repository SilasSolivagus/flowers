import type { Db } from '../src/db/client';
import { AppError } from '../src/core/errors';
import { attachArtifact } from '../src/core/uemaster/attach';
import { saveUploaded } from '../src/core/uemaster/store';

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
  const target = file === null
    ? field(formData, 'url')
    : await saveUploaded(field(formData, 'number'), field(formData, 'stage'), {
      name: file.name,
      size: file.size,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });

  // 两条都空：这是用户的手误，不是领域错误，给它一句自己的话。
  if (target === '') throw new AppError('invalid', '请粘贴链接或选择文件');

  await attachArtifact(db, actor, {
    requirementId: field(formData, 'id'),
    stage: field(formData, 'stage'),
    url: target,
  });
  return { url: target };
}
