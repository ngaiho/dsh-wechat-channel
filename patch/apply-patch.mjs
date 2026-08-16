#!/usr/bin/env node
/**
 * 应用 im-channel 插件的可靠性补丁（备份后复制补丁文件）。
 *
 * 适用场景：重新 `pnpm install` 后，`@dsh-extra/im-channel` 被还原为上游
 * 版本，本仓库打在其 lib/ 上的补丁会丢失。运行本脚本即可一键重打。
 *
 * 用法：
 *   node apply-patch.mjs [pluginLibDir]
 *   默认 pluginLibDir = ~/.dsh/profiles/web/node_modules/@dsh-extra/im-channel/lib
 *
 * 补丁内容（详见 patch/README.md）：
 *   1. plugin/index.js  — 文件日志 + /im-channel/health + /im-channel/recover 路由
 *   2. core/router.js   — 即时确认「已收到」+ 空回复兜底
 *   3. plugin/driver.js — 回合超时（10 分钟）自动取消，防止机器人永久无响应
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PATCH_LIB = join(HERE, 'files', 'lib')
const DEFAULT_TARGET = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@dsh-extra', 'im-channel', 'lib')

const target = process.argv[2] ?? DEFAULT_TARGET

if (!existsSync(join(target, 'plugin', 'index.js'))) {
  console.error(`❌ 目标目录不是 im-channel lib：${target}\n   请确认插件已安装（pnpm install），或用参数指定：node apply-patch.mjs <lib目录>`)
  process.exit(1)
}
if (!existsSync(join(PATCH_LIB, 'plugin', 'index.js'))) {
  console.error(`❌ 本仓库缺少补丁文件：${PATCH_LIB}\n   请确认从仓库根目录运行本脚本。`)
  process.exit(1)
}

// 备份现有 lib
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const backup = join(target, `lib.bak-${ts}`)
mkdirSync(backup, { recursive: true })
for (const entry of readdirSync(target)) {
  if (entry.startsWith('lib.bak-')) continue
  const src = join(target, entry)
  const dst = join(backup, entry)
  if (statSync(src).isDirectory()) cpSync(src, dst, { recursive: true })
  else cpSync(src, dst)
}
console.log(`💾 已备份到 ${backup}`)

// 复制补丁文件（整个 lib 结构覆盖）
cpSync(PATCH_LIB, target, { recursive: true })
console.log('✅ 补丁已应用：')
console.log('   - plugin/index.js  — 文件日志 + health/recover 路由')
console.log('   - core/router.js   — 即时确认 + 空回复兜底')
console.log('   - plugin/driver.js — 回合超时自动取消')
console.log('\n⚠️ 需要重启 dsh web 后生效。')
