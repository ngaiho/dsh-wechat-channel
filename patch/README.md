# 补丁说明

本目录包含对 `@dsh-extra/im-channel`（`dsh-im-bot` 的 im-channel 插件，[ivorytower1026/dsh-im-bot](https://github.com/ivorytower1026/dsh-im-bot)，MIT）的可靠性/运维增强补丁。补丁基于该插件 **commit `9d80f73`** 的 `lib/` 构建产物。

> 上游插件版本说明：`@dsh-extra/im-channel@0.0.1`，peer 依赖 `>=0.1.0`，兼容 DSH `0.1.0-rc.5`。安装方式见仓库根 README。

## 补丁内容

| 文件 | 改动 | 解决什么问题 |
|---|---|---|
| `lib/plugin/index.js` | ① 频道日志同时写入 `~/.dsh/im-channel/logs/im-channel.log`（原来只输出到终端，无法事后排查）<br>② 新增 `GET /im-channel/health`（含 `pendingApprovals` 待审批数）<br>③ 新增 `POST /im-channel/recover` 频道强制重建路由（自愈）<br>④ 新增 `POST /im-channel/send` 主动推送路由<br>⑤ 注册 `wechat_send` 工具（任意智能体可主动发微信）<br>⑥ 装配微信审批应答器 + 发送函数 | 通信问题不可见、无法远程诊断/恢复/推送/授权 |
| `lib/plugin/wechat-ops.js`（新增） | 微信审批应答器：`approval/request` 时把授权请求推送到微信，用户回复「同意/拒绝」即结算（`allowed-once`/`rejected`）；10 分钟未回复交还 GUI 审批链；绑定反向查询与 `handleApprovalReply` | 离开电脑也能授权工具权限 |
| `lib/core/router.js` | ① 收到消息立即回复「🤖 已收到，正在处理…」，完成后回最终回复；空回复兜底<br>② 消息拦截钩子 `deps.intercept`：审批回复先于普通路由处理 | 长任务静默无反馈；审批回复被当普通消息 |
| `lib/plugin/driver.js` | 单回合 10 分钟超时：超时自动取消该回合并提示，不再让一次卡死导致机器人永久无响应；「任务进行中」提示改为中文 | 智能体卡死（等审批/模型无响应）后机器人失联 |

## 应用方式

```sh
node apply-patch.mjs                 # 默认打到 ~/.dsh/profiles/web/.../im-channel/lib
node apply-patch.mjs /path/to/lib    # 或指定插件 lib 目录
```

脚本会先把现有 `lib/` 备份为 `lib.bak-<时间戳>`，再整体覆盖为补丁版本。应用后**需要重启 dsh web** 生效。

## 注意

- **重新 `pnpm install` 会还原为上游代码**，补丁丢失——重装后重新运行 `apply-patch.mjs` 即可。
- `files/lib/` 是上游 MIT 代码 + 上述改动的完整文件（与锁定的 commit 一致），便于一键覆盖恢复。
- 上游插件升级后，`files/lib/` 可能不再匹配新版；此时请对照上表手动重打各改动。
- **审批词表**：微信应答器返回 `allowed-once`（同意）/`rejected`（拒绝）。不要返回 `approved`——审批服务只认 `allowed-once | rejected | cancelled | unavailable`，`approved` 会被归一化为 `unavailable`（表现为"no approval channel is available"）。
