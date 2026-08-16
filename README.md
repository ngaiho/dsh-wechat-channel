# dsh-wechat-channel

把 **DeepSeek Harness（dsh）智能体接入微信** 的一站式加固套件：运维技能 + 健康检查/守护/进度监控脚本 + im-channel 插件可靠性补丁 + **微信审批**。

- 微信通道基于 `@dsh-extra/im-channel` 插件（腾讯**官方 iLink 个人机器人协议**：扫码登录、长轮询收消息、sendmessage 回消息，无个人号外挂、无公网服务器、无付费 token）。
- 本仓库在插件之上追加了可靠性加固与运维能力：文件日志、即时确认、回合超时兜底、健康检查/自愈路由、守护脚本、**微信审批（同意/拒绝即授权）**、**会话进度推送监控**。

## 内容

```
dsh-wechat-channel/
├── skills/dsh-wechat-channel/SKILL.md   # 运维技能（智能体自动加载，用于诊断/恢复/授权/推送）
├── scripts/
│   ├── health.mjs                       # 健康检查：node health.mjs
│   ├── watchdog.mjs                     # 守护：每 60s 检测轮询异常并自动恢复
│   ├── monitor-session.mjs              # 会话进度推送：node monitor-session.mjs <sessionId>
│   └── wechat-login.mjs                 # 终端扫码登录（GUI 设置页不可用时的备用）
├── patch/
│   ├── apply-patch.mjs                  # 一键重打插件补丁（自动备份）
│   ├── files/lib/                       # 补丁后的插件 lib（基于上游 commit 9d80f73）
│   └── README.md                        # 补丁明细
└── README.md
```

## 安装

前置：DSH `>= 0.1.0-rc.5`（web profile）。

### 1. 安装 im-channel 插件

在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 中加入：

```json
"@dsh-extra/im-channel": "github:ivorytower1026/dsh-im-bot#main&path:/im-channel",
"@dsh-extra/dsh-client-ui-settings-im": "github:ivorytower1026/dsh-im-bot#main&path:/ui-settings-im"
```

并在 `dsh.profile.bundles` 追加 `@dsh-extra/im-channel`、`@dsh-extra/dsh-client-ui-settings-im`，然后：

```sh
cd ~/.dsh/profiles/web && pnpm install
```

（`dsh-client-ui-settings-im` 是「设置 → 手机连接」扫码 UI，可选。）

### 2. 应用可靠性补丁

```sh
cd patch && node apply-patch.mjs
```

### 3. 重启 dsh web，扫码登录

- 重启后打开 GUI「设置 → 手机连接」，点微信卡片扫码；或
- 终端执行 `node scripts/wechat-login.mjs`（打印二维码链接，浏览器打开后手机微信扫一扫）。

### 4. 启动守护与监控（可选但推荐）

```sh
nohup node scripts/watchdog.mjs >/dev/null 2>&1 &
nohup node scripts/monitor-session.mjs <要监控的会话ID> 20 >/dev/null 2>&1 &
```

> ⚠️ 重启电脑后守护/监控不会自启，需要重新执行。日志在 `~/.dsh/im-channel/logs/`。

## 使用

扫码登录后，在微信里给机器人发：

| 命令 | 说明 |
|---|---|
| `/bind` | 绑定当前聊天到新的智能体会话 |
| `/项目` | 选择工作区（绑定后需选一次） |
| `/帮助` | 全部命令 |

然后直接发消息对话。每次消息会先收到「🤖 已收到，正在处理…」，完成后收到最终回复。

### 微信审批（授权）

任何会话的智能体需要权限提升时（如 `sandbox_permissions`），审批请求会推送到你微信：

```
🔐 需要你的授权
工具：bash
原因：...
回复「同意」或「拒绝」
```

微信回复 `同意`/`允许`/`确认`/`ok`/`1` 等即放行，`拒绝`/`取消`/`no`/`0` 等即拒绝；10 分钟未回复自动转 GUI 审批。审批结果词表为 `allowed-once | rejected | cancelled | unavailable`（修改代码时注意不要返回 `approved`）。

### 进度推送

- **监控脚本**：`node scripts/monitor-session.mjs <sessionId> 20` — 把指定会话的智能体输出、回合结束/失败推送到微信（首次从当前进度开始，只推新事件）。
- **`wechat_send` 工具**：任何智能体可主动调用给绑定用户发消息。

## 维护

- 健康检查：`node scripts/health.mjs`
- 频道日志：`tail -50 ~/.dsh/im-channel/logs/im-channel.log`
- 出问题让智能体自己处理：它会在相关任务时自动加载 `dsh-wechat-channel` 技能按手册诊断。

## 已知问题与限制

- 重新 `pnpm install` 会还原插件为上游版本，补丁丢失 → 重跑 `apply-patch.mjs`。
- 重新扫码会生成新 bot 账号并覆盖凭据，运行中的轮询仍用旧 token → 重启 dsh web 或触发 `/im-channel/recover`。
- token 失效（`errcode=-14`）需重新扫码；扫码后守护脚本会在 ~6 分钟内自动恢复。
- 微信审批依赖绑定关系（`/bind`）；解绑后审批自动回落到 GUI。

## 许可

MIT。微信通道的 iLink 协议实现移植自 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT，Copyright (C) 2026 Tencent）；im-channel 插件见 [ivorytower1026/dsh-im-bot](https://github.com/ivorytower1026/dsh-im-bot)（MIT）。本仓库不含任何密钥或账户信息。
