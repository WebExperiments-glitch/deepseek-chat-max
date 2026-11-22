import { beforeAll, describe, expect, it } from 'vitest'
import { crc32Finish, crc32Init, crc32Update } from './crc32.js'

const FINAL_CRC = 0xcbf43926 // CRC-32("123456789")

describe('zip crc32', () => {
  beforeAll(async () => {
    await crc32Init()
  })

  it('matches the standard check value', () => {
    const data = new TextEncoder().encode('123456789')
    expect(crc32Finish(crc32Update(0xffffffff, data))).toBe(FINAL_CRC)
  })

  it('empty input is zero', () => {
    expect(crc32Finish(crc32Update(0xffffffff, new Uint8Array()))).toBe(0)
  })

  it('incremental equals one-shot across arbitrary chunk sizes', () => {
    const data = Uint8Array.from({ length: 5000 }, (_, i) => i % 251)
    const oneShot = crc32Finish(crc32Update(0xffffffff, data))
    for (const size of [1, 7, 137, 1024, 4096]) {
      let crc = 0xffffffff
      for (let i = 0; i < data.length; i += size) {
        crc = crc32Update(crc, data.subarray(i, Math.min(i + size, data.length)))
      }
      expect(crc32Finish(crc), `chunk size ${size}`).toBe(oneShot)
    }
  })
})
