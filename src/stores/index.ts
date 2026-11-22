/**
 * 状态层（stores）—— 所有 zustand store 的物理归位处。
 *
 * 分层约定：
 *   ports/     纯接口（零依赖）
 *   services/  领域逻辑（算法、编排、协议）
 *   stores/    应用状态（zustand，UI 状态与跨模块共享态）
 *   adapters/  平台实现（web / iOS）
 *   app/       组装根（注入适配器）
 *
 * services/ 下原路径保留一行 re-export 兼容垫片，旧 import 不会断；
 * 新代码请直接从这里或 stores/ 下具体模块导入。
 */
export * from './settings.js'
export * from './presets.js'
export * from './models.js'
export * from './modelMeta.js'
export * from './modelCatalog.js'
export * from './modelPrefs.js'
export * from './attachments.js'
export * from './providers.js'
export * from './memory.js'
export * from './readAloud.js'
export * from './drafts.js'
export * from './chatState.js'
export * from './usageStats.js'
