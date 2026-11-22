import * as db from '../db.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import { crc32UsingWasm } from './crc32.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readDirectory,
  readEntry,
  skipEntry,
  type ArchiveEntry,
  type ZipDirectory,
} from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/** 批量阈值：会话按条数，图片按条数 + 累计字节，控制单请求体积与 HTTP 次数。 */
const SESSION_BATCH_SIZE = 16
const FILE_BATCH_SIZE = 24
const FILE_BATCH_BYTES = 32 * 1024 * 1024

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (file: File): Promise<ZipDirectory> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const directory = await readDirectory(file)
  try {
    const iterator = readArchive(file, directory)
    const first = await iterator.next()
    if (first.done || first.value.path !== MANIFEST_PATH) {
      fail('backupUnrecognized')
    }
    checkManifest(await readJson(first.value))
    await iterator.return(undefined)
    return directory
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 * 会话/图片按批次写暂存：把原本上千次 HTTP 往返压到几十次，
 * 并去掉 staging 阶段的 BLOB 双写。写入导入暂存存储；调用方负责先清空暂存，
 * 成功后替换正式数据，失败时清理暂存。
 */
export const importArchive = async (file: File, directory?: ZipDirectory): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const started = now()
  const imported = new Set<string>()
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined

  type Session = Parameters<typeof db.addStagingSessions>[0][number]
  type StoredFile = Parameters<typeof db.saveStagingFiles>[0][number]
  const sessionBatch: Session[] = []
  const fileBatch: StoredFile[] = []
  let fileBatchBytes = 0
  const timing = {
    parseMs: 0,
    sessionWriteMs: 0,
    fileWriteMs: 0,
    sessions: 0,
    images: 0,
    imageBytes: 0,
  }

  const flushSessions = async () => {
    if (!sessionBatch.length) {
      return
    }
    const t = now()
    await db.addStagingSessions(sessionBatch.splice(0))
    timing.sessionWriteMs += now() - t
  }

  const flushFiles = async () => {
    if (!fileBatch.length) {
      return
    }
    const t = now()
    fileBatchBytes = 0
    await db.saveStagingFiles(fileBatch.splice(0))
    timing.fileWriteMs += now() - t
  }

  const addSession = async (session: Session) => {
    sessionBatch.push(session)
    timing.sessions++
    if (sessionBatch.length >= SESSION_BATCH_SIZE) {
      await flushSessions()
    }
  }

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const t = now()
    const data = await readEntry(entry)
    timing.parseMs += now() - t
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    fileBatch.push({ id, blob: new Blob([data], { type }) })
    fileBatchBytes += data.size
    stored.set(id, type)
    timing.images++
    timing.imageBytes += data.size
    if (fileBatch.length >= FILE_BATCH_SIZE || fileBatchBytes >= FILE_BATCH_BYTES) {
      await flushFiles()
    }
  }

  try {
    for await (const entry of readArchive(file, directory)) {
      const { path } = entry
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const t = now()
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        timing.parseMs += now() - t
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        currentSessionId = sessionId
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
        }
        await addSession(local.session)
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (
        index
          ? imported.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      } else {
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    throw error instanceof ArchiveError ? new BackupError('backupIncomplete') : error
  }
  // 收尾：把不足一批的会话与图片写出去。
  await flushSessions()
  await flushFiles()
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== imported.size ||
    [...imported].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  await db.updateStagingFileTypes(stored)
  // 一次性导入耗时埋点，便于定位瓶颈（不影响正确性）。
  // eslint-disable-next-line no-console
  console.info('[import] timing', {
    ...timing,
    wasm: crc32UsingWasm(),
    imageMB: Math.round(timing.imageBytes / 1048576),
    totalMs: Math.round(now() - started),
  })
}
