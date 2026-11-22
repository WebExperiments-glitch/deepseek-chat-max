/**
 * ZIP CRC-32 (IEEE 802.3) — 优先用 Rust 编译的 WASM 模块，加载失败时降级到 JS 表驱动。
 *
 * WASM 模块由 `crates/crc32-wasm` 编译而来（见 `pnpm build:wasm`）。它在 WASM 线性内存里
 * 暴露一块 1 MiB scratch buffer；调用方把数据块拷进去，再调用 `crc32(crc, len)`。
 * 这样 CRC 在原生编译代码里逐字节计算，避免 JS 侧 7.6 亿次的解释器循环。
 *
 * 该模块是可选加速：任何加载/环境问题都会静默回退到等价的 JS 实现，导入仍可正常完成。
 */

import { http } from '../../../ports/http.js'

type WasmExports = {
  memory: WebAssembly.Memory
  scratch_ptr: () => number
  scratch_len: () => number
  crc32: (crc: number, len: number) => number
  crc32_finish: (crc: number) => number
  crc32_bytes: (crc: number, ptr: number, len: number) => number
  inflate_in_ptr: () => number
  inflate_in_len: () => number
  inflate_out_ptr: () => number
  inflate_out_len: () => number
  inflate_once: (inputLen: number) => bigint
}

type CrcState = {
  exports: WasmExports
  view: Uint8Array
  capacity: number
  inView: Uint8Array
  outView: Uint8Array
}

/** undefined = 尚未加载；null = 加载失败并用 JS 降级；对象 = WASM 可用 */
let state: CrcState | null | undefined

const jsTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const jsCrc32 = (crc: number, bytes: Uint8Array): number => {
  let c = crc
  for (const byte of bytes) {
    c = (c >>> 8) ^ (jsTable[(c ^ byte) & 0xff] ?? 0)
  }
  return c >>> 0
}

/** 预加载 WASM；应在导入开始前 await 一次。失败不抛错，自动走 JS 降级。 */
export const crc32Init = async (): Promise<void> => {
  if (state !== undefined) {
    return
  }
  try {
    const url = new URL('./wasm/crc32_wasm.wasm', import.meta.url)
    const response = await http(url)
    if (!response.ok) {
      throw new Error(`wasm fetch failed: ${response.status}`)
    }
    const bytes = await response.arrayBuffer()
    const { instance } = await WebAssembly.instantiate(bytes, {})
    const exports = instance.exports as unknown as WasmExports
    const ptr = exports.scratch_ptr()
    const capacity = exports.scratch_len()
    const view = new Uint8Array(exports.memory.buffer, ptr, capacity)
    const inView = new Uint8Array(
      exports.memory.buffer,
      exports.inflate_in_ptr(),
      exports.inflate_in_len()
    )
    const outView = new Uint8Array(
      exports.memory.buffer,
      exports.inflate_out_ptr(),
      exports.inflate_out_len()
    )
    state = { exports, view, capacity, inView, outView }
  } catch {
    // 环境不支持或资源缺失：静默降级，保持导入可用。
    state = null
  }
}

/** 返回是否正在使用 WASM 加速（供诊断/测试用）。 */
export const crc32UsingWasm = (): boolean => state !== null && state !== undefined

/**
 * 续算 CRC。`crc` 传入上一块的结果（首次为 0xffffffff），返回新的内部状态。
 * 内部会把 `bytes` 切成不超过 scratch 容量的片段送进 WASM。
 */
export const crc32Update = (crc: number, bytes: Uint8Array): number => {
  const s = state
  if (!s) {
    return jsCrc32(crc, bytes)
  }
  let result = crc >>> 0
  const { view, capacity, exports } = s
  for (let offset = 0; offset < bytes.length; offset += capacity) {
    const length = Math.min(capacity, bytes.length - offset)
    view.set(bytes.subarray(offset, offset + length))
    result = exports.crc32(result, length) >>> 0
  }
  return result
}

/** 把内部状态反转成 ZIP 里的最终 CRC 值。 */
export const crc32Finish = (crc: number): number => (crc ^ 0xffffffff) >>> 0

/** WASM 一次性解压一个 raw DEFLATE 条目，同时就地算出 CRC；不可用或数据过大时返回 null。 */
export const wasmInflate = (
  compressed: Uint8Array
): { bytes: Uint8Array; crc: number } | null => {
  const s = state
  if (!s || compressed.length > s.inView.length) {
    return null
  }
  s.inView.set(compressed)
  const written = Number(s.exports.inflate_once(compressed.length))
  if (written < 0) {
    return null
  }
  // 输出缓冲会在下次调用时被覆盖，必须拷出；CRC 直接对 WASM 输出缓冲计算，免去二次遍历。
  const bytes = s.outView.slice(0, written)
  const crc = s.exports.crc32_bytes(0xffffffff, s.exports.inflate_out_ptr(), written) >>> 0
  return { bytes, crc }
}
