import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BindStore } from "../core/bind-store.js";
import { Router } from "../core/router.js";
import { HarnessDriver } from "./driver.js";
import { WechatChannel, loadWechatCredentials } from "../channels/wechat/index.js";
import { FeishuChannel, loadFeishuCredentials } from "../channels/feishu/index.js";
import { LoginApi } from "./login-api.js";
export const name = 'im-channel';
export const inject = ['agents'];
const NS = settingsNamespace('im-channel');
const KindUnion = z.union(['feishu', 'wechat']);
const InstanceSchema = z.object({
    kind: KindUnion,
    enabled: z.boolean().default(true),
    displayName: z.string().default(''),
});
export const Config = z.object({
    channels: z.dict(InstanceSchema).default({}),
    commandPrefix: z.string().default('/'),
});
function isCredentialled(kind) {
    switch (kind) {
        case 'wechat': return loadWechatCredentials() !== undefined;
        case 'feishu': return loadFeishuCredentials() !== undefined;
    }
}
// ---- 可靠性增强：把频道日志同时写入文件，便于排查“偶尔没反应” ----
const LOG_DIR = join(homedir(), '.dsh', 'im-channel', 'logs');
const LOG_FILE = join(LOG_DIR, 'im-channel.log');
function writeChannelLog(line) {
    const ts = new Date().toISOString();
    try {
        mkdirSync(LOG_DIR, { recursive: true });
        appendFileSync(LOG_FILE, `[${ts}] ${line}\n`);
    }
    catch {
        // best effort
    }
}
/** Build one channel instance from its declared config. */
function buildChannel(kind, ctx) {
    const log = (line) => {
        process.stdout.write(`[im-channel] ${line}\n`);
        writeChannelLog(line);
    };
    switch (kind) {
        case 'wechat': return new WechatChannel({ ctxLog: log });
        case 'feishu': return new FeishuChannel();
    }
}
export function apply(ctx, config) {
    // Browser-facing login routes: /im-channel/login/start and /status.
    ctx.inject(['webServer'], (wctx) => {
        new LoginApi(wctx).register();
    });
    let current = config;
    let router;
    let disposeRouter;
    // One driver for the whole plugin lifetime: router rebuilds (settings
    // edits, instance reconciliation) must not orphan bound sessions — the
    // driver's owned-session map is what /bind hands out.
    const driver = new HarnessDriver(ctx, {});
    // One bind store for the whole plugin lifetime: the bound-session rows
    // must survive router rebuilds, and /bind hands out new sessions from it.
    const store = new BindStore();
    /**
     * Reconcile the live router against the declared instances: a changed
     * set, kind, or enabled flag restarts the router wholesale — channel
     * connections are cheap to re-establish relative to config edits.
     * force=true ignores the topology check (used by the /recover route).
     */
    const rebuildRouter = (force = false) => {
        const next = current;
        // A platform with saved credentials but no declared instance (e.g.
        // credentials persisted before this reconciliation existed, or settings
        // storage was reset) gets an auto-created instance so the bot actually
        // comes online after login. The settings service is optional at the
        // composition level, so reach it through a scoped inject.
        ctx.inject(['settings'], sctx => {
            void ensureInstancesForCredentials(sctx, next).catch(() => { });
        });
        if (!force && router !== undefined && sameTopology(router, next))
            return;
        disposeRouter?.();
        router = undefined;
        const channels = [];
        for (const [name, instance] of Object.entries(next.channels)) {
            if (!instance.enabled)
                continue;
            if (!isCredentialled(instance.kind)) {
                ctx.logger.warn(`im-channel: 实例 ${name}（${instance.kind}）缺少登录凭证，跳过；请先完成该平台的登录/配置`);
                continue;
            }
            const channel = buildChannel(instance.kind, ctx);
            channels.push(channel);
        }
        if (channels.length === 0)
            return;
        router = new Router({
            channels,
            driver,
            store,
            config: { commandPrefix: next.commandPrefix },
            status: () => {
                const selection = ctx.get('agentDefaultModel');
                if (selection !== undefined) {
                    const value = selection.currentSelection();
                    const facts = { cwd: process.cwd(), provider: value.provider, model: value.model };
                    if (value.reasoningEffort !== undefined)
                        facts.reasoningEffort = value.reasoningEffort;
                    return facts;
                }
                return { cwd: process.cwd(), provider: '-', model: '-' };
            },
            workspaces: () => {
                const registry = ctx.get('workspaceRegistry');
                if (registry === undefined)
                    return [];
                return registry.list().map((w) => ({ path: w.path, title: w.title }));
            },
            models: async () => {
                const llm = ctx.get('llm');
                if (llm === undefined)
                    return [];
                const choices = [];
                for (const provider of llm.listProviders()) {
                    try {
                        const models = await llm.listModels(provider.id);
                        for (const m of models)
                            choices.push({ provider: provider.id, model: m.id, label: m.id });
                    }
                    catch {
                        // Provider without a discoverable catalog is skipped.
                    }
                }
                return choices;
            },
            cancel: sessionId => driver.cancel(sessionId),
            efforts: async () => {
                const llm = ctx.get('llm');
                const selection = ctx.get('agentDefaultModel');
                if (llm === undefined || selection === undefined)
                    return [];
                const value = selection.currentSelection();
                if (value.provider === '' || value.model === '')
                    return [];
                try {
                    const info = await llm.resolveModelInfo(value.provider, value.model);
                    return info.reasoning?.efforts.map(e => ({ id: e.id, name: e.name })) ?? [];
                }
                catch {
                    return [];
                }
            },
            setDefaultModel: async (patch) => {
                const service = ctx.get('agentDefaultModel');
                if (service === undefined)
                    throw new Error('agentDefaultModel 服务不可用');
                const current = service.currentSelection();
                await service.saveSelection({
                    provider: patch.provider ?? current.provider,
                    model: patch.model ?? current.model,
                    ...patch.reasoningEffort === undefined && current.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort },
                });
            },
        });
        void ctx.effect(async function* () {
            await router?.start();
            yield () => { void router?.stop(); };
        }, 'im-channel.router');
        disposeRouter = () => { void router?.stop(); router = undefined; };
    };
    // 可靠性增强：健康检查 + 手动/自动恢复路由（守护脚本调用）。
    ctx.inject(['webServer'], (wctx) => {
        wctx.webServer.register({
            kind: 'exact',
            path: '/im-channel/health',
            handler: (_req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    time: new Date().toISOString(),
                    routerActive: router !== undefined,
                    channels: router?.channels.map(c => ({ kind: c.kind, configured: c.isConfigured() })) ?? [],
                    credentials: { wechat: loadWechatCredentials() !== undefined, feishu: loadFeishuCredentials() !== undefined },
                }));
            },
        });
        wctx.webServer.register({
            kind: 'exact',
            path: '/im-channel/recover',
            handler: (_req, res) => {
                try {
                    rebuildRouter(true);
                    writeChannelLog(`recover: 已触发频道重建 (routerActive=${router !== undefined})`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, rebuilt: true, routerActive: router !== undefined }));
                }
                catch (error) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
                }
            },
        });
    });
    installSettingsSection(ctx, NS, Config, config, {
        setSource: (source) => { current = source(); },
        onChange: () => { rebuildRouter(false); },
    });
}
/** Whether the live router already serves exactly this topology. */
function sameTopology(router, next) {
    const live = router.channels;
    const wanted = Object.entries(next.channels)
        .filter(([, instance]) => instance.enabled)
        .map(([, instance]) => instance.kind)
        .sort();
    const liveKinds = live.map(channel => channel.kind).sort();
    return liveKinds.length === wanted.length && liveKinds.every((kind, index) => kind === wanted[index]);
}
/** Auto-create instances for platforms that have credentials but no row. */
async function ensureInstancesForCredentials(ctx, next) {
    const KIND_LABELS = { wechat: '微信', feishu: '飞书' };
    const patch = {};
    let changed = false;
    for (const kind of ['wechat', 'feishu']) {
        if (!isCredentialled(kind))
            continue;
        const sameKind = Object.entries(next.channels).filter(([, v]) => v.kind === kind);
        if (sameKind.length > 0)
            continue;
        const name = `${kind}-1`;
        patch[name] = { kind, enabled: true, displayName: `${KIND_LABELS[kind]}机器人 1` };
        changed = true;
    }
    if (!changed)
        return;
    try {
        await ctx.settings.update(NS, { channels: patch });
    }
    catch (error) {
        ctx.logger.warn(`im-channel: 为已登录平台自动创建实例失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}
