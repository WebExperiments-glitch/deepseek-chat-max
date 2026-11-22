//! ZIP CRC-32 (IEEE 802.3, reflected) compiled to WASM for chat-demo imports.
//!
//! Exposes a raw C ABI (no wasm-bindgen CLI needed):
//!   - `memory`            : exported linear memory
//!   - `scratch_ptr()`     : pointer to a 1 MiB scratch buffer inside memory
//!   - `scratch_len()`     : capacity of that buffer
//!   - `crc32(crc, len)`   : CRC over the first `len` bytes of the scratch buffer
//!   - `crc32_finish(crc)` : invert internal state to final ZIP CRC value
//!
//! NOTE: x86 SSE4.2 `crc32` uses the CRC32C (Castagnoli) polynomial, NOT the
//! ZIP CRC-32 polynomial, so it cannot be used here. Table algorithm only.

/// Reflected CRC-32 table (polynomial 0xEDB88320).
const fn make_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut crc = i as u32;
        let mut bit = 0;
        while bit < 8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xEDB88320
            } else {
                crc >> 1
            };
            bit += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

static TABLE: [u32; 256] = make_table();

/// 1 MiB scratch buffer living in WASM linear memory. TS copies each chunk
/// here, then calls `crc32`. Chunks from zipReader are at most 256 KiB.
static mut SCRATCH: [u8; 1024 * 1024] = [0u8; 1024 * 1024];

#[inline]
fn crc32_inner(mut crc: u32, data: &[u8]) -> u32 {
    for &byte in data {
        crc = TABLE[((crc ^ byte as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc
}

#[no_mangle]
pub extern "C" fn scratch_ptr() -> *const u8 {
    unsafe { SCRATCH.as_ptr() }
}

#[no_mangle]
pub extern "C" fn scratch_len() -> usize {
    unsafe { SCRATCH.len() }
}

/// Compute running CRC over `len` bytes in the scratch buffer.
/// Pass 0xFFFF_FFFF for a fresh stream; feed the previous result back to continue.
#[no_mangle]
pub extern "C" fn crc32(crc: u32, len: usize) -> u32 {
    unsafe { crc32_inner(crc, &SCRATCH[..len]) }
}

/// Convenience: CRC of bytes passed directly (native tests only; not used in WASM path).
#[no_mangle]
pub extern "C" fn crc32_bytes(crc: u32, ptr: *const u8, len: usize) -> u32 {
    unsafe { crc32_inner(crc, core::slice::from_raw_parts(ptr, len)) }
}

#[no_mangle]
pub extern "C" fn crc32_finish(internal: u32) -> u32 {
    internal ^ 0xFFFF_FFFF
}

// --- WASM inflate：整条目一次性解压（ZIP method 8 = raw DEFLATE） ---

use miniz_oxide::inflate::stream::{inflate, InflateState};
use miniz_oxide::{DataFormat, MZFlush};

/// 压缩数据输入缓冲（单个会话 JSON 压缩后远小于此）。
static mut IN_SCRATCH: [u8; 2 * 1024 * 1024] = [0u8; 2 * 1024 * 1024];
/// 解压输出缓冲（单个会话 JSON 解压后远小于此）。
static mut OUT_SCRATCH: [u8; 8 * 1024 * 1024] = [0u8; 8 * 1024 * 1024];

#[no_mangle]
pub extern "C" fn inflate_in_ptr() -> *const u8 {
    unsafe { IN_SCRATCH.as_ptr() }
}

#[no_mangle]
pub extern "C" fn inflate_in_len() -> usize {
    unsafe { IN_SCRATCH.len() }
}

#[no_mangle]
pub extern "C" fn inflate_out_ptr() -> *const u8 {
    unsafe { OUT_SCRATCH.as_ptr() }
}

#[no_mangle]
pub extern "C" fn inflate_out_len() -> usize {
    unsafe { OUT_SCRATCH.len() }
}

/**
 * 解压 IN_SCRATCH 前 input_len 字节到 OUT_SCRATCH，返回解压后字节数；失败返回负数。
 * 每个 ZIP 条目是独立 deflate 流，故每次新建 InflateState，无需跨调用保留状态。
 */
#[no_mangle]
pub extern "C" fn inflate_once(input_len: usize) -> i64 {
    if input_len > unsafe { IN_SCRATCH.len() } {
        return -1;
    }
    let mut state = InflateState::new(DataFormat::Raw);
    unsafe {
        let result = inflate(
            &mut state,
            &IN_SCRATCH[..input_len],
            &mut OUT_SCRATCH,
            MZFlush::Finish,
        );
        if result.status.is_err() {
            return -2;
        }
        result.bytes_written as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vector() {
        let c = crc32_bytes(0xFFFF_FFFF, b"123456789".as_ptr(), 9);
        assert_eq!(crc32_finish(c), 0xCBF43926);
    }

    #[test]
    fn empty_string() {
        assert_eq!(crc32_finish(crc32_bytes(0xFFFF_FFFF, [].as_ptr(), 0)), 0);
    }

    #[test]
    fn incremental_matches_oneshot() {
        let data: Vec<u8> = (0..5000).map(|i| (i % 251) as u8).collect();
        let one = crc32_finish(crc32_bytes(0xFFFF_FFFF, data.as_ptr(), data.len()));
        let mut c = 0xFFFF_FFFF;
        for chunk in data.chunks(137) {
            c = crc32_bytes(c, chunk.as_ptr(), chunk.len());
        }
        assert_eq!(crc32_finish(c), one);
    }

    #[test]
    fn scratch_buffer_large_enough() {
        assert!(scratch_len() >= 256 * 1024);
        assert!(!scratch_ptr().is_null());
    }

    #[test]
    fn inflate_roundtrip() {
        let original: Vec<u8> = (0..20_000).map(|i| (i % 97) as u8).collect();
        let compressed = miniz_oxide::deflate::compress_to_vec(&original, 6);
        assert!(compressed.len() < inflate_in_len());
        unsafe {
            core::ptr::copy_nonoverlapping(compressed.as_ptr(), IN_SCRATCH.as_mut_ptr(), compressed.len());
        }
        let written = inflate_once(compressed.len());
        assert!(written >= 0, "inflate failed: {written}");
        assert_eq!(written as usize, original.len());
        let output = unsafe { &OUT_SCRATCH[..written as usize] };
        assert_eq!(output, original.as_slice());

        // 直接对 WASM 输出缓冲计算 CRC，应与逐字节输入一致。
        let via_ptr = crc32_bytes(0xFFFF_FFFF, output.as_ptr(), output.len());
        let via_slice = crc32_inner(0xFFFF_FFFF, &original);
        assert_eq!(via_ptr, via_slice);
    }
}
