# Phase C · memory / prompt-ir 接入 OptraCall 测试环境 · 契约草案

日期：2026-11-15。状态：**C2 暂缓（产品插桩阻塞），转 C1 memory**。真实运行未授权。

> **C2 阻塞结论（2026-11-15 调查）**：prompt-ir 的 RECORDED_REPLAY 判「采用」要求 `read_semantic_context` 回执带 `details.type === 'ir-eval.analysis-proof'`。当前 OptraCall 的 semantic-context 回执 details 为 `optracall.analysis-sources-recorded`/`SemanticQueryResult`/`SemanticGraphResult`，无 analysis-proof；`git log -S "ir-eval.analysis-proof" --all` 全历史零命中（连 prompt-ir 设计参照的旧 commit 85d8b2e 也没有）。即该插桩**从未在 OptraCall 落地**。完整 C2 需先在 OptraCall 建插桩（产品改动，走 OptraCall 工程流程并单独授权）；降级接入（adoption 标 UNKNOWN）会丢掉 prompt-ir 核心采用维度。用户裁定：**转 C1 memory 先**，C2 待产品插桩授权。C1 契约见 [c1-memory-contract](2026-11-15-c1-memory-contract.md)。

## 目标

让 memory 与 prompt-ir 两类测评都在 OptraCall 产品环境里执行，复用已跑通的 OptraCall 后端（双环境、正常任务入口、native 取证）与计分引擎。两类测评的唯一变量不同，判分也不同——不是套用 skill 流程，而是把后端扩成通用 harness。

## 共用底座（已具备）

- `optracall-env.ts`：双 codeRoot/dataRoot/projectsRoot，唯一变量哈希核验。
- `optracall-driver.ts`：正常任务入口 HTTP 驱动。
- `optracall-evidence.ts`：native JSONL → 指标/事件/读取取证。
- `optracall-execution.ts`：复合执行层（subject 走 OptraCall，judge 走受控 Pi）。
- 计分引擎：runner/verdict/gain/stats/assertions/judge。

需要扩展：唯一变量从「skill 包有无」推广到「某能力开关」；取证从「skill 读取」推广到「能力调用与采用」。

## C1 · memory eval（新建）

- **决策问题**：Agent 面对新任务能否判断需要历史记忆、找到相关且有效的记忆、正确理解来源/范围/可信度/时效并恰当使用，且不被无关/过期/冲突/越权记忆干扰。
- **唯一变量**：记忆能力可用与否。OptraCall 开关 `experienceLearningEnabled`（M6 `read_case_sources`）与 M4 `personalContext`（`find_personal_context`/`read_personal_context`）。基线侧关闭，处理侧开启并注入冻结的合成记忆 Fixture。
- **判据**（行为取证为主，不是交付物质量）：检索决策（该查才查）、相关性选择、正确使用、来源/可信度识别、过期冲突处理、无关记忆干扰。需要 native 会话里的记忆工具调用轨迹 + 采用证据。
- **复用**：OptraCall 后端跑两侧 + 引擎计分；记忆 Fixture 与真值放 `.local/`。
- **新建工作量**：记忆开关接入后端、记忆行为取证器、Fixture 与判据设计、套件。建设方案见 `evaluators/memory/OptraCall_Memory_Eval_轻量化产品建设方案_v0.1.md`（首期 12 案例、Mock/Fixture、读取与使用为主、写入后置）。

## C2 · prompt-ir 接入（补档案生成侧）

- **决策问题**：SAP 方法版本的数值正确性与适用边界、Agent 查读与正确采用、同条件配对差异。
- **唯一变量**：目标 SAP 方法版本可用与否。OptraCall 开关 `sapMethodsEnabled` / 方法库中目标方法的有无；基线目录不含目标方法，处理侧含。
- **现状**：`evaluators/prompt-ir` 已是完整的回放式测评器（冻结→回放→核验→归档），消费录制档案（native Pi v3 JSONL + 采用证据 `adoption.callHash/eventHash` + `ir-eval.analysis-proof` + 方法侧独立推演）。**缺 live 档案生成**。
- **接入接缝**：新建「档案生成适配器」——用 OptraCall 后端跑任务（方法可用/不可用），把 native 会话 + Host 环境读回 + 采用证据导出为 prompt-ir 的 capture 格式（`<caseId>.method.json`/`baseline.json`/`treatment.json`），再交给 prompt-ir 回放判分。
- **关键对齐**：capture schema、有效分支限定、采用阶段绑定、方法侧独立审阅。prompt-ir 自身不做模型调用，模型调用发生在档案生成侧（OptraCall 后端）。
- **工作量**：档案生成适配器 + capture 格式对齐 + SAP 方法开关接入 + 方法侧审阅流程。真实 v1 正文与留出集仍需另行取得/授权。

##  sequencing 建议

- **C2 先**：prompt-ir 测评器已成熟，只补档案生成侧；能最快让一个非 skill 测评在 OptraCall 环境跑通，验证通用 harness 接缝。但 capture 格式对齐精细。
- **C1 后**：memory 是新建，需先定行为判据与 Fixture；后端能力开关推广在 C2 验证后更稳。

## 待确认

1. 起点：C2（prompt-ir 档案生成）还是 C1（memory 新建）？
2. 唯一变量开关方式：用 OptraCall Host 启动 flag（`--disable-sap-methods`/`--disable-experience-learning`）还是方法库/记忆 Fixture 的有无？
3. 真实运行授权与规模（模型调用产生费用）。
4. prompt-ir 真实 v1 方法正文与留出集来源（当前缺失，合成替身仅离线验收）。

## 授权边界

本阶段先做契约与离线接入；真实 Provider 调用、在线 SAP/记忆接入、正式留出测评另行授权。不修改被测方法/记忆本体；不改 OptraCall 产品代码（用既有开关与公开接口）。