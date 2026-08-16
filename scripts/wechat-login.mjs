#!/usr/bin/env node
/**
 * 微信 iLink 扫码登录辅助脚本（备用登录路径）
 *
 * 用途：当 Web 设置页的「手机连接」标签不可用时，用终端完成微信机器人登录。
 * 原理：调用 dsh web 进程内 im-channel 插件的登录路由，轮询登录状态。
 *
 * 用法：
 *   node ~/.dsh/im-channel/wechat-login.mjs [baseUrl]
 *   （baseUrl 默认 http://127.0.0.1:3080）
 *
 * 流程：
 *   1) POST /im-channel/login/start {"kind":"wechat"} 拿到二维码 URL
 *   2) 终端打印二维码（若可用 qrcode-terminal）或提示用浏览器打开 URL
 *   3) 手机微信扫码确认
 *   4) 轮询 /im-channel/login/status 直到 confirmed，凭据自动保存
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3080'
const START = `${BASE}/im-channel/login/start`
const STATUS = `${BASE}/im-channel/login/status`

async function main() {
  // 1. 发起登录
  let res = await fetch(START, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'wechat' }),
  })
  const start = await res.json()
  if (!start.ok) {
    console.error(`❌ 启动登录失败: ${start.error ?? '未知错误'}`)
    console.error('   请确认 dsh web 已重启且 im-channel 插件已加载。')
    process.exit(1)
  }

  // 2. 展示二维码
  console.log('\n📱 微信扫码登录（iLink 官方协议）\n')
  const qrUrl = start.qrUrl
  if (!qrUrl) {
    console.log('⏳ 等待二维码生成…')
  } else {
    await showQr(qrUrl)
  }

  // 3. 轮询状态
  const startedAt = Date.now()
  const TIMEOUT = 8 * 60_000 // 8 分钟
  while (Date.now() - startedAt < TIMEOUT) {
    await sleep(1000)
    let data
    try {
      res = await fetch(STATUS)
      data = await res.json()
    } catch {
      console.error('⚠️  无法连接 dsh web，请确认服务在运行。')
      process.exit(1)
    }
    const session = data.session
    if (session === null || session === undefined) {
      console.error('❌ 登录会话已过期，请重新运行本脚本。')
      process.exit(1)
    }
    switch (session.status) {
      case 'pending':
        if (session.qrUrl && session.qrUrl !== qrUrl) await showQr(session.qrUrl)
        process.stdout.write('.')
        break
      case 'scaned':
        console.log('\n📱 已扫码，请在手机上确认…')
        break
      case 'confirmed':
        console.log('\n✅ 微信登录成功！凭据已保存。')
        console.log('   现在可以：')
        console.log('   - 在微信里给机器人发 /bind 绑定会话')
        console.log('   - 发 /项目 选择工作区')
        console.log('   - 直接发消息与智能体对话')
        return
      case 'error':
        console.error(`\n❌ 登录失败: ${session.error ?? '未知错误'}`)
        process.exit(1)
      default:
        process.stdout.write(`[${session.status}]`)
    }
  }
  console.error('\n❌ 登录超时，请重新运行本脚本。')
  process.exit(1)
}

async function showQr(url) {
  console.log('🔗 二维码链接: ' + url)
  // 若环境里可用 qrcode-terminal（如已在 profile 里安装），直接渲染二维码
  try {
    const qrcode = await import('qrcode-terminal')
    qrcode.default.generate(url, { small: true })
    console.log('   （如上二维码请用手机微信「扫一扫」扫描）')
  } catch {
    console.log('   （本终端无二维码渲染库；可在浏览器打开上面的链接显示二维码图片，')
    console.log('     再用手机微信「扫一扫」扫描）\n')
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error) => {
  console.error('❌ 脚本错误:', error)
  process.exit(1)
})
