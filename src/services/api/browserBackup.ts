/**
 * 浏览器 IndexedDB 的整体备份 / 还原。
 *
 * 给「设置 → 数据管理」的导出 / 导入按钮使用：把全部 store 打包成一个 ZIP，
 * 内容包含版本标记、导出时间、各 store 的 JSON 行，以及单独存放的原件字节
 * （避免 base64 膨胀，思路与 chat/history/exportArchive.ts 一致）。
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { getDatabase, STORES, type StoreName } from './browserBackend.js'

const MANIFEST_PATH = 'manifest.json'
const FORMAT = 'deepseek-chat-max-browser-backup'
const VERSION = 1

type BackupManifest = {
  format: string
  version: number
  exportedAt: string
  /** 每个 store 的行数，便于导入前给用户一个概览 */
  stores: Record<string, number>
}

type AnyRow = Record<string, unknown>

const FILE_STORES = new Set<StoreName>(['files', 'staging_files'])

const blobPath = (store: StoreName, id: string) => `blobs/${store}/${encodeURIComponent(id)}`
const rowsPath = (store: StoreName) => `stores/${store}.json`

const bufferOf = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

const bytesOf = (bytes: Uint8Array | string): Uint8Array =>
  typeof bytes === 'string' ? strToU8(bytes) : bytes

/**
 * 导出全部数据为 ZIP Blob。文件字节作为独立条目写入，JSON 里只留 id 与 MIME。
 */
export const exportAllData = async (): Promise<Blob> => {
  const db = await getDatabase()
  const entries: Record<string, Uint8Array> = {}
  const manifest: BackupManifest = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    stores: {},
  }

  for (const store of STORES) {
    const rows = (await db.getAll(store)) as unknown as AnyRow[]
    manifest.stores[store] = rows.length
    if (!FILE_STORES.has(store)) {
      entries[rowsPath(store)] = strToU8(JSON.stringify(rows))
      continue
    }
    const meta: { id: string; mimeType: string }[] = []
    for (const row of rows) {
      const id = String(row.id ?? '')
      const mimeType = String(row.mimeType ?? 'application/octet-stream')
      meta.push({ id, mimeType })
      const data = row.data
      if (data instanceof Blob) {
        entries[blobPath(store, id)] = new Uint8Array(await data.arrayBuffer())
      } else if (data instanceof Uint8Array) {
        entries[blobPath(store, id)] = data
      }
    }
    entries[rowsPath(store)] = strToU8(JSON.stringify(meta))
  }

  entries[MANIFEST_PATH] = strToU8(JSON.stringify(manifest))
  const zipped = zipSync(entries, { level: 6 })
  return new Blob([bufferOf(zipped)], { type: 'application/zip' })
}

/**
 * 从 ZIP 还原全部数据。先校验格式与版本，再在单个读写事务里清空并写回所有 store；
 * 中途出错事务回滚，不会出现半份数据。旧备份缺少的 store 条目按空表处理。
 */
export const importAllData = async (file: File | ArrayBuffer): Promise<void> => {
  const bytes = file instanceof ArrayBuffer ? new Uint8Array(file) : new Uint8Array(await file.arrayBuffer())
  const entries = unzipSync(bytes)
  const rawManifest = entries[MANIFEST_PATH]
  if (!rawManifest) {
    throw new Error('备份文件缺少 manifest.json，无法识别')
  }
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(strFromU8(bytesOf(rawManifest))) as BackupManifest
  } catch {
    throw new Error('备份文件的 manifest.json 已损坏')
  }
  if (manifest.format !== FORMAT) {
    throw new Error('不是浏览器数据备份 ZIP（请使用本应用导出的备份）')
  }
  if (!Number.isInteger(manifest.version) || manifest.version < 1 || manifest.version > VERSION) {
    throw new Error(`不支持的备份版本：${String(manifest.version)}`)
  }

  const db = await getDatabase()
  const tx = db.transaction([...STORES], 'readwrite')
  for (const store of STORES) {
    // 用宽松视图写回：备份里的行已经过 JSON 往返，运行时结构由导出端保证。
    const target = tx.objectStore(store) as unknown as {
      clear(): void
      put(value: unknown): void
    }
    target.clear()
    const data = entries[rowsPath(store)]
    if (!data) {
      continue
    }
    let rows: AnyRow[]
    try {
      rows = JSON.parse(strFromU8(bytesOf(data))) as AnyRow[]
    } catch {
      throw new Error(`备份中的 ${rowsPath(store)} 已损坏`)
    }
    if (!Array.isArray(rows)) {
      throw new Error(`备份中的 ${rowsPath(store)} 格式不正确`)
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object') {
        continue
      }
      if (!FILE_STORES.has(store)) {
        target.put(row)
        continue
      }
      const id = String(row.id ?? '')
      const mimeType = String(row.mimeType ?? 'application/octet-stream')
      const blobBytes = entries[blobPath(store, id)]
      target.put({
        ...row,
        data: new Blob([bufferOf(blobBytes ? bytesOf(blobBytes) : new Uint8Array())], { type: mimeType }),
      })
    }
  }
  await tx.done
}
