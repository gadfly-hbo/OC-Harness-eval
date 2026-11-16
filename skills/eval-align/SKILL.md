---
name: eval-align
description: 测评前的评测工具对齐更新。用户发起测评前调用本 skill，检查 OC-Harness-eval 评测工具与当前 OptraCall 产品是否适配；不适配则修评测工具适配器（绝不改产品），修好后告知用户可以发起测评。
agent_created: true
---

# eval-align — 测评前评测工具对齐

用户不必持续同步评测工具与产品。**测评前**调用本 skill 做一次按需对齐：检查评测工具与当前 OptraCall 产品是否适配，不适配就修评测工具，修好告诉用户「可以测了」，用户再发起 `/skill-eval-flow` 或 `/capability-eval-flow`。

## 红线（不可违背）

**只更新评测工具（OC-Harness-eval 仓库），绝不改动 OptraCall 真实产品。** 不改产品源码、不写真实数据根（`~/.optracall`、`~/OptraCallProjects`）、不碰运行中服务。对齐探针只读使用产品（复制 checkout、独立 Host 实例、假 Provider，无真实费用）。若适配问题根源在产品侧而非评测工具，停下说明，不擅自改产品。

## 用户怎么用

1. 测评前说「更新下评测工具」/「对齐评测工具」/调用 `/skill:eval-align`。
2. 本 skill 检查并（如需）修复，完成后告知「可以发起测评」。
3. 用户再发起实际测评。

## S0 收集输入

- OptraCall checkout 路径（默认 `/Users/huangbo/Dev/OptraCall`）。
- Node 25+ 解释器路径（Host/worker 用；不足时向用户取得）。
- OC-Harness-eval 评测仓库路径（本 skill 所在仓库）。
- 确认 checkout 已安装依赖（`node_modules` 存在）。

## S1 检查适配

先跑评测工具自检，再跑契约探针：

```bash
# 评测工具单元测试（断网，无费用）
npm run check

# 契约探针：真实 Host + 假 Provider，逐接缝检查（无真实费用）
node --experimental-strip-types scripts/eval-align.ts \
  --checkout <checkout> --node <node25+>
```

`eval-align.ts` 依次检查五个接缝：Host API 链路、模型调用链路、memory / sap-method / case-decision 能力。输出每项 ✅/❌ 与汇总。

## S2 判定与修复

- **全 ✅**：评测工具与当前产品适配，进 S3 告知可以测评。
- **有 ❌**：定位漂移的接缝，**修评测工具适配器**（不是产品），重跑探针直到全 ✅。

常见漂移与修法（都在 OC-Harness-eval 仓库内改）：

| 漂移接缝 | 评测工具侧位置 | 修法 |
| --- | --- | --- |
| Host API 请求/响应字段、路径、lastRun 语义 | `src/core/optracall-driver.ts` | 对照当前产品 `src/host/server.ts` 更新客户端 |
| Host 启动参数 / host-ready 输出 | `optracall-driver.ts` `startOptraCallHost` | 对照 `scripts/start-host.mjs`、`src/host/main.ts` |
| Host flag 改名/移除 | `src/core/optracall-capabilities.ts` `CAPABILITIES` | 对照 `src/host/main.ts` 更新 disableFlag |
| 取证工具名/参数 | `optracall-capabilities.ts` | 对照 `src/agent/project-session.ts` 工具定义 |
| SAP save/publish 响应形状 | `optracall-capabilities.ts` `seedSapMethods` | 对照 `extensions/business-plugins/metric-factory/methods/store.ts` |
| Case 存储 schema/迁移/origin 校验 | `src/core/optracall-memory.ts` | 对照 `src/host/case-store.ts`（最脆弱，仔细核对表结构与字段校验） |
| native 会话 JSONL 格式 | `src/core/optracall-evidence.ts` `parseNativeSession` | 对照 Pi SDK 会话格式（SDK 升级时） |
| 任务-Case 绑定修订 | `optracall-execution.ts` bindCase 段 | 对照 `prepareTaskContext` |

修复纪律：
- 每次只改评测工具，改完重跑 `eval-align.ts` 验证。
- 修不动或根源在产品侧 → 停下，向用户说明哪个接缝断、产品改了什么、是否需要产品侧配合（不擅自改产品）。
- 不削弱评测判据来「凑适配」；适配是修接缝，不是放宽判分。

## S3 告知就绪

全 ✅ 后向用户报告：
- 评测工具已与当前 OptraCall 产品（commit `<短哈希>`）对齐。
- 若做了修复，列出改了哪些接缝。
- 提示用户可发起测评：skill 用 `/skill-eval-flow`，知识/记忆能力用 `/capability-eval-flow`。

## 异常速查

| 现象 | 处理 |
| --- | --- |
| Node < 25 | 向用户取得 node25+ 路径 |
| checkout 缺 node_modules | 提示先在 checkout 跑 `npm ci` |
| 探针某接缝 FAIL | 按 S2 修评测工具适配器，重跑 |
| 根源在产品侧 | 停下说明，不擅自改产品 |
| npm run check 失败 | 先修评测工具单测，再跑探针 |