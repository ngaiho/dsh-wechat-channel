/**
 * 微信运维扩展：审批应答器 + 绑定查询 + 主动推送工具
 *
 * 1. 审批应答器：approval/request 时把授权请求推送到微信，用户回复「同意/拒绝」即完成授权
 *    （prepend 注册，微信优先；超时未回复则交还 GUI 审批链）。
 * 2. 主动推送：任何会话/脚本可通过 /im-channel/send 或 wechat_send 工具把消息发给绑定用户。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 等待微信回复的审批：approvalId -> { resolve, timer, userId } */
const pendingApprovals = new Map()
/** 微信回复授权请求的超时（毫秒），超时后交还 GUI 审批链 */
const ASK_TIMEOUT_MS = 10 * 60_000

function bindingsPath() {
  return join(homedir(), '.dsh', 'im-channel', 'bindings.json')
}

function readBindings() {
  const path = bindingsPath()
  if (!existsSync(path)) return { bindings: [] }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { bindings: [] }
  }
}

/** 绑定到某 session 的微信用户 id（反向查询）；无则返回任意微信绑定用户。 */
export function wechatUserForSession(sessionId) {
  const rows = readBindings().bindings.filter(row => row.kind === 'wechat')
  if (rows.length === 0) return undefined
  return rows.find(row => row.sessionId === sessionId)?.userId ?? rows[0].userId
}

/** 当前微信绑定用户（首个），无绑定返回 undefined。 */
export function anyWechatUser() {
  const rows = readBindings().bindings.filter(row => row.kind === 'wechat')
  return rows.length > 0 ? rows[0].userId : undefined
}

/**
 * 从会话事件里找出本次 approval 请求对应的 approvalId（与 apiproxy 的查找一致：
 * 最新的、未决定、未被其他 pending 认领、且 callId 匹配的 approval/asked 事件）。
 */
function findApprovalId(req) {
  const events = req.agent.session.events
  const claimed = new Set(pendingApprovals.keys())
  const decided = new Set()
  let approvalId
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type === 'approval/decided') {
      decided.add(event.data.id)
    } else if (event.type === 'approval/asked') {
      if (decided.has(event.data.id) || claimed.has(event.data.id)) continue
      if ((req.callId ?? null) !== (event.data.callId ?? null)) continue
      approvalId = event.data.id
      break
    }
  }
  return approvalId
}

/**
 * 处理微信回复：若该用户有待授权的请求，按关键词解析并结算。
 * @returns true 表示消息已被审批流程消费（不再走普通路由）
 */
export function handleApprovalReply(message, sendToUser) {
  const entry = [...pendingApprovals.values()].find(a => a.userId === message.from.userId)
  if (entry === undefined) return false
  const text = String(message.text ?? '').trim().toLowerCase()
  const APPROVE = /^(同意|允许|确认|允许一次|approve|yes|y|ok|1)$/
  const REJECT = /^(拒绝|取消|不允许|reject|no|n|0)$/
  if (APPROVE.test(text)) {
    entry.resolve('allowed-once')
    return true
  }
  if (REJECT.test(text)) {
    entry.resolve('rejected')
    return true
  }
  // 未明确回答：继续等待，提示用户
  void sendToUser('🔐 还有待授权的请求，请回复「同意」或「拒绝」。').catch(() => { })
  return true
}

/**
 * 安装审批应答器。ctx 需与 approval 服务同树（插件加载于 host 根上下文）。
 * @param sendToUser - async (text) => boolean 发送给绑定微信用户
 */
export function installApprovalAnswerer(ctx, sendToUser) {
  if (ctx.get('approval') === undefined) return
  ctx.on('approval/request', (req, next) => {
    if (req.signal?.aborted === true) return Promise.resolve('cancelled')
    const userId = wechatUserForSession(req.agent.id)
    if (userId === undefined) return next()
    const approvalId = findApprovalId(req)
    if (approvalId === undefined) return next()
    const reason = req.reason ? `\n原因：${req.reason}` : ''
    void sendToUser(`🔐 需要你的授权\n工具：${req.toolName}${reason}\n回复「同意」或「拒绝」`).catch(() => { })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 超时：交还审批链（GUI 应答器），并转发其结果
        if (!pendingApprovals.delete(approvalId)) return
        try {
          const gui = next()
          if (gui?.then !== undefined) gui.then(resolve, () => resolve('unavailable'))
          else resolve(gui ?? 'unavailable')
        } catch {
          resolve('unavailable')
        }
      }, ASK_TIMEOUT_MS)
      pendingApprovals.set(approvalId, {
        userId,
        timer,
        resolve: (outcome) => {
          clearTimeout(timer)
          pendingApprovals.delete(approvalId)
          resolve(outcome)
        },
      })
    })
  }, { prepend: true })
}

/** 当前待审批数量（供健康检查）。 */
export function pendingApprovalCount() {
  return pendingApprovals.size
}
