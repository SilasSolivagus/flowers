import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Next 15 起这是顶层键；等价的老写法 experimental.serverComponentsExternalPackages 已废弃（见 16.4.5 的
  // node_modules/next/dist/server/config-shared.d.ts:1154 的 @deprecated 标注）。pg 是原生驱动，
  // 不外置会被打进 server bundle 并在 build 时报 require/loader 错误。
  serverExternalPackages: ['pg'],
  // 本地验证用 127.0.0.1 打开时不至于被 dev 资源跨源策略挡掉 HMR。
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
