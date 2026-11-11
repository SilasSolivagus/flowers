import { evaluate } from '../src/core/requirements/evaluate.js';
import { createRequirement } from '../src/core/requirements/create.js';
import { submitReview } from '../src/core/requirements/submit-review.js';
import { reviewPass, reviewReject } from '../src/core/requirements/review.js';
import { schedule } from '../src/core/requirements/schedule.js';
import { reschedule } from '../src/core/requirements/reschedule.js';
import { bounce } from '../src/core/requirements/bounce.js';
import {
  rejectRequirement, restoreRequirement, shelveRequirement,
} from '../src/core/requirements/terminal.js';
import { rollbackRelease } from '../src/core/requirements/rollback.js';
import { claimRequirement } from '../src/core/requirements/claim.js';
import { reassignOwner } from '../src/core/requirements/assign.js';
import { updateRequirement } from '../src/core/requirements/manage.js';
import { attachArtifact } from '../src/core/uemaster/attach.js';
import { listArtifacts } from '../src/core/uemaster/list.js';
import { latestSnapshot } from '../src/core/prd/snapshots.js';
import { readPrd } from '../src/core/prd/read.js';
import { getRequirementDetail } from '../src/core/read/detail.js';
import { getBoard } from '../src/core/read/board.js';
import { listMembers } from '../src/core/read/member.js';
import { listReleases } from '../src/core/read/version.js';

/**
 * 工具**只通过这张表**碰领域服务。别处不许直接 import `src/core/requirements/*`。
 *
 * 为什么要多这一层，而不是像 `mcp/server.ts` 以前那样直接调：
 *
 * 1. **它让「工具映射到哪个服务」可以被钉住。** `mcp/tools.ts` 每个工具都要调用**对的**
 *    那个服务，并把**同一个人**（token 换来的成员）作为 actor 传进去。这件事只有
 *    在调用点上可以断言，而 `import * as mod from '…'; vi.spyOn(mod, 'x')` 对 ESM
 *    命名空间不成立（导出是只读 getter）。一个普通的可变对象可以——用例
 *    `vi.spyOn(SERVICES, 'schedule')` 就断得到「谁调的、actors 是谁」。
 * 2. **它让「没有 token 就不许碰库」这句话可执行。** 401 那条路要证明的不是
 *    「返回了 401」，而是「一个服务都没被调用」——那需要有一个「所有调用都会经过的点」。
 * 3. 它不改任何行为：每个字段就是那个函数本身（`typeof` 直接推导，签名改了这里编译报错）。
 *
 * 这一层**不做校验、不做兜底、不吞异常**：参数校验收在工具自己的 zod schema 里，
 * 业务规则在服务里，异常原样抛给 `runTool` 翻译。
 */
export type Services = {
  createRequirement: typeof createRequirement;
  submitReview: typeof submitReview;
  reviewPass: typeof reviewPass;
  reviewReject: typeof reviewReject;
  schedule: typeof schedule;
  reschedule: typeof reschedule;
  bounce: typeof bounce;
  rejectRequirement: typeof rejectRequirement;
  shelveRequirement: typeof shelveRequirement;
  evaluate: typeof evaluate;
  restoreRequirement: typeof restoreRequirement;
  rollbackRelease: typeof rollbackRelease;
  claimRequirement: typeof claimRequirement;
  reassignOwner: typeof reassignOwner;
  updateRequirement: typeof updateRequirement;
  listMembers: typeof listMembers;
  listReleases: typeof listReleases;
  attachArtifact: typeof attachArtifact;
  getRequirementDetail: typeof getRequirementDetail;
  listArtifacts: typeof listArtifacts;
  latestSnapshot: typeof latestSnapshot;
  readPrd: typeof readPrd;
  getBoard: typeof getBoard;
};

export const SERVICES: Services = {
  createRequirement,
  submitReview,
  reviewPass,
  reviewReject,
  schedule,
  reschedule,
  bounce,
  rejectRequirement,
  shelveRequirement,
  evaluate,
  restoreRequirement,
  rollbackRelease,
  claimRequirement,
  reassignOwner,
  updateRequirement,
  listMembers,
  listReleases,
  attachArtifact,
  getRequirementDetail,
  listArtifacts,
  latestSnapshot,
  readPrd,
  getBoard,
};
