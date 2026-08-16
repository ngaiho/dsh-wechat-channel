---
name: dsh-wechat-channel
description: Use when the user asks about WeChat (微信) connectivity with their DSH agent — the WeChat bot stops responding, replies are missing or intermittent ("发消息没反应/没反馈"), checking channel health, recovering the WeChat polling loop, re-logging-in after the bot token expires, approving tool permissions from WeChat, pushing session progress to WeChat, managing the im-channel watchdog, or setting up the WeChat channel.
---

# 微信通道（WeChat Channel）运维手册

DSH 的微信接入基于 `@dsh-extra/im-channel` 插件（腾讯官方 iLink 协议：扫码登录、长轮询收消息、sendmessage 回消息），并在其上打了可靠性/运维补丁（见 `patch/README.md`）。本技能用于诊断、恢复、授权和推送微信通道。

## 关键文件与组件

| 组件 | 路径 |
|---|---|
| 频道日志（每次轮询/收发都记录） | `~/.dsh/im-channel/logs/im-channel.log` |
| 守护脚本日志 | `~/.dsh/im-channel/logs/watchdog.log` |
| 监控脚本日志 | `~/.dsh/im-channel/logs/monitor.log` |
| 健康检查脚本 | `~/.dsh/im-channel/health.mjs`（运行：`node ~/.dsh/im-channel/health.mjs`） |
| 守护脚本 | `~/.dsh/im-channel/watchdog.mjs`（每 60s 检测，异常自动 recover） |
| 会话进度推送监控 | `~/.dsh/im-channel/monitor-session.mjs`（用法见下） |
| 终端扫码登录脚本 | `~/.dsh/im-channel/wechat-login.mjs`（GUI 设置页不可用时的备用） |
| 机器人凭据（botToken/accountId） | `~/.dsh/im-channel/credentials/wechat.json` |
| 轮询游标（游标新鲜 = 轮询活着） | `~/.dsh/im-channel/state/wechat-cursor.txt` |
| 绑定关系（用户→会话） | `~/.dsh/im-channel/bindings.json`（查看：`GET /im-channel/bindings`） |
| 监控去重状态 | `~/.dsh/im-channel/monitor-<session前12位>.json` |
| 插件源码（补丁已打，原版在 lib.bak-*） | `~/.dsh/profiles/web/node_modules/@dsh-extra/im-channel/lib/` |
| 设置（频道实例） | `~/.dsh/settings.yaml` 的 `im-channel:` 节 |

插件注册的 HTTP 路由（基于 webServer）：
- `GET /im-channel/health` — 健康状态：`routerActive`、`channels`、`credentials`、`pendingApprovals`（待审批数）
- `POST /im-channel/recover` — 强制重建频道路由（自愈）
- `POST /im-channel/send` `{"text":"..."}` — 主动给绑定微信用户发消息（监控/脚本用）
- `POST /im-channel/login/start` `{"kind":"wechat"}`、`GET /im-channel/login/status` — 扫码登录
- `GET /im-channel/bindings` — 绑定列表

## 微信审批（授权）

插件安装了审批应答器（`lib/plugin/wechat-ops.js`，prepend 注册，**微信优先、GUI 兜底**）：
- 任何会话的智能体需要权限时（如 `sandbox_permissions` 提升），审批请求会推送到绑定用户的微信：
  `🔐 需要你的授权 / 工具：bash / 原因：... / 回复「同意」或「拒绝」`
- 用户在微信回复关键词即完成授权：**同意/允许/确认/允许一次/approve/yes/y/ok/1** → 放行；**拒绝/取消/不允许/reject/no/n/0** → 拒绝
- 未明确回答会提示"请回复「同意」或「拒绝」"并继续等待；**10 分钟未回复**则交还 GUI 审批链
- 审批结果词表必须是 `allowed-once | rejected | cancelled | unavailable`（**不能返回 `approved`**，否则被归一化为 unavailable 导致"no approval channel is available"）
- 无微信绑定用户时，应答器直接让路（`next()`），审批走 GUI

## 进度推送（把会话进展推送到微信）

两个途径：
1. **监控脚本** `node ~/.dsh/im-channel/monitor-session.mjs <sessionId> [intervalSec]` — 监听指定会话日志，推送 assistant/message、turn/end（完成/失败/中断）、tool 错误；首次启动从当前进度开始，只推新事件；每轮最多 5 条防刷屏；去重状态存 `monitor-<id>.json`
2. **`wechat_send` 工具** — 任何智能体可主动调用发送消息给绑定用户（进度汇报等）

## 健康检查（第一步）

运行 `node ~/.dsh/im-channel/health.mjs`，逐项核对：
- dsh web 服务器在线（127.0.0.1:3080）
- `/im-channel/health` 路由可用（`ok: true`）
- 频道路由器激活（`routerActive: true`，`channels` 含 `wechat(已配置)`）
- 绑定会话 ≥ 1（审批/推送依赖绑定）
- 微信凭据存在
- 轮询游标新鲜（< 5 分钟）

任何一项 ❌ 即进入下方诊断流程。

## 诊断流程（用户报告"没反应/没反馈"时按序执行）

1. **服务器在线？** `curl -s http://127.0.0.1:3080/im-channel/health`。连不上 → 服务器挂了，请用户重启 dsh web。
2. **轮询活着？** 看 `~/.dsh/im-channel/state/wechat-cursor.txt` 的 mtime（正常每 ~20s 更新）。>6 分钟未更新 = 轮询停摆。
3. **日志里有什么？** 查 `~/.dsh/im-channel/logs/im-channel.log` 尾部：
   - `wechat getupdates ... msgs=0 bufLen=104` — 正常心跳。
   - `wechat token stale (errcode=-14)` — **token 失效**，需重新扫码登录。
   - `wechat send FAILED` — 发送失败（多为 context_token/网络问题）。
   - `recover: 已触发频道重建` — 守护脚本自愈记录。
   - `wechat inbound ... text=同意` — 用户回复了审批（与 `pendingApprovals` 对应）。
4. **绑定还在？** `GET /im-channel/bindings`。空 = 用户需在微信里重新发 `/bind`（审批/推送也会因此失效）。
5. **凭据对得上？** 读 `credentials/wechat.json` 的 `accountId`；注意：**重新扫码会生成新 bot 账号并覆盖凭据，运行中的轮询仍用旧 token**——需重启 dsh web 或触发 recover。

## 恢复动作（按严重程度）

1. **轮询停摆但进程活着**：`curl -X POST http://127.0.0.1:3080/im-channel/recover`（返回 `{"ok":true,"rebuilt":true,"routerActive":true}` 即成功；5 秒内恢复轮询）。守护脚本会自动做。
2. **守护脚本没在跑**：`pgrep -f watchdog.mjs`；不在则启动：`cd ~/.dsh/im-channel && nohup node watchdog.mjs >/dev/null 2>&1 &`。**重启电脑后守护不自启**，需重新执行。
3. **监控脚本没在跑**：`pgrep -f monitor-session`；重启：`cd ~/.dsh/im-channel && nohup node monitor-session.mjs <sessionId> 20 >/dev/null 2>&1 &`（从当前进度继续，不重复推送历史）。
4. **token 失效（errcode=-14）**：无法自动修复。让用户 GUI「设置 → 手机连接」重新扫码（或 `node ~/.dsh/im-channel/wechat-login.mjs`），扫码后重启 dsh web 立即生效，或等守护脚本 ~6 分钟自动 recover；扫码若换了新 bot 账号需重新 `/bind`。
5. **服务器挂了**：只能由用户重启（启动 dsh web 的终端 Ctrl+C 后重跑，如 `pnpm dsh web`）。重启后绑定、凭据、游标都保留，微信通道自动恢复。

## 用户体验相关的已知行为

- 发消息后先收到「🤖 已收到，正在处理…」，再收到最终回复——即时确认，不是故障。
- 单回合超时 10 分钟自动取消并提示「处理超时」。
- 「上一个任务还在处理中，请稍候再发」= 前一回合未结束。
- 审批推送：微信收到「🔐 需要你的授权」回复「同意/拒绝」即可；不回复 10 分钟后转 GUI 审批。
- 审批结果词表 `allowed-once`——改代码时不要用 `approved`。
- 智能体操作需要权限时若无人审批会卡到回合超时——微信审批已覆盖此场景。

## 日常维护

- **查状态**：`node ~/.dsh/im-channel/health.mjs`
- **看日志**：`tail -50 ~/.dsh/im-channel/logs/im-channel.log`
- **改插件源码**：补丁在 `~/.dsh/profiles/web/node_modules/@dsh-extra/im-channel/lib/`；改前先备份。**重新 `pnpm install` 会覆盖补丁**，用仓库里的 `patch/apply-patch.mjs` 一键重打。
- **登录脚本**：`node ~/.dsh/im-channel/wechat-login.mjs`（终端二维码）。
- **授权**：审批推送微信后，微信回复「同意」/「拒绝」。
