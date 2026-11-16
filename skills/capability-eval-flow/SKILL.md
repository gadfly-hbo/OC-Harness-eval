---
name: capability-eval-flow
description: 在 OptraCall 产品环境里用「装/不装」对照测评知识/记忆类能力（memory 跨事项经验 / SAP 分析方法）。唯一变量是能力开关（Host flag），处理侧注入合成 Fixture，冻结后执行、行为取证、按门禁下结论。
agent_created: true
---

# capability-eval-flow — OptraCall A 族能力评估状态机

编排 `skill-eval capability-eval` CLI，把「评估某个知识/记忆能力是否有用」跑成五状态工作流。
本 skill 只做编排：确定性检查交给脚本，实验执行交给 CLI，AI 判断只在生成套件（S2）与解读报告（S4）。

测评在 **OptraCall 产品环境**里进行：两侧都经正常任务入口。唯一变量是能力有无——baseline 侧 Host 带 disable flag，treatment 侧不带 + 注入合成 Fixture。两侧 codeRoot 逐字节一致。

## 支持的能力

| capability | Host flag | 取证工具 | 成功使用判据 | Fixture |
| --- | --- | --- | --- | --- |
| `memory` | `--disable-experience-learning` | `read_case_sources` | find/read 成功 | Case 判断卡片 |
| `sap-method` | `--disable-sap-methods` | `read_semantic_context` | 读到 sap-method 目标 | 已发布分析方法 |

> SAP 是共享工具仅禁 sap-method 内容，故须真正读到方法才算使用（find 空结果不算）；memory 工具整体禁用，find 成功即算。

## 正式测评边界

两侧执行同一份冻结计划，同题集、模型、轮数、判据。正式分数以固化版本报告为准。Qoder 只评价被测能力，不改测评器、不替换冻结判据、不另行计分、不自行重跑。执行受阻保留产物，原样报告退出状态、错误、证据路径。

## 用户怎么用

1. 指明 OptraCall checkout 路径、要测的能力（memory/sap-method）与套件。
2. 调用 `/skill:capability-eval-flow` 或说「测 SAP 方法能力」/「跑 memory 测评」。
3. 确认题集、重复、评委轮数；真实运行产生费用，开跑前确认规模。

## 全局规则

1. **失败即数据**：失败/超时/空输出计入分母，禁止选择性重跑。
2. **失败要留痕**：保留产物，报错原文呈现，不静默吞掉。
3. **断言先于结果**：生成套件不看运行输出。
4. **真实运行**：结论来自真实模型调用，不用静态/回放冒充。
5. **查读 ≠ 用好**：成功使用率与相对增益分别报告。
6. **不改真实产品**：只读使用 OptraCall；Fixture 只注入评测 dataRoot，绝不写真实 `~/.optracall`。

## 正式测评参数

| 参数 | 默认值 |
| --- | --- |
| 被评模型 | `minimax-cn/MiniMax-M3.1-Flash` |
| 评委模型 | `xiaomi-token-plan-cn/mimo-v2.6-flash` |
| pi 隔离 HOME | `~/.skill-eval/pi-home` |
| Host 解释器 | Node 25+（不足用 `--optracall-node`） |
| 运行目录 | `runs/<run-id>/` |

## 隔离边界（必须说明）

OptraCall 正常任务非 OS 沙箱。隔离靠独立评测根、每次 attempt 全新项目、Fixture 只注入评测 dataRoot。评测 Host 独立实例（临时端口），不连接/停止/修改用户运行中的服务。

---

## S0 收集输入

- 确认 checkout 路径与 capability（memory/sap-method）。
- 套件须声明 `optracall.capability` + `capabilityFixtures`。现成：`optracall-memory-smoke.json`、`optracall-sap-smoke.json`。
- 确认规模：矩阵 = `任务数 × repeat × 2` 被评 + `任务数 × repeat × judgeRepeat` 评委。真实运行获授权后进 S1。

## S1 环境自检

```bash
node --experimental-strip-types src/cli/main.ts preflight \
  --model minimax-cn/MiniMax-M3.1-Flash --judge-model xiaomi-token-plan-cn/mimo-v2.6-flash \
  --home ~/.skill-eval/pi-home
```
预检失败→停止。确认 Node 25+。

## S2 套件就绪

### 从用户方向到规范套件（草拟 → 确认 → 再跑）

实操中用户通常只简要说明测评方向，不直接写套件。按此协作流程：

1. **用户给方向**：简要说明测哪个能力（memory/sap-method）、业务场景、想验证什么。
2. **Agent 草拟规范套件**：按《案例与prompt编写指南》（`docs/案例与prompt编写指南.md`）把方向扩写成规范套件——任务 prompt（需要该能力的情境＋冻结交付物）、Fixture（方法正文/历史经验）、断言（行为约束）、边界/诊断题、合成数据与自洽真值。参考 `suites/examples/sap-method-conversion.json`、`suites/examples/memory-stockout.json`。
3. **呈现确认**：把草拟的 prompt、Fixture、断言、矩阵规模展示给用户，请其确认或调整。**用户未确认不跑。**
4. **确认后冻结**：用户确认 → 冻结套件 → 进 S3。

用户也可直给现成套件路径，跳过草拟直接进冻结。

### 套件要点

- 任务创造「需要该能力」的情境，冻结交付文件名（`deliverablePath`）。
- Fixture：memory 用 `{caseTitle, judgment:{kind,title,statement}}`；sap-method 用 `{title, content:{conditions,logic,judgment,limits}}`。设计正例与干扰项。
- 断言检验能力使用行为约束，非措辞。私有真值存 `.local/`。
- 断言先冻结；G1 冻结 Fixture 哈希、题集、模型、轮数、阈值入 `run-manifest.json`。

## S3 对照评估

```bash
node --experimental-strip-types src/cli/main.ts capability-eval \
  --suite <套件.json> --optracall <checkout> \
  --model minimax-cn/MiniMax-M3.1-Flash --judge-model xiaomi-token-plan-cn/mimo-v2.6-flash \
  --home ~/.skill-eval/pi-home --repeat <N> --judge-repeat <N>
```
CLI 自动准备双环境、处理侧注入 Fixture、baseline 关能力、走正常入口、取证、盲评、生成报告。`memory-eval` 是别名。

## S4 解读报告

读 `REPORT.md` + `summary.json`。重点：
- **能力使用表**：激活率＝成功使用率；取证在 `cases/treatment/<task>/<attempt>/optracall/memory.json`（consulted/find/read）。baseline 应 consulted=false。
- **判定表**：规则纠偏胜率、覆盖率/下界、断言通过率。
- **增益区间**：任务等权增益 + 95% Hoeffding 区间；跨 0＝证据不足。
- **分歧/费用/未验证项**：分别列。
- 摘要下「指标怎么读」大白话表直接给用户看。

## 异常速查

| 现象 | 处理 |
| --- | --- |
| 预检失败 / 套件非能力格式 | 停止 |
| Node < 25 | 取 `--optracall-node` |
| Case 存储/方法库初始化失败 | 停批保全证据 |
| 单样本失败/超时 | 计入分母继续 |
| Host 退出/环境漂移 | 停批 |
| 结论不足 | 如实交付 inconclusive |

## 离线端到端验证（无费用）

```bash
node --experimental-strip-types scripts/optracall-capability-integration.ts \
  --checkout <checkout> --node <node25+> --capability memory   # 或 sap-method
```