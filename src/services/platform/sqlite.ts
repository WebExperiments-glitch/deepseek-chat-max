import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import { openDB, type DBSchema } from './idb.js'
import { runLegacyMigration } from './legacyMigrate.js'
import { SCHEMA_SQL, SCHEMA_VERSION } from './sqlSchema.js'

/**
 * 浏览器内的 SQLite（sql.js 编译的 WASM 版本）。
 *
 * 为什么不用原生 SQLite / 后端服务：应用是纯静态页面，Windows 浏览器和 iOS Safari 都要能跑，
 * 不能要求用户额外启动一个本地服务。sql.js 只依赖 WASM，兼容性最好。
 *
 * 持久化方式：整个数据库在内存中运行，改动后用 db.export() 导出成字节流，
 * 防抖写入 IndexedDB 的单条快照。SQLite 负责表结构和查询，IndexedDB 只负责存放这个文件。
 * 页面隐藏或关闭时立即刷盘一次，降低最后一次改动丢失的概率。
 */

interface SnapshotDB extends DBSchema {
  database: { key: string; value: Uint8Array }
}

const SNAPSHOT_DB = 'chat-demo-sql'
const SNAPSHOT_STORE = 'database'
const SNAPSHOT_KEY = 'main'
/** 连续写入时的合并窗口；太短会反复导出整库，太长会丢更多数据 */
const SAVE_DELAY = 300

let database: Database | null = null
let opening: Promise<Database> | null = null
let dirty = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saveChain: Promise<void> = Promise.resolve()
let opQueue: Promise<unknown> = Promise.resolve()

const snapshotDb = () =>
  openDB<SnapshotDB>(SNAPSHOT_DB, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
        db.createObjectStore(SNAPSHOT_STORE)
      }
    },
  })

const readSnapshot = async (): Promise<Uint8Array | null> => {
  try {
    return (await (await snapshotDb()).get(SNAPSHOT_STORE, SNAPSHOT_KEY)) ?? null
  } catch {
    return null
  }
}

const writeSnapshot = async (bytes: Uint8Array): Promise<void> => {
  await (await snapshotDb()).put(SNAPSHOT_STORE, bytes, SNAPSHOT_KEY)
}

const flush = async (): Promise<void> => {
  const db = database
  if (!db || !dirty) {
    return
  }
  dirty = false
  try {
    await writeSnapshot(db.export())
  } catch (error) {
    // 写失败保留脏标记，下一次操作或页面隐藏时再试
    dirty = true
    // eslint-disable-next-line no-console
    console.error('[sqlite] snapshot failed', error)
  }
}

const persist = (): Promise<void> => {
  saveChain = saveChain.then(flush).catch(() => {})
  return saveChain
}

const schedulePersist = () => {
  dirty = true
  if (saveTimer !== null) {
    return
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    void persist()
  }, SAVE_DELAY)
}

const open = async (): Promise<Database> => {
  const SQL = await initSqlJs({
    locateFile: () => new URL('sql-wasm.wasm', document.baseURI).href,
  })
  const snapshot = await readSnapshot()
  const db = snapshot ? new SQL.Database(snapshot) : new SQL.Database()
  db.run(SCHEMA_SQL)
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  await runLegacyMigration(db)
  database = db
  dirty = true
  await flush()
  return db
}

const ensure = (): Promise<Database> => {
  if (database) {
    return Promise.resolve(database)
  }
  opening ??= open().catch((error: unknown) => {
    // 打开失败后允许重试，不缓存已拒绝的 Promise
    opening = null
    throw error
  })
  return opening
}

const enqueue = <T>(task: () => Promise<T> | T): Promise<T> => {
  const result = opQueue.then(task)
  opQueue = result.catch(() => undefined)
  return result
}

const runOnDatabase = <T>(
  task: (db: Database) => T,
  mutates: boolean
): Promise<T> =>
  enqueue(async () => {
    const db = await ensure()
    const result = task(db)
    if (mutates) {
      schedulePersist()
    }
    return result
  })

const rows = <T>(db: Database, sql: string, params: SqlValue[]): T[] => {
  const result = db.exec(sql, params)
  if (result.length === 0) {
    return []
  }
  const { columns, values } = result[0]
  return values.map((value) => {
    const row: Record<string, SqlValue> = {}
    columns.forEach((column, index) => {
      row[column] = value[index]
    })
    return row as unknown as T
  })
}

/** 执行写语句，成功后触发一次快照 */
export const sqlRun = (sql: string, params: SqlValue[] = []): Promise<void> =>
  runOnDatabase((db) => {
    db.run(sql, params)
  }, true)

/** 查询多行；行对象按列名取值 */
export const sqlAll = <T>(sql: string, params: SqlValue[] = []): Promise<T[]> =>
  runOnDatabase((db) => rows<T>(db, sql, params), false)

/** 查询单行 */
export const sqlGet = async <T>(
  sql: string,
  params: SqlValue[] = []
): Promise<T | undefined> => (await sqlAll<T>(sql, params))[0]

/**
 * 同步事务；回调里只能用同步的 db.run / db.exec。
 * 需要异步准备的参数（例如把 Blob 转成字节）必须先在事务外完成。
 */
export const sqlTransaction = <T>(task: (db: Database) => T): Promise<T> =>
  enqueue(async () => {
    const db = await ensure()
    db.run('BEGIN')
    try {
      const result = task(db)
      db.run('COMMIT')
      schedulePersist()
      return result
    } catch (error) {
      db.run('ROLLBACK')
      throw error
    }
  })

if (typeof window !== 'undefined') {
  // pagehide 覆盖关闭页面与进入后台；visibilitychange 覆盖移动端切 App
  window.addEventListener('pagehide', () => {
    void persist()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void persist()
    }
  })
}
