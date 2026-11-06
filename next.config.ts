import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next 15 起这是顶层键；等价的老写法 experimental.serverComponentsExternalPackages 已废弃（见 16.4.5 的
  // node_modules/next/dist/server/config-shared.d.ts:1154 的 @deprecated 标注）。pg 是原生驱动，
  // 不外置会被打进 server bundle 并在 build 时报 require/loader 错误。
  serverExternalPackages: ['pg'],
  // 本地验证用 127.0.0.1 打开时不至于被 dev 资源跨源策略挡掉 HMR。
  allowedDevOrigins: ['127.0.0.1'],
  // 关掉 dev 指示浮标（左下角的黑色「N」圆标）。它固定在视口左下角，
  // 与左轨底部的身份块（吕品 / PM）完全重叠，dev 下那块内容读不出来、
  // 每张截图都带着一个圆标。16.4.5 的 next/dist/server/config-shared.d.ts:1532
  // 把它声明成 `false | { position?: 'top-left' | ... }`——布尔就是「整个关掉」，
  // 不是删掉一项配置；这里要的是关掉，不是挪位置。
  devIndicators: false,
  experimental: {
    // 抽屉的「交回材料」走 server action，表单里带一个文件。Next 默认的
    // bodySizeLimit 是 1 MB，我们自己的上限是 5 MB（`store.ts`）——不抬这一格，
    // 2 MB 的产物会在**到达**领域层之前就被 Next 拒掉，界面于是拿不到那句
    // 「文件不能超过 5 MB」的判定，而是撞一个通用错误。多留 1 MB 余量给
    // multipart 边界与其它字段，让「谁说了算」始终是领域层。
    serverActions: { bodySizeLimit: '6mb' },
    // 领域层（src/core）用的是 NodeNext 风格的相对导入：`import ... from './errors.js'`。
    // 这是 Node 直接跑 .ts（tsx / vitest）时唯一正确的写法，也是 P1 全仓的统一风格。
    // Turbopack 不做 extensionAlias（Next 16 把它列在「Turbopack 不支持」里），
    // 于是 server component 一 import 领域层就 500：Can't resolve './errors.js'。
    // 这里补上 webpack 的别名，dev/build 都用 --webpack 跑（见 package.json）。
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
};

export default nextConfig;
