---
name: skill-eval-flow
description: 在 OptraCall 产品环境里测评 Agent Skill 的真实激活与增益。两侧走 OptraCall 正常任务入口，唯一变量是目标 skill 是否可用；冻结后执行、分层判分、按门禁下结论。
agent_created: true
---

# skill-eval-flow — OptraCall 产品环境 Skill 评估状态机

编排 `skill-eval` CLI，把「评估一个 SKILL.md」跑成一个五状态工作流。
本 skill 只做编排：确定性检查交给脚本，实验执行交给 CLI，AI 判断只出现在两处——
生成套件（S2）与解读报告（S4）。

测评在 **OptraCall 产品环境**里进行：两侧都经过 OptraCall 的正常任务入口（Host HTTP → 统一会话层 → Pi SDK），
带着产品的系统提示、业务工具与交付流程。唯一变量是目标 skill 是否可用——两份 codeRoot 除目标 skill 包外逐字节一致，
基线侧物理移除该 skill。裸 Pi 会话测不出产品上下文里的效果，本入口不跑裸 Pi。

## 正式测评边界

两侧执行同一份冻结计划，使用同样的题集、模型、轮数和判据。正式分数与判定以固化版本生成的报告为准。Qoder 只评价被测 Skill，核对原始证据是为了确认候选问题和给出修改建议。正式测评中不得质疑或修改测评器、替换冻结判据、另行计分或自行重跑。测评器复盘和升级单独授权。

Qoder 对候选文件的直接操作限于静态审阅，包括候选自带的检查脚本。候选侧 Agent 在 OptraCall 任务会话内自主使用工具。

执行受阻时保留已有产物，原样报告命令退出状态、错误和证据路径。缺失或失败记录按工具给出的状态交付，候选问题仅按已核实的证据归因。

## 用户怎么用

1. 指明被测 skill（OptraCall `extensions/analysis-assets/<skillName>`）与 OptraCall checkout 路径。
2. 调用本 skill：`/skill:skill-eval-flow` 或说「评估这个 skill」。
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
5. **激活 ≠ 有用**：激活率与相对增益分别报告，不能只报好看的那个。

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

OptraCall 正常任务**不是 OS 沙箱**：worker 以用户权限运行，010 禁读是提示词软约束。
评测隔离依靠独立评测根（codeRoot/dataRoot/projectsRoot 与用户真实数据完全分离）、每次 attempt 全新项目、
基线物理移除 skill、污染取证。评测 Host 是独立实例（临时端口），不连接、不停止、不修改用户运行中的试用服务。
报告须注明该边界与裸 Pi 受控会话的差异。

---

## S0 收集输入

### 0.1 定位被测 skill 与 checkout

- 确认 OptraCall checkout 路径，目标 skill 位于 `extensions/analysis-assets/<skillName>/SKILL.md`。
- 套件须声明 `optracall` 段（`skillName`、可选 `templateDir`）。缺少 checkout 或 skill 不存在 → 停止并报错。
- 读取候选 `SKILL.md` 与随包参考资料，理解其行为契约（用于 S2 生成有区分度的断言）。

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
- `LOCAL_MODEL_IDENTITIES_CONFIRMED` 只表示本地身份可解析；远端鉴权、计费与真实调用授权仍未验证。

## S2 套件就绪

### 生成或选择套件

- 套件面向 OptraCall 产品环境：任务文本冻结交付文件名（如 `060_reports/analysis.md`），`deliverablePath` 指向它。
- 初始资料模板放 `templateDir`（`010_draw`/`020_clean` 平铺文件），两侧完全一致。
- 断言检验 skill 声称的**行为约束**，不是措辞风格；负向断言往往更有区分度。
- 写不出有区分度的断言 → 该用例标 `diagnostic`，不计胜率。
- 私有真值与隐藏断言存 `.local/`，不进入项目目录、模板或 skill 可读路径。

### 判据冻结纪律

断言必须先于观察结果冻结。同一计划复评时复用原冻结版本和哈希；判据有修订时另存版本并用于新计划，旧运行按原判据保留。

### G1 冻结执行范围

开跑前冻结候选整包哈希、题集、模型、`repeat`、`judgeRepeat`、评委种子与阈值，写入 `run-manifest.json`（含 `optracall` 段：源 commit、SDK 身份、环境哈希、模板哈希、配置身份，不含 apiKey）。
独立计分题数决定结论上限：题量不足时置信区间跨零，结论保持 `inconclusive`，不靠复制题目或放宽门槛制造显著性。
用户已授权真实运行且范围明确时，展示预览后进入 S3。

## S3 对照评估

```bash
node --experimental-strip-types src/cli/main.ts eval \
  --suite <套件.json> \
  --optracall <checkout> \
  --model minimax-cn/MiniMax-M3.1-Flash \
  --judge-model xiaomi-token-plan-cn/mimo-v2.6-flash \
  --home ~/.skill-eval/pi-home \
  --repeat <N> --judge-repeat <N>
```

- CLI 自动准备双环境、走正常任务入口、采集 native 会话与交付物、跑冻结评委轮次、生成报告。
- Agent 在任务会话内自主决定方法、工具与纠错；Host 不提前强停。单样本终态失败记失败继续；Host 级故障（进程退出、环境漂移、持久化失败）停批保全证据。
- 完成后进入 S4。

## S4 解读报告

读 `<运行目录>/REPORT.md` 与 `summary.json`，呈现 `REPORT.md`。分别说明：

- **激活表**：每个 variant 的激活率与取证方式（native 会话读取路径命中 skill 包 = 强激活；关键词弱证据单列）；正向激活与负向误触发各列命中数/运行数。
- **判定表**：`winRate`、规则纠偏后 `ruleAdjustedWinRate`、`scoredJudged`/`totalScoredPairs`、断言通过率（写明通过数/条目数及计分或诊断范围）。
- **评委标签与 A/B 换位**：`rawVerdict` 只表示匿名展示时 B 相对 A 的结果；`rawVerdict: "win"`、`swapped: true`、`verdict: "loss"`、`labelConflict: null` 表示未发生标签冲突。仅将 `pairwise[].judgeRuns[]` 中非空的 `labelConflict` 计作标签冲突。
- **分歧记录**：规则断言与评委不一致处分别列数。
- **增益与区间**：任务等权配对增益与保守 95% Hoeffding 区间（独立任务为统计单位）；原始评委胜率的 Wilson 区间仅作描述。
- **交付与状态**：冻结用例指定文件时，核对其相对路径和 `deliverable.md` 评分副本，否则核对 `output.md`；引用状态行的实际位置及冻结要求，分别说明文件存在、位置合规和正文满足契约的证据。聊天自述只作过程记录。
- **费用**：SDK 估计、保守等价上界、现金账单未知，三口径分开。
- **补充诊断**：单列输入、是否含诊断题和通过数/断言条目数。

确认 Skill 需要修改时，转交 OptraCall：失败证据、修改的文件或段落、改成什么行为、用哪条断言或用例验收。只有证据确认候选违反要求时，才给 Skill 改写建议；归因仍需候选违反冻结要求的证据。

### 未通过时必须传达优化建议

报告第 8 节按失败模式给出可执行建议。原样传达，不改写冻结判据，不自行重跑。

## 异常速查

| 现象 | 处理 |
|---|---|
| 预检失败 | 保留错误并停止，不创建运行目录 |
| 套件校验不通过 | 保留错误并停止，不启动会话 |
| Node < 25 | 取得 `--optracall-node` 路径，否则停止 |
| 单样本失败/超时 | 计入分母，继续其余独立样本 |
| Host 退出/环境漂移/持久化失败 | 停批，保全首因与未运行项 |
| 结论不足 | 如实交付 `inconclusive`，不放宽门槛 |

## 阴性对照（用户选择消融时执行）

剥离行为契约生成破坏版，独立运行同套件，再离线核验区分度：

```bash
node --experimental-strip-types src/cli/main.ts verify --generate-broken <SKILL.md> --out <破坏版目录>
# 对破坏版跑完同一套件后执行：
node --experimental-strip-types src/cli/main.ts verify --original <原版运行目录> --broken <破坏版运行目录>
```

原版须分别优于基线和消融版，且满足事先冻结的核验规则，才能把改善归因于被移除的契约。身份或证据不可比时保留结论不足。