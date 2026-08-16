#!/usr/bin/env node
/**
 * 微信通道健康检查
 *
 * 用法：node ~/.dsh/im-channel/health.mjs [baseUrl]
 * 检查：服务器在线、插件路由、频道活动状态、轮询游标新鲜度、绑定状态、token 有效性
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:3080'
const CURSOR = join(homedir(), '.dsh', 'im-channel', 'state', 'wechat-cursor.txt')
const CREDS = join(homedir(), '.dsh', 'im-channel', 'credentials', 'wechat.json')
const LOG = join(homedir(), '.dsh', 'im-channel', 'logs', 'im-channel.log')

let failed = false
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed = true
}

async function main() {
  console.log(`微信通道健康检查 @ ${new Date().toLocaleString('zh-CN')}\n`)

  // 1. 服务器在线
  let up = false
  try {
    const res = await fetch(`${BASE}/im-channel/health`, { signal: AbortSignal.timeout(5000) })
    up = res.ok
  } catch { up = false }
  check('dsh web 服务器在线', up, BASE)

  if (up) {
    const health = await (await fetch(`${BASE}/im-channel/health`)).json()
    check('插件路由 /im-channel/health', health.ok === true)
    check('频道路由器激活', health.routerActive === true,
      health.channels?.map(c => `${c.kind}${c.configured ? '(已配置)' : '(未配置)'}`).join(', ') || '无频道')
    try {
      const b = await (await fetch(`${BASE}/im-channel/bindings`)).json()
      check('绑定会话', (b.count ?? 0) > 0, `${b.count ?? 0} 个`)
    } catch { check('绑定会话查询', false) }
  }

  // 2. 凭据
  let hasCreds = false
  try {
    const c = JSON.parse(readFileSync(CREDS, 'utf8'))
    hasCreds = !!c.botToken
    check('微信凭据', hasCreds, c.accountId ?? '')
  } catch { check('微信凭据', false) }

  // 3. 轮询游标新鲜度（<5 分钟算健康；长轮询正常时每 ~20s 更新）
  try {
    const mtime = statSync(CURSOR).mtimeMs
    const ageMin = (Date.now() - mtime) / 60000
    check('轮询游标新鲜', ageMin < 5, `最后更新 ${ageMin.toFixed(1)} 分钟前`)
  } catch {
    check('轮询游标', false, '游标文件不存在——轮询可能未启动')
  }

  // 4. 最近日志（辅助判断）
  try {
    const lines = readFileSync(LOG, 'utf8').trim().split('\n')
    const recent = lines.slice(-6)
    if (recent.length > 0) {
      console.log('\n最近日志:')
      for (const l of recent) console.log('  ' + l)
    }
  } catch { /* 无日志文件 */ }

  console.log(failed ? '\n⚠️ 存在异常，请把上面的 ❌ 项告诉维护者。' : '\n✅ 一切正常。')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('❌ 健康检查脚本错误:', e); process.exit(2) })
