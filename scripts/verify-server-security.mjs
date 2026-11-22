#!/usr/bin/env node
/**
 * 本机服务安全回归测试：用 Node test runner 起子进程验证 fail-closed 鉴权、
 * 安全响应头、附件下载 nosniff/Content-Disposition。临时数据目录，不碰真实库。
 *
 * 运行：node --test scripts/verify-server-security.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..')
const SERVER = path.join(ROOT, 'server', 'index.mjs')

const freePort = () =>
  new Promise((resolve) => {
    const s = spawn(process.execPath, [
      '-e',
      "const n=require('net');const s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ])
    let out = ''
    s.stdout.on('data', (d) => (out += d))
    s.on('exit', () => resolve(Number(out.trim())))
  })

/** 启动服务，返回 { proc, port, stop } */
async function start(env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-demo-sec-'))
  const port = await freePort()
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let ready = false
  let bootLog = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout: ' + bootLog)), 8000)
    const onData = (d) => {
      bootLog += d
      if (/chat-demo server:/.test(bootLog)) {
        clearTimeout(timer)
        ready = true
        resolve()
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (!ready) reject(new Error(`server exited ${code}: ${bootLog}`))
    })
  })
  return {
    proc,
    port,
    bootLog,
    stop: async () => {
      proc.kill()
      await new Promise((resolve) => proc.once('exit', resolve))
      // Windows 上 SQLite 文件句柄释放有延迟，重试清理
      for (let i = 0; i < 8; i += 1) {
        try {
          rmSync(dir, { recursive: true, force: true })
          return
        } catch {
          await new Promise((r) => setTimeout(r, 120))
        }
      }
    },
  }
}

test('对外暴露 HOST=0.0.0.0 且无 AUTH_TOKEN 时拒绝启动', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chat-demo-sec-'))
  const port = await freePort()
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DATA_DIR: dir, HOST: '0.0.0.0', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stderr.on('data', (d) => (log += d))
  proc.stdout.on('data', (d) => (log += d))
  const code = await new Promise((resolve) => proc.on('exit', resolve))
  rmSync(dir, { recursive: true, force: true })
  assert.equal(code, 1)
  assert.match(log, /AUTH_TOKEN/)
})

test('对外暴露时无 token 返回 401，带 token 返回 200 + 安全头', async () => {
  const s = await start({ HOST: '0.0.0.0', AUTH_TOKEN: 's3cret' })
  try {
    const base = `http://127.0.0.1:${s.port}`
    const noAuth = await fetch(`${base}/api/stats`)
    assert.equal(noAuth.status, 401)

    const ok = await fetch(`${base}/api/stats`, {
      headers: { Authorization: 'Bearer s3cret' },
    })
    assert.equal(ok.status, 200)
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(ok.headers.get('x-frame-options'), 'DENY')
    assert.match(ok.headers.get('content-security-policy') ?? '', /default-src 'self'/)
  } finally {
    await s.stop()
  }
})

test('回环模式免鉴权且带安全头', async () => {
  const s = await start()
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/api/stats`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  } finally {
    await s.stop()
  }
})

test('附件下载强制 nosniff + Content-Disposition，即使 mime 是 text/html', async () => {
  const s = await start()
  try {
    const base = `http://127.0.0.1:${s.port}`
    // 先写入一个声明为 text/html 的文件
    const put = await fetch(`${base}/api/files/sec-test-html`, {
      method: 'PUT',
      headers: { 'x-mime-type': 'text/html' },
      body: '<script>alert(1)</script>',
    })
    assert.equal(put.status, 200, await put.text())
    const get = await fetch(`${base}/api/files/sec-test-html`)
    assert.equal(get.status, 200)
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff')
    assert.match(get.headers.get('content-disposition') ?? '', /^attachment/)
    assert.match(get.headers.get('content-security-policy') ?? '', /sandbox/)
  } finally {
    await s.stop()
  }
})
