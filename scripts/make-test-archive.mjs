/** 生成一个合法的迷你 DeepSeek 导出 ZIP，用于浏览器端导入链路验证。 */
import { strToU8, zipSync } from 'fflate'
import { mkdirSync, writeFileSync } from 'node:fs'

const TIME = '2026-01-01T00:00:00.000Z'
const entries = {
  'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
}

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
const index = []
for (const [n, id] of ids.entries()) {
  const imageId = `img-${n}`
  const imagePath = `chat_sessions/${id}_files/${imageId}.webp`
  entries[`chat_sessions/${id}.json`] = strToU8(
    JSON.stringify({
      id,
      title: `验证会话 ${n + 1}`,
      pinned: false,
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
            { type: 'REQUEST', content: `测试消息 ${n + 1}` },
            {
              type: 'FILE',
              files: [
                {
                  id: imageId,
                  file_name: 'a.webp',
                  file_size: 16,
                  token_usage: null,
                  inserted_at: TIME,
                  export_path: imagePath,
                  is_image: true,
                  width: null,
                  height: null,
                },
              ],
            },
          ],
        },
      ],
    })
  )
  entries[imagePath] = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, n, 0, 0, 0,
  ])
  index.push({ id, title: `验证会话 ${n + 1}`, pinned: false, message_count: 1, inserted_at: TIME, updated_at: TIME })
}
entries['chat_session_index.json'] = strToU8(JSON.stringify(index))

mkdirSync('tmp', { recursive: true })
writeFileSync('tmp/test-import.zip', zipSync(entries))
console.log('written tmp/test-import.zip')
