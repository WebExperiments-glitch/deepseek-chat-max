import { defineConfig } from 'vitest/config'

/**
 * 单元测试配置。
 *
 * 只跑 src 下的纯逻辑与解析层测试；需要真实 API Key 的端到端校验仍在 scripts/verify-*.mjs，
 * SQLite 数据层由 scripts/verify-server-db.mjs 用 node:test 覆盖。
 */
export default defineConfig({
  // rspack 在构建时注入这两个常量；单元测试直接跑 TS，需在这里给出同样的值
  define: {
    __API_ORIGIN__: JSON.stringify('https://api.deepseek.com'),
    __DEV_PROXY_PREFIX__: JSON.stringify(''),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    clearMocks: true,
    restoreMocks: true,
  },
})
