# 补丁说明

本目录包含对 `@dsh-extra/im-channel`（`dsh-im-bot` 的 im-channel 插件，[ivorytower1026/dsh-im-bot](https://github.com/ivorytower1026/dsh-im-bot)，MIT）的可靠性增强补丁。补丁基于该插件 **commit `9d80f73`** 的 `lib/` 构建产物。

> 上游插件版本说明：`@dsh-extra/im-channel@0.0.1`，peer 依赖 `>=0.1.0`，兼容 DSH `0.1.0-rc.5`。安装方式见仓库根 README。

## 补丁内容

| 文件 | 改动 | 解决什么问题 |
|---|---|---|
| `lib/plugin/index.js` | ① 频道日志同时写入 `~/.dsh/im-channel/logs/im-channel.log`（原来只输出到终端，无法事后排查）<br>② 新增 `GET /im-channel/health` 健康检查路由<br>③ 新增 `POST /im-channel/recover` 频道强制重建路由（自愈） | 通信问题不可见、无法远程诊断与恢复 |
| `lib/core/router.js` | 收到消息立即回复「🤖 已收到，正在处理…」，完成后回最终回复；空回复兜底为「（任务已完成，但没有文本回复）」 | 长任务期间用户以为「没反应」 |
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
- 上游插件升级后，`files/lib/` 可能不再匹配新版；此时请对照上表手动重打三处改动。
