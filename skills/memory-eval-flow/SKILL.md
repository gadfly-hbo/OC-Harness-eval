---
name: memory-eval-flow
description: 在 OptraCall 产品环境里测评 Agent 的跨任务记忆使用能力。两侧走 OptraCall 正常任务入口，唯一变量是 read_case_sources 记忆能力是否可用；处理侧注入合成记忆 Fixture，冻结后执行、行为取证、按门禁下结论。
agent_created: true
---

# memory-eval-flow — OptraCall 产品环境记忆评估状态机

编排 `skill-eval memory-eval` CLI，把「评估 Agent 记忆使用能力」跑成一个五状态工作流。
本 skill 只做编排：确定性检查交给脚本，实验执行交给 CLI，AI 判断只出现在两处——
生成套件（S2）与解读报告（S4）。

测评在 **OptraCall 产品环境**里进行：两侧都经过 OptraCall 的正常任务入口（Host HTTP → 统一会话层 → Pi SDK）。
唯一变量是 `read_case_sources`（M6 跨事项经验）记忆能力是否可用——baseline 侧 Host 带 `--disable-experience-learning`（工具不挂载），
treatment 侧不带该 flag 且注入合成记忆判断卡片。两侧 codeRoot 逐字节一致，差异只在 Host flag 与记忆 Fixture。

## 正式测评边界

两侧执行同一份冻结计划，使用同样的题集、模型、轮数和判据。正式分数与判定以固化版本生成的报告为准。Qoder 只评价被测的记忆使用行为，核对原始证据是为了确认问题和给出修改建议。正式测评中不得质疑或修改测评器、替换冻结判据、另行计分或自行重跑。测评器复盘和升级单独授权。

执行受阻时保留已有产物，原样报告命令退出状态、错误和证据路径。缺失或失败记录按工具给出的状态交付，问题仅按已核实的证据归因。

## 用户怎么用

1. 指明 OptraCall checkout 路径与记忆测评套件（或用现成的 `suites/optracall-memory-smoke.json`）。
2. 调用本 skill：`/skill:memory-eval-flow` 或说「跑 memory 测评」。
3. 确认题集、重复次数与评委轮数；真实运行会产生费用，开跑前确认规模。

## 环境适配（先读）

本 skill 遵循 Agent Skills 规范，可被任何实现了该规范的 agent 加载。
指令中出现的宿主能力名按以下规则降级：

| 指令中的能力 | WorkBuddy | 其他 agent |
|---|---|---|
| 询问用户 | `AskUserQuestion` 工具 | Qoder 等宿主有同类工具时复用，否则直接用自然语言提问 |
| 后台执行长命令 | `run_in_background` | 前台执行并等待，按已完成会话报告进度 |
| 呈现报告文件 | `present_files` | 在回复中给出报告文件的绝对路径 |

不确定宿主是否支持某能力时，选降级方案，不要因为工具不存在而中断流程。

## 全局规则（任何状态都必须遵守）

1. **失败即数据**：单次运行失败、超时、空输出都计入分母，禁止选择性重跑。
2. **失败要留痕**：任何状态失败都保留已有产物，把报错原文呈现给用户，不静默吞掉。
3. **断言先于结果**：生成套件时不看任何运行输出，避免自证。
4. **真实运行**：所有结论必须来自真实模型调用，不用静态检查或回放冒充。
5. **查读 ≠ 用好**：记忆成功查读率与相对增益分别报告，不能只报好看的那个。
6. **不改真实产品**：只读使用 OptraCall（复制 checkout、独立实例、既有 flag）；Fixture 只注入评测 dataRoot，绝不写真实 `~/.optracall`。

## 正式测评参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| 被评模型 | `minimax-cn/MiniMax-M3.1-Flash` | v1 固定为该精确身份（受控成本 profile） |
| 评委模型 | `xiaomi-token-plan-cn/mimo-v2.6-flash` | 与被评模型不同 provider，避免自我偏好 |
| pi 隔离 HOME | `~/.skill-eval/pi-home` | 读取被评模型凭据；不触碰用户真实 `~/.optracall` |
| OptraCall checkout | 用户指定 | 产品源码来源，环境准备只读复制 |
| Host 解释器 | 当前解释器（须 Node 25+） | 不足时用 `--optracall-node` 指定 |
| 运行目录 | `runs/<run-id>/` | 套件、产物、报告、评测环境都在这里 |

## 隔离边界（必须向用户说明）

OptraCall 正常任务**不是 OS 沙箱**：worker 以用户权限运行。评测隔离依靠独立评测根（codeRoot/dataRoot/projectsRoot 与用户真实数据完全分离）、每次 attempt 全新项目、记忆 Fixture 只注入评测 dataRoot。评测 Host 是独立实例（临时端口），不连接、不停止、不修改用户运行中的试用服务。

---

## S0 收集输入

### 0.1 定位 checkout 与套件

- 确认 OptraCall checkout 路径。
- 套件须声明 `optracall.capability="memory"` 与 `optracall.memoryFixtures`（合成判断卡片：caseTitle + judgment{kind,title,statement}）。
- 现成冒烟套件：`suites/optracall-memory-smoke.json`。缺少 checkout 或套件不合 memory 格式 → 停止并报错。

### 0.2 确认规模

- 与用户确认独立任务数、每侧重复 `repeat`、评委轮数 `judgeRepeat`（≥2 启用位置偏好探测）。
- 完整矩阵 = `任务数 × repeat × 2` 被评会话 + `任务数 × repeat × judgeRepeat` 评委会话。
- 真实运行产生费用：展示模型、规模与预估会话数，获得授权后进入 S1。

## S1 环境自检

运行只读预检，不创建运行目录、不调用 Provider：

```bash
node --experimental-strip-types src/cli/main.ts preflight \
  --model minimax-cn/MiniMax-M3.1-Flash \
  --judge-model xiaomi-token-plan-cn/mimo-v2.6-flash \
  --home ~/.skill-eval/pi-home
```

- 预检未通过（模型身份不可解析）→ 保留错误并停止，不启动任何会话。
- 确认 Host 解释器 Node 25+；不足时取得 `--optracall-node` 路径。

## S2 套件就绪

### 从用户方向到规范套件（草拟 → 确认 → 再跑）

实操中用户通常只简要说明测评方向，不直接写套件。按此协作流程：

1. **用户给方向**：简要说明业务场景、想验证记忆使用的哪方面（检索/参考/抗干扰）。
2. **Agent 草拟规范套件**：按《案例与prompt编写指南》（`docs/案例与prompt编写指南.md`）把方向扩写成规范套件——历史经验 Fixture（带条件与不确定性＋干扰项）、新任务 prompt（需回忆相关经验＋冻结交付物）、断言（行为约束）、零调用诊断题、合成数据。参考 `suites/examples/memory-stockout.json`。
3. **呈现确认**：把草拟的经验 Fixture、prompt、断言、矩阵规模展示给用户，请其确认或调整。**用户未确认不跑。**
4. **确认后冻结**：用户确认 → 冻结套件 → 进 G1/S3。

用户也可直给现成套件路径，跳过草拟直接进冻结。

### 生成或选择套件

- 任务文本应创造「需要历史记忆」的情境（如「先查阅是否有相关历史判断，再给出核查思路」），冻结交付文件名（`deliverablePath`，如 `060_reports/analysis.md`）。
- `memoryFixtures` 设计正例（相关有效判断）与干扰项（无关/过期/冲突/越权），用于测边界处理。
- 断言检验记忆使用**行为约束**（区分判断/执行/效果、注明未做因果检验、不被记忆当作已证实结论），不是措辞风格。
- 私有真值与隐藏断言存 `.local/`，不进入项目目录或 Fixture 可读路径。

### 判据冻结纪律

断言必须先于观察结果冻结。同一计划复评复用原冻结版本和哈希；判据修订另存版本用于新计划，旧运行按原判据保留。

### G1 冻结执行范围

开跑前冻结 Fixture 包哈希、题集、模型、`repeat`、`judgeRepeat`、评委种子与阈值，写入 `run-manifest.json`（含 `optracall` 段：源 commit、SDK 身份、环境哈希、配置身份、capability=memory，不含 apiKey）。
独立计分题数决定结论上限：题量不足时置信区间跨零，结论保持 `inconclusive`。
用户已授权真实运行且范围明确时，展示预览后进入 S3。

## S3 对照评估

```bash
node --experimental-strip-types src/cli/main.ts memory-eval \
  --suite <套件.json> \
  --optracall <checkout> \
  --model minimax-cn/MiniMax-M3.1-Flash \
  --judge-model xiaomi-token-plan-cn/mimo-v2.6-flash \
  --home ~/.skill-eval/pi-home \
  --repeat <N> --judge-repeat <N>
```

- CLI 自动准备双环境（codeRoot 全等）、处理侧初始化 Case 存储并注入 Fixture、baseline 关闭记忆能力、走正常任务入口、采集 native 会话与交付物、跑冻结评委轮次、生成报告。
- Agent 在任务会话内自主决定是否检索记忆、检索什么、如何使用；Host 不提前强停。单样本终态失败记失败继续；Host 级故障停批保全证据。
- 完成后进入 S4。

## S4 解读报告

读 `<运行目录>/REPORT.md` 与 `summary.json`，呈现 `REPORT.md`。分别说明：

- **记忆查读表**：每个 variant 的记忆成功使用率（激活率）。取证来自 `cases/<variant>/<task>/<attempt>/optracall/memory.json`：`consulted`（成功 find/read）、`findCalls`/`successfulFindCalls`、`readCalls`/`successfulReads`、`readTargets`。baseline 应 consulted=false（能力关闭）；工具不可用时的失败尝试不算成功使用。
- **判定表**：`winRate`、规则纠偏后 `ruleAdjustedWinRate`、`scoredJudged`/`totalScoredPairs`、断言通过率。
- **评委标签与 A/B 换位**：`rawVerdict` 只表示匿名展示时 B 相对 A 的结果；仅将 `pairwise[].judgeRuns[]` 中非空的 `labelConflict` 计作标签冲突。
- **分歧记录**：规则断言与评委不一致处分别列数。
- **增益与区间**：任务等权配对增益与保守 95% Hoeffding 区间（独立任务为统计单位）。
- **交付与状态**：核对冻结交付文件与 `deliverable.md` 评分副本；聊天自述只作过程记录。
- **费用**：SDK 估计、保守等价上界、现金账单未知，三口径分开。

确认记忆使用有问题时，按证据归因（检索决策/相关性选择/正确使用/来源可信度/过期冲突/干扰抵抗），给出修改建议；只有证据确认候选违反要求时才归因。

### 未通过时必须传达优化建议

报告第 8 节按失败模式给出可执行建议。原样传达，不改写冻结判据，不自行重跑。

## 异常速查

| 现象 | 处理 |
|---|---|
| 预检失败 | 保留错误并停止，不创建运行目录 |
| 套件非 memory 格式 | 保留错误并停止（memory-eval 需 capability=memory + memoryFixtures） |
| Node < 25 | 取得 `--optracall-node` 路径，否则停止 |
| Case 存储未初始化 | CLI 自动初始化；失败则停批保全证据 |
| 单样本失败/超时 | 计入分母，继续其余独立样本 |
| Host 退出/环境漂移/持久化失败 | 停批，保全首因与未运行项 |
| 结论不足 | 如实交付 `inconclusive`，不放宽门槛 |

## 离线端到端验证（无费用）

```bash
node --experimental-strip-types scripts/optracall-memory-integration.ts --checkout <checkout> --node <node25+>
```

用本地假 Provider（首轮调 read_case_sources find、次轮返回文本）验证：处理侧注入的判断卡片被查读、consulted=true；基线能力关闭、consulted=false。