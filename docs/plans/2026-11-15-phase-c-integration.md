# Phase C · OptraCall 测评范围决定

日期：2026-11-15 起草，2026-11-16 更新。状态：**范围已定——仅保留 skill 与 memory 测评**。

## 范围决定（用户裁定）

| 测评 | 状态 |
| --- | --- |
| **skill** | 保留。OC-Harness-eval 主流程，已在 OptraCall 环境跑通。 |
| **memory** | 保留。`evaluators/memory`，接入 OptraCall 环境进行中（见 [c1-memory-contract](2026-11-15-c1-memory-contract.md)）。 |
| **prompt-ir** | **删除，后续不做**。`evaluators/prompt-ir` 已移除（git 历史可恢复）。 |
| **tool-usage** | **删除，后续不做**。原仓库已移入废纸篓。 |

## prompt-ir 删除原因（存档）

prompt-ir 是回放式 SAP 方法测评器，其 RECORDED_REPLAY 判「采用」要求 OptraCall 的 `read_semantic_context` 回执带 `details.type === 'ir-eval.analysis-proof'`。调查确认该插桩在 OptraCall **全历史从未实现**（`git log -S "ir-eval.analysis-proof" --all` 零命中，连设计参照的旧 commit 85d8b2e 也没有）。完整接入需先改 OptraCall 产品源码建插桩——而用户已裁定**禁止改动 OptraCall 真实产品**（见 AGENTS.md 红线）。两者叠加，prompt-ir 无法在红线内接入；用户决定删除、不再做。

## 后续

仅推进 memory 测评接入（C1）。所有测评遵守红线：只读使用 OptraCall 产品，不改源码、不写真实数据根、不碰运行中服务。