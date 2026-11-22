import { readFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const bytes = readFileSync('src/services/chat/history/wasm/crc32_wasm.wasm')
const { instance } = await WebAssembly.instantiate(bytes, {})
const e = instance.exports
const req = ['memory', 'crc32', 'crc32_finish', 'crc32_bytes', 'scratch_ptr', 'scratch_len',
  'inflate_once', 'inflate_in_ptr', 'inflate_in_len', 'inflate_out_ptr', 'inflate_out_len']
for (const name of req) if (!(name in e)) throw new Error('missing export: ' + name)
const u32 = (x) => x >>> 0

// CRC 标准向量
const scratch = new Uint8Array(e.memory.buffer, e.scratch_ptr(), e.scratch_len())
scratch.set(new TextEncoder().encode('123456789'))
if (u32(e.crc32_finish(e.crc32(0xffffffff, 9))) !== 0xcbf43926) throw new Error('CRC mismatch')

// WASM inflate：把 Node zlib 压缩的原始数据解压，校验字节与 CRC
const original = Uint8Array.from({ length: 200_000 }, (_, i) => i % 97)
const compressed = deflateRawSync(original, { level: 6 })
const inView = new Uint8Array(e.memory.buffer, e.inflate_in_ptr(), e.inflate_in_len())
if (compressed.length > inView.length) throw new Error('compressed too large for scratch')
inView.set(compressed)
const written = Number(e.inflate_once(compressed.length))
if (written < 0) throw new Error('inflate failed: ' + written)
if (written !== original.length) throw new Error(`length mismatch: ${written} != ${original.length}`)
const outView = new Uint8Array(e.memory.buffer, e.inflate_out_ptr(), written)
if (Buffer.compare(Buffer.from(outView), Buffer.from(original)) !== 0) {
  throw new Error('inflated bytes differ')
}
// 直接对 WASM 输出缓冲算 CRC（zipReader 真实路径）
const crcDirect = u32(e.crc32_finish(e.crc32_bytes(0xffffffff, e.inflate_out_ptr(), written)))
scratch.set(original)
const crcCopy = u32(e.crc32_finish(e.crc32(0xffffffff, original.length)))
if (crcDirect !== crcCopy) throw new Error('CRC on inflate output mismatch')

// inflate 吞吐
const t0 = performance.now()
for (let i = 0; i < 50; i++) e.inflate_once(compressed.length)
const dt = performance.now() - t0
console.log(`WASM 全部导出就绪；inflate 200KB × 50 次 ${dt.toFixed(1)}ms (${(50*200000/1048576/(dt/1000)).toFixed(0)} MB/s 输出)`)
console.log('WASM CRC + inflate 验证通过')
