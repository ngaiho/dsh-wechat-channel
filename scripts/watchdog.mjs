#!/usr/bin/env node
/**
 * 微信通道守护脚本（自动恢复 + 监控）
 *
 * 每 60 秒检查一次：
 *   1. dsh web 是否在线；插件健康路由是否可用
 *   2. 微信轮询游标是否新鲜（>6 分钟未更新 → 触发频道重建 /im-channel/recover）
 *   3. 频道路由器是否激活（未激活 → 触发重建）
 *
 * 日志：~/.dsh/im-channel/logs/watchdog.log
 *
 * 用法：
 *   node ~/.dsh/im-channel/watchdog.mjs [baseUrl]   （前台）
 *   nohup node ~/.dsh/im-channel/watchdog.mjs >/dev/null 2>&1 &  （后台常驻）
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:3080'
const CURSOR = join(homedir(), '.dsh', 'im-channel', 'state', 'wechat-cursor.txt')
const LOG_DIR = join(homedir(), '.dsh', 'im-channel', 'logs')
const WLOG = join(LOG_DIR, 'watchdog.log')
const INTERVAL_MS = 60_000
const CURSOR_STALE_MS = 6 * 60_000

function log(line) {
  const ts = new Date().toISOString()
  const entry = `[${ts}] ${line}`
  console.log(entry)
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(WLOG, entry + '\n')
  } catch { /* best effort */ }
}

async function httpJson(path, init, timeoutMs = 8000) {
  const res = await fetch(`${BASE}${path}`, { ...(init ?? {}), signal: AbortSignal.timeout(timeoutMs) })
  return res.json()
}

async function cursorAgeMs() {
  try { return Date.now() - statSync(CURSOR).mtimeMs } catch { return Infinity }
}

async function tick() {
  let serverUp = false
  let health = null
  try {
    health = await httpJson('/im-channel/health')
    serverUp = health?.ok === true
  } catch { serverUp = false }

  if (!serverUp) {
    log(`⚠️ dsh web 不可达（${BASE}）——请检查服务是否在运行，重启后微信通道会自动恢复。`)
    return
  }

  const routerActive = health?.routerActive === true
  const ageMs = await cursorAgeMs()

  if (!routerActive) {
    log(`⚠️ 频道路由器未激活，触发重建…`)
    try {
      const r = await httpJson('/im-channel/recover', { method: 'POST' })
      log(`→ recover 结果: ${JSON.stringify(r)}`)
    } catch (e) {
      log(`→ recover 失败: ${e}`)
    }
    return
  }

  if (ageMs > CURSOR_STALE_MS) {
    log(`⚠️ 微信轮询游标 ${Math.round(ageMs / 60000)} 分钟未更新，触发频道重建…`)
    try {
      const r = await httpJson('/im-channel/recover', { method: 'POST' })
      log(`→ recover 结果: ${JSON.stringify(r)}`)
      if (r?.routerActive !== true) {
        log(`⚠️ 重建后仍未激活——可能需要重新扫码登录（token 失效）。运行 node ~/.dsh/im-channel/health.mjs 查看详情。`)
      }
    } catch (e) {
      log(`→ recover 失败: ${e}`)
    }
    return
  }

  log(`正常：router=${routerActive} 游标 ${Math.round(ageMs / 1000)}s 前更新`)
}

log(`守护脚本启动 ${BASE}（每 ${INTERVAL_MS / 1000}s 检查一次）`)
await tick()
setInterval(() => { void tick().catch(e => log(`检查异常: ${e}`)) }, INTERVAL_MS)
