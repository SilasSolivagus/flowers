import { describe, expect, it } from 'vitest';

import {
  CODE_EXT, classifyKind, extractIndex, isIndexable, outlineOf, parseBlob,
  type CodeIndex,
} from '../src/core/codemirror/code-index.js';

/**
 * Go 解析器（2026-11-08）：`func` / 方法 / `struct` / `interface` 进 outline，`.go` 可索引。
 *
 * 为什么要有这一层：索引只认 `[ts|tsx|js|jsx|mjs|cjs|vue]` 与 `pages.json` 时，79 个
 * Go 仓是**看不见的**——`123pan-gateway` 接进来、同步绿了、覆盖率 `0/49`。而 35 条活需求
 * 挂着 `backend` 平台（`apisrv` 是它们的主 API 服务器），材料对它们一个字都说不出来。
 *
 * 这一组用例钉三件事，每一件都对应报告里的一条裁决：
 * 1. **抽什么**：四类声明 + 行号；`init()` 与 `_test.go` 不进（测试不是产品）。
 * 2. **不抽什么**：注释/字符串里的假声明、接口里的方法行（正则盲区，锁住它而不是假装没有）。
 * 3. **图不编**：Go 的 `imports` 恒为空——包级导入落不到文件上，错的边比缺的边糟。
 */

/** 纯函数装配入口（与 `code-index-outline.test.ts` 同一个写法：不碰 git、不碰库）。 */
function indexOf(files: Record<string, string>): CodeIndex {
  const paths = Object.keys(files);
  return extractIndex({
    repo: 'fixture-go',
    sha: '0123456789abcdef',
    all: paths,
    sources: paths.map((path) => ({ path, size: files[path]?.length ?? 0, text: files[path] ?? '' })),
  });
}

/** 一段真形状的 Go：包声明、分组 import、四类声明各一条。 */
const HANDLER = [
  'package service',                              // 1
  '',                                             // 2
  'import (',                                     // 3
  '\t"context"',                                  // 4
  '',                                             // 5
  '\t"codeup.aliyun.com/60f9058e68e2993a8e6d0750/123pan/apisrv/library/logjson"', // 6
  ')',                                            // 7
  '',                                             // 8
  '// FolderService 文件夹业务。',                // 9
  'type FolderService struct {',                  // 10
  '\trepo *FolderRepository',                     // 11
  '}',                                            // 12
  '',                                             // 13
  'type FolderPager interface {',                 // 14
  '\tPageSize() int',                             // 15
  '}',                                            // 16
  '',                                             // 17
  'func init() {',                                // 18
  '\tlogjson.Init()',                             // 19
  '}',                                            // 20
  '',                                             // 21
  'func NewFolderService(repo *FolderRepository) *FolderService {', // 22
  '\treturn &FolderService{repo: repo}',          // 23
  '}',                                            // 24
  '',                                             // 25
  'func (s *FolderService) CreateFolder(ctx context.Context, name string) error {', // 26
  '\treturn s.repo.Insert(ctx, name)',            // 27
  '}',                                            // 28
  '',                                             // 29
  'func (FolderService) Name() string { return "folder" }', // 30
].join('\n');

describe('outlineOf 的 Go 分支：四类顶层声明', () => {
  it('struct / interface / 函数 / 方法 都抽出来，行号是全文行号', () => {
    expect(outlineOf('service/folder.go', HANDLER)).toEqual([
      { kind: 'go-struct', name: 'FolderService', line: 10 },
      { kind: 'go-iface', name: 'FolderPager', line: 14 },
      { kind: 'go-func', name: 'NewFolderService', line: 22 },
      { kind: 'go-method', name: 'FolderService.CreateFolder', line: 26 },
      { kind: 'go-method', name: 'FolderService.Name', line: 30 },
    ]);
  });

  it('`func init()` 不进 outline（包的初始化钩子不是「这个仓提供的能力」）', () => {
    const names = outlineOf('service/folder.go', HANDLER).map((node) => node.name);
    expect(names).not.toContain('init');
  });

  it('方法名带 receiver（`Handler` / `List` 这类名字在十几个 receiver 上重复）', () => {
    const go = [
      'package app',
      'func (h *Handler) List() {}',
      'func (r *Repo) List() {}',
      'func (Server) List() {}',
    ].join('\n');
    expect(outlineOf('app/x.go', go).map((node) => node.name))
      .toEqual(['Handler.List', 'Repo.List', 'Server.List']);
  });

  it('指针 / 值 / 泛型 receiver 三种写法都认', () => {
    const go = [
      'package app',
      'func (s *Store[T]) Get() T { var zero T; return zero }',
      'func (s Store[T]) Len() int { return 0 }',
    ].join('\n');
    expect(outlineOf('app/store.go', go).map((node) => [node.kind, node.name])).toEqual([
      ['go-method', 'Store.Get'],
      ['go-method', 'Store.Len'],
    ]);
  });

  it('泛型函数的类型参数不影响抽出名字', () => {
    const go = 'package app\nfunc Map[T any](xs []T) []T { return xs }';
    expect(outlineOf('app/map.go', go)).toEqual([{ kind: 'go-func', name: 'Map', line: 2 }]);
  });

  it('`type ( … )` 分组类型块里的条目也算（gofmt 一个 tab 缩进）', () => {
    const go = [
      'package app',
      'type (',
      '\tUser struct {',
      '\t\tID int64',
      '\t}',
      '\tStore interface {',
      '\t\tGet(id int64) error',
      '\t}',
      ')',
    ].join('\n');
    expect(outlineOf('app/types.go', go).map((node) => [node.kind, node.name])).toEqual([
      ['go-struct', 'User'],
      ['go-iface', 'Store'],
    ]);
  });
});

describe('outlineOf 的 Go 分支：注释与字符串里的假声明不算', () => {
  /**
   * 真仓里最常见的假声明是**注释掉的旧接口**与 SQL/JSON 字符串。不抹的话材料会说
   * 「已经有 CreateFolder 了」，而那一行早就被注释掉了。
   */
  it('注释掉的 func / type 不算', () => {
    const go = [
      'package app',
      '// func LegacyCreate(ctx context.Context) error {',
      '/* type OldPager struct {',
      '\tSize int',
      '} */',
      'func Real() {}',
    ].join('\n');
    expect(outlineOf('app/x.go', go).map((node) => node.name)).toEqual(['Real']);
  });

  it('字符串里的 func / type 不算（引号与反引号都算字符串）', () => {
    const go = [
      'package app',
      'const sqlText = "type Fake struct {"',
      'const hint = `func NotAFunc() {}`',
      'func Real() {}',
    ].join('\n');
    expect(outlineOf('app/x.go', go).map((node) => node.name)).toEqual(['Real']);
  });

  /**
   * Go 的反引号是**原始字符串**，`\` 不是转义。若沿用 JS 口径（`\` 吃掉下一个字符），
   * `\\` 后面那个反引号会被当成被转义的字符，字符串一直抹到下一个反引号——中间的真声明
   * 全部消失，或者引号错位之后编出假声明。
   */
  it('反引号原始字符串里以反斜杠结尾不会把后面的代码一起抹掉', () => {
    const go = [
      'package app',
      'const winPath = `C:\\`',
      'func AfterRawString() {}',
    ].join('\n');
    expect(outlineOf('app/x.go', go)).toEqual([{ kind: 'go-func', name: 'AfterRawString', line: 3 }]);
  });

  /**
   * 盲区，锁住它而不是假装没有：接口里的方法行没有 `func` 关键字，一个都抽不到。
   * 只有接口名进 outline。要修就得进 AST（`go/parser`），而这一层的取舍是「不引新依赖」。
   */
  it('盲区：interface 里的方法行不进 outline（只有接口名）', () => {
    const go = [
      'package app',
      'type Pager interface {',
      '\tPage() int',
      '\tSetPage(n int)',
      '}',
    ].join('\n');
    expect(outlineOf('app/pager.go', go)).toEqual([{ kind: 'go-iface', name: 'Pager', line: 2 }]);
  });
});

describe('.go 进索引：类别、扩展名、测试文件', () => {
  it('`.go` 在 CODE_EXT 里', () => {
    expect(CODE_EXT.test('service/folder.go')).toBe(true);
  });

  /**
   * `.go` 一律 `service`：`FileKind` 是**前端角色**的轴（页面/组件/服务/状态），而 Go 仓
   * 没有「一屏」也没有「可复用组件」——`component/` 在 `apisrv` 里是一个库包。
   * 沿用目录约定会把它判成 `component`（定位排序会当前端组件抬高），而 `app/`、
   * `library/`、`constvar/` 会落 `other`（整个仓又变 0/49）。两种错法都不如一个诚实的桶。
   */
  it('`apisrv` 的四种目录都判 service（component/ app/ library/ 仓根）', () => {
    const paths = [
      'main.go', 'component/get.go', 'app/handler/folder.go',
      'library/logjson/log.go', 'constvar/const.go', 'service/folder.go',
    ];
    expect(paths.map((path) => classifyKind(path))).toEqual(paths.map(() => 'service'));
  });

  it('`.go` 可索引，`_test.go` 不可索引（测试不是产品）', () => {
    expect(isIndexable('service/folder.go')).toBe(true);
    expect(isIndexable('service/folder_test.go')).toBe(false);
    expect(isIndexable('service/testdata/x.go')).toBe(true);
  });

  it('`_test.go` 直接喂给 outlineOf 也给空（公开函数，别的调用方可能绕过 isIndexable）', () => {
    expect(outlineOf('service/folder_test.go', HANDLER)).toEqual([]);
  });

  it('测试文件即使被塞进 sources 也不进 files（装配层同一个判据）', () => {
    const index = indexOf({
      'service/folder.go': HANDLER,
      'service/folder_test.go': 'package service\nfunc TestCreate(t *testing.T) {}\n',
    });
    expect(Object.keys(index.files)).toEqual(['service/folder.go']);
  });
});

describe('Go 的 imports 恒为空（包级导入落不到文件上）', () => {
  /**
   * `imports` 这张图的单位是**文件**，Go 的单位是**包（目录）**。`apisrv` 的 import 写的是
   * 完整模块路径（`…/123pan/apisrv/app/grpcserver`），要落地先要去掉模块前缀——而模块根
   * 不一定是仓根、前缀还随 `go.mod` 变；落地之后拿到的仍是一个目录，目录里有 N 个文件。
   * 挑一个写进图就是编一条边，而 `importedBy` 会照着它给「改它波及几个页面」下结论。
   * 这个仓被一个「猜」出来的 matcher 坑过，所以宁可空着。
   */
  it('`import ( … )` 与 `import "…"` 都不产生导入边', () => {
    const index = indexOf({
      'main.go': [
        'package main',
        'import (',
        '\t"codeup.aliyun.com/60f9058e68e2993a8e6d0750/123pan/apisrv/service"',
        ')',
        'func main() { service.New() }',
      ].join('\n'),
      'service/folder.go': 'package service\nfunc New() {}\n',
    });
    expect(index.imports['main.go']).toEqual([]);
    // 反向图同样没有边：它不是「没算」，是「本来就不该有」。
    expect(index.importedBy['service/folder.go']).toBeUndefined();
  });

  /**
   * 上一条只钉住**结果**（没边），钉不住**原因**：模块路径本来就落不到文件上。这条钉原因——
   * 喂一个**恰好就是仓内路径**的说明符（`service/folder.go`）。若哪天门开了一条缝
   * （比如有人把 `.go` 加进 `RESOLVE_EXT`，或者去掉 `parseBlob` 里那个 `lang === 'go'`
   * 的判断），`imports` 会立刻多出一条 `main.go → service/folder.go` 的边。
   */
  it('连「恰好是仓内路径」的说明符也不落地（Go 的图是故意空着的，不是碰巧空的）', () => {
    const index = indexOf({
      'main.go': [
        'package main',
        'import (',
        '\t"service/folder.go"',
        ')',
      ].join('\n'),
      'service/folder.go': 'package service\nfunc New() {}\n',
    });
    expect(index.imports['main.go']).toEqual([]);
  });

  it('但 outline 照旧挂上（Go 文件的定位靠名字 + 符号，不靠一跳图）', () => {
    const index = indexOf({ 'service/folder.go': HANDLER });
    expect(index.outline['service/folder.go']?.map((node) => node.name))
      .toEqual(['FolderService', 'FolderPager', 'NewFolderService', 'FolderService.CreateFolder', 'FolderService.Name']);
    expect(index.files['service/folder.go']?.kind).toBe('service');
  });

  it('`pages` 对 Go 文件恒为空（Go 仓没有 uni-app 页面清单）', () => {
    expect(parseBlob(HANDLER, 'service/folder.go').pages).toEqual([]);
  });
});
