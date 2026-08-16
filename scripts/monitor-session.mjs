#!/usr/bin/env node
/**
 * 会话进度推送监控：把指定 DSH 会话的进度事件推送到微信。
 *
 * 推送的事件：assistant/message（智能体文本输出）、turn/end（回合结束/失败）、tool/result 错误。
 * 去重：按事件 seq 递增推进（启动时从当前最后 seq 开始，只推新进度）。
 *
 * 用法：
 *   node monitor-session.mjs <sessionId> [intervalSec]
 *   例：node monitor-session.mjs session-a1256ac3-7f28-44e8-91ad-df99c1ac85ee 20
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const SESSION_ID = process.argv[2]
const INTERVAL_MS = (Number(process.argv[3]) || 20) * 1000
const BASE = 'http://127.0.0.1:3080'

if (!SESSION_ID) {
  console.error('用法: node monitor-session.mjs <sessionId> [intervalSec]')
  process.exit(1)
}

const STATE_DIR = join(homedir(), '.dsh', 'im-channel')
const STATE_FILE = join(STATE_DIR, `monitor-${SESSION_ID.slice(0, 12)}.json`)
const LOG_FILE = join(STATE_DIR, 'logs', 'monitor.log')

/** 定位会话日志：<dshHome>/sessions/<cwd-sanitized>/<sessionId>/session.jsonl.zstd */
function sessionFilePath() {
  const sessionsRoot = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(sessionsRoot)) return undefined
  try {
    for (const dir of readdirSync(sessionsRoot)) {
      const candidate = join(sessionsRoot, dir, SESSION_ID, 'session.jsonl.zstd')
      if (existsSync(candidate)) return candidate
    }
  } catch { /* ignore */ }
  return undefined
}

function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}`
  console.log(entry)
  try {
    mkdirSync(join(STATE_DIR, 'logs'), { recursive: true })
    writeFileSync(LOG_FILE, entry + '\n', { flag: 'a' })
  } catch { /* best effort */ }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function saveState(state) {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state)) } catch { /* ignore */ }
}

async function pushToWeChat(text) {
  try {
    const res = await fetch(`${BASE}/im-channel/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    })
    return res.ok
  } catch { return false }
}

/** 读取会话日志中 seq > lastSeq 的进度事件。 */
function readProgress(lastSeq) {
  const path = sessionFilePath()
  if (path === undefined) return { events: [], fileExists: false }
  const proc = spawnSync('zstd', ['-dc', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (proc.status !== 0) return { events: [], fileExists: true, error: proc.stderr }
  const events = []
  for (const line of proc.stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const e = JSON.parse(trimmed)
      const seq = e.seq ?? 0
      if (seq <= lastSeq) continue
      if (e.type === 'assistant/message') {
        const d = e.data ?? {}
        const text = (d.message?.content ?? [])
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('')
        if (text.trim().length > 0) {
          events.push({ seq, kind: 'message', turn: d.turn, text: text.trim() })
        }
      } else if (e.type === 'turn/end') {
        const d = e.data ?? {}
        const reason = d.reason ?? {}
        const kind = reason.kind ?? 'unknown'
        if (kind === 'error') {
          events.push({ seq, kind: 'error', turn: d.turn, text: `回合 ${d.turn} 出错: ${JSON.stringify(reason).slice(0, 200)}` })
        } else if (kind === 'completed') {
          events.push({ seq, kind: 'turn', turn: d.turn, text: `✅ 任务完成（回合 ${d.turn}）` })
        } else if (kind === 'aborted') {
          events.push({ seq, kind: 'turn', turn: d.turn, text: `⏹ 任务被中断（回合 ${d.turn}）` })
        }
      } else if (e.type === 'tool/result' && e.data?.error !== undefined) {
        const d = e.data
        events.push({ seq, kind: 'error', turn: d.turn, text: `工具 ${d.name ?? '?'} 失败: ${String(d.error).slice(0, 200)}` })
      }
      // approval/asked 由微信应答器直接处理，不重复推送
    } catch { /* skip malformed */ }
  }
  return { events, fileExists: true }
}

async function tick(state) {
  const lastSeq = state.lastSeq ?? 0
  const { events, fileExists, error } = readProgress(lastSeq)
  if (!fileExists) {
    log(`⚠️ 会话日志不存在（会话 ${SESSION_ID.slice(0, 12)} 未找到）`)
    return state
  }
  if (error !== undefined) {
    log(`⚠️ 读取会话日志失败: ${String(error).slice(0, 120)}`)
    return state
  }
  if (events.length === 0) return state
  events.sort((a, b) => a.seq - b.seq)
  const toPush = events.slice(-5) // 每轮最多 5 条，避免刷屏
  const maxSeq = events[events.length - 1].seq
  for (const ev of toPush) {
    const icon = ev.kind === 'error' ? '❌' : ev.kind === 'turn' ? '' : '📊'
    const text = `${icon} [会话 ${SESSION_ID.slice(0, 8)}] ${ev.text}`.trim()
    const sent = await pushToWeChat(text)
    log(`${sent ? '✅' : '⚠️'} 推送: ${text.slice(0, 120)}`)
  }
  return { lastSeq: maxSeq }
}

async function main() {
  log(`监控启动: 会话 ${SESSION_ID}（每 ${INTERVAL_MS / 1000}s 检查）`)
  const path = sessionFilePath()
  if (path === undefined) {
    log(`❌ 找不到会话 ${SESSION_ID} 的日志文件`)
    process.exit(1)
  }
  // 首次运行：只从“现在”开始推（初始化 lastSeq 为当前最大 seq）
  const init = readProgress(0)
  const lastSeq = init.events.length > 0 ? init.events[init.events.length - 1].seq : 0
  const state = { lastSeq }
  saveState(state)
  log(`初始化完成，从 seq ${lastSeq} 开始推送新进度`)
  await pushToWeChat(`👀 已开始监控会话 ${SESSION_ID.slice(0, 8)}，有新进度会推送到这里。`)
  setInterval(async () => {
    try {
      const next = await tick(state)
      saveState(next)
      Object.assign(state, next)
    } catch (e) {
      log(`检查异常: ${e}`)
    }
  }, INTERVAL_MS)
}

main().catch((e) => { log(`启动失败: ${e}`); process.exit(2) })
