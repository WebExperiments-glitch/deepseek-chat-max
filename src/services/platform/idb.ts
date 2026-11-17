/**
 * IndexedDB 的平台层。
 *
 * 目前直接转出 idb 的能力；移植到没有 IndexedDB 的运行时（iOS 原生容器）时，
 * 在这里换成 SQLite / 文件实现并保持同样的 openDB 契约即可，
 * 会话库与记忆库都不用改。
 */
export { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
