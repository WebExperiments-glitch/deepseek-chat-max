import { strToU8, zipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  addStagingSessions: vi.fn(async (sessions: unknown[]) => sessions),
  addStagingSession: vi.fn(async (session: unknown) => session),
  saveStagingFiles: vi.fn(async (files: unknown[]) => files),
  updateStagingFileTypes: vi.fn(async (types: ReadonlyMap<string, string>) => types),
}))

vi.mock('../db.js', () => mocks)

import { checkArchiveFormat, importArchive } from './importArchive.js'

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const IMAGE_ID = 'img-1'
const IMAGE_PATH = `chat_sessions/${SESSION_ID}_files/${IMAGE_ID}.webp`
const TIME = '2026-01-01T00:00:00.000Z'

const sessionFile = {
  id: SESSION_ID,
  title: '性能测试会话',
  pinned: true,
  current_message_id: 1,
  inserted_at: TIME,
  updated_at: TIME,
  messages: [
    {
      id: 1,
      parent_id: null,
      role: 'USER',
      status: 'FINISHED',
      thinking_enabled: false,
      search_enabled: false,
      accumulated_token_usage: 0,
      inserted_at: TIME,
      fragments: [
        { type: 'REQUEST', content: '看这张图' },
        {
          type: 'FILE',
          files: [
            {
              id: IMAGE_ID,
              file_name: 'a.webp',
              file_size: 16,
              token_usage: null,
              inserted_at: TIME,
              export_path: IMAGE_PATH,
              is_image: true,
              width: null,
              height: null,
            },
          ],
        },
      ],
    },
  ],
}

const index = [
  {
    id: SESSION_ID,
    title: '性能测试会话',
    pinned: false,
    message_count: 1,
    inserted_at: TIME,
    updated_at: TIME,
  },
]

const webpBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0,
])

const makeArchive = (): Uint8Array =>
  zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    [`chat_sessions/${SESSION_ID}.json`]: strToU8(JSON.stringify(sessionFile)),
    'chat_session_index.json': strToU8(JSON.stringify(index)),
    [IMAGE_PATH]: webpBytes,
  })

class FakeFile {
  readonly size: number
  private readonly bytes: Uint8Array
  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.size = bytes.length
  }
  slice(start = 0, end = this.size) {
    const view = this.bytes.slice(start, end)
    return {
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        const buffer = new ArrayBuffer(view.byteLength)
        new Uint8Array(buffer).set(view)
        return buffer
      },
    }
  }
}

describe('importArchive 批量导入', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('checkArchiveFormat 复用的目录可直接用于 importArchive', async () => {
    const file = new FakeFile(makeArchive()) as unknown as File
    const directory = await checkArchiveFormat(file)
    expect(directory.entries.length).toBe(4)

    await importArchive(file, directory)

    expect(mocks.addStagingSessions).toHaveBeenCalledTimes(1)
    const sessions = (mocks.addStagingSessions.mock.calls[0]?.[0] ?? []) as Array<{ id: string }>
    expect(sessions.map((s) => s.id)).toEqual([SESSION_ID])

    expect(mocks.saveStagingFiles).toHaveBeenCalledTimes(1)
    const files = (mocks.saveStagingFiles.mock.calls[0]?.[0] ?? []) as Array<{
      id: string
      blob: Blob
    }>
    expect(files).toHaveLength(1)
    expect(files[0]?.id).toBe(IMAGE_ID)
    expect(files[0]?.blob.type).toBe('image/webp')
    expect(new Uint8Array(await (files[0]?.blob ?? new Blob()).arrayBuffer())).toEqual(webpBytes)

    expect(mocks.updateStagingFileTypes).toHaveBeenCalledTimes(1)
    const types = mocks.updateStagingFileTypes.mock.calls[0]?.[0] as Map<string, string> | undefined
    expect(types?.get(IMAGE_ID)).toBe('image/webp')
  })

  it('未传目录时也能独立导入', async () => {
    const file = new FakeFile(makeArchive()) as unknown as File
    await importArchive(file)
    expect(mocks.addStagingSessions).toHaveBeenCalledTimes(1)
    expect(mocks.saveStagingFiles).toHaveBeenCalledTimes(1)
  })
})
