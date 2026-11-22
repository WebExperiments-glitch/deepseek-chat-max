# crc32-wasm

零依赖 WASM 模块，为 chat-demo 的 ZIP 导入加速两个纯计算热点：

1. **CRC-32（IEEE 802.3）** —— 覆盖全部 760MB 解压数据（图片 STORE + JSON DEFLATE）。
2. **raw DEFLATE inflate** —— 覆盖 3190 个会话 JSON 的 247MB 解压。

## 为什么不用硬件 CRC32 指令

x86 SSE4.2 的 `crc32` 指令用的是 **CRC32C（Castagnoli）** 多项式，和 ZIP 要求的
**CRC-32（IEEE 802.3）** 不是同一个多项式，结果不兼容。WASM 里也没有对应指令，
因此使用反射查表算法；即便如此，原生编译的 WASM 仍比 JS 逐字节循环快得多。

## 导出接口（原始 C ABI，无 wasm-bindgen CLI）

| 导出 | 作用 |
|---|---|
| `crc32(crc, len)` | 对 `scratch_ptr()` 处前 `len` 字节续算 CRC，内部状态（首次传 `0xffffffff`） |
| `crc32_finish(crc)` | 反转内部状态得到最终 ZIP CRC 值 |
| `crc32_bytes(crc, ptr, len)` | 直接对任意 WASM 内存区域算 CRC（inflate 输出零拷贝复用） |
| `scratch_ptr()` / `scratch_len()` | CRC 输入缓冲（1 MiB） |
| `inflate_once(input_len)` | 把 `inflate_in_ptr()` 处数据一次性解压到 `inflate_out_ptr()`，返回字节数（负数=失败，i64→JS BigInt） |
| `inflate_in_ptr/len`、`inflate_out_ptr/len` | 解压输入/输出缓冲（2 MiB / 8 MiB） |
| `memory` | 导出的线性内存（通过 `--export=memory` 编译参数） |

## 构建

```bash
# 安装 target（国内可用 RUSTUP_DIST_SERVER=https://rsproxy.cn）
rustup target add wasm32-unknown-unknown

# 编译 + 复制到 src（仓库根执行）
pnpm build:wasm
# 若 stable 工具链缺 cargo/target：
#   $env:CARGO_TOOLCHAIN='+1.95.0'; pnpm build:wasm
```

编译产物已随仓库提交在 `src/services/chat/history/wasm/crc32_wasm.wasm`，
因此普通 `pnpm build` **不需要 Rust 工具链**。

## 验证

```bash
cargo +1.95.0 test --manifest-path crates/crc32-wasm/Cargo.toml  # 原生单元测试
pnpm verify:wasm   # Node 里加载真实 .wasm，校验 CRC 向量 + inflate 往返 + 吞吐
```

## 与 TS 层的边界

- `src/services/chat/history/crc32.ts`：懒加载 + JS 降级封装；WASM 不可用时自动回退，
  导入不会失败。
- `zipReader.ts`：STORE 条目走 WASM CRC；DEFLATE 条目走「整块 WASM inflate + 就地 CRC」，
  失败自动回退 fflate。对上层 `ArchiveEntry` 接口零改动。
- 核心聊天逻辑（`toLocal.ts`、`branches.ts`、`reply.ts` 等）完全不依赖本模块，
  iOS 移植时可复用同一份 `.wasm`。
