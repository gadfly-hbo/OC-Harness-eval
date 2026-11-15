---
subtitle: Harness Evaluation Kit 独立评测模块 · v0.1
title: OptraCall Prompt Eval｜轻量化产品建设方案
---

# OptraCall Prompt Eval｜轻量化产品建设方案 v0.1

**文档类型：** 产品建设方案\
**版本：** v0.1\
**状态：** 方案评审稿\
**产品归属：** OptraCall Harness Evaluation Kit\
**评测维度：** Harness 八大维度中的 System Prompt\
**底层执行：** pi-coding-agent SDK\
**基础能力复用：** 现有 Skill Eval、Host、OptraCall SDK Adapter\
**首期范围：** Prompt 对 Agent 任务执行表现的影响评测，不包含自动 Prompt
优化

------------------------------------------------------------------------

## 0. 执行摘要

### 0.1 产品定位

Prompt Eval 是 OptraCall Harness Evaluation Kit
中一个可独立运行、独立验收的轻量化评测模块，专门评测 Prompt 对 Agent
任务执行表现的影响。

它回答的核心问题是：

> 同一个模型、同一个任务、相同的工具和 Skill，仅仅改变 Prompt，Agent
> 的任务理解、指令遵循、执行质量和最终交付是否得到改善？

Prompt Eval 不只是评价 Prompt
写得好不好，而是通过固定任务、模型和执行环境，对不同 Prompt
版本进行实际执行和对照评测。

本模块不建设新的 Agent Runtime、Prompt 管理平台、通用执行轨迹系统或 Host
基础设施。优先复用已有 Skill Eval 的任务加载、Runner、Session
执行、Trace、评分、结果存储和报告能力；通过 OptraCall SDK Adapter 使用
pi-coding-agent SDK 创建隔离测试 Session，并加载不同 Prompt 配置。

### 0.2 核心产品决策

1.  **独立模块：** Prompt Eval
    可以单独加载测试集、运行、评分、输出报告和验收。
2.  **复用底座：** 优先复用已有 Skill Eval 的 Runner、Session
    执行、Trace、评分、结果存储和报告能力；实际复用范围以代码审计结果为准。
3.  **复用 pi-sdk：** 通过当前锁定版本的公开 API 加载 Prompt、创建
    Session 和订阅执行事件，不修改 pi-sdk 内核。
4.  **评测对象：** Prompt 对 Agent
    任务理解、指令遵循、任务约束、输出交付和模糊信息处理的影响。
5.  **首期案例：** 建立 12
    个基础测试用例，覆盖任务理解、指令遵循、输出格式、模糊信息、范围控制和上下文干扰。
6.  **首期模式：** 支持单 Prompt 评测和 Prompt A/B 对照评测。
7.  **评测方式：** 确定性断言优先，LLM Judge
    辅助；关键失败作为硬门槛，不以单一综合分数掩盖问题。
8.  **建设顺序：** 先完成 P0 复用审计和 P1 基础
    MVP，再进入多轮任务、鲁棒性和 Harness Optimizer 对接。

### 0.3 与其他模块的关系

  --------------------------------------------------------------------------
  模块 / 系统                         主要职责
  ----------------------------------- --------------------------------------
  Skill Eval                          评测 Agent 是否有效运用专业 Skill

  Tool Usage Eval                     评测 Agent
                                      是否正确选择、调用和使用工具

  **Prompt Eval**                     评测 Prompt
                                      对任务理解、指令遵循和交付表现的影响

  pi-coding-agent SDK                 提供 Agent Runtime、Session 和 Prompt
                                      / 资源加载机制

  Host                                提供任务上下文、权限、Session
                                      关联和通用持久化

  Extension                           提供专业工具、分析资产和领域校验能力

  Harness Optimizer                   未来生成 Prompt 候选并组织优化；Prompt
                                      Eval 提供评测能力
  --------------------------------------------------------------------------

------------------------------------------------------------------------

## 一、产品定位与建设目标

### 1.1 什么是 Prompt Eval？

Prompt Eval 是一个专门评测 Prompt 对 Agent
任务执行表现影响的轻量化模块。

例如，OptraCall 接收到一个任务：

> 分析最近三个月会员复购率下降的原因，并给出经营建议。

Prompt A 可能让 Agent：

-   直接开始计算指标；
-   没有明确分析对象和时间范围；
-   忽略新客、老客的差异；
-   直接给出原因判断；
-   缺少证据和反证。

Prompt B 则可能要求 Agent：

-   先明确任务目标和分析边界；
-   确认指标口径和观察窗口；
-   按人群、商品、渠道等维度分析；
-   区分相关关系与因果关系；
-   结论必须有证据支撑；
-   对无法确认的原因明确说明不确定性。

两者使用同一个模型，但实际执行质量可能不同。

Prompt Eval 通过实验回答：Prompt B 是否真的比 Prompt A
更好，而不是仅仅看起来写得更完整。

### 1.2 核心建设目标

1.  评估不同 Prompt 版本对 Agent 任务表现的影响。
2.  识别 Prompt 在任务理解、指令遵循和约束执行方面的缺陷。
3.  支持 Prompt A/B 对照实验。
4.  识别 Prompt 修改带来的收益和回归。
5.  形成可追溯的 Prompt 版本评测记录。
6.  为未来 Harness Optimizer 自动生成和优化 Prompt 提供评测能力。

### 1.3 明确不做什么

Prompt Eval 不负责：

-   自动生成和优化 Prompt（后续由 Harness Optimizer 负责）；
-   建设 Prompt 管理平台；
-   建设新的 Agent Runtime；
-   重复建设 Skill Eval 的 Runner、评分和报告能力；
-   重复建设 Tool Usage Eval 的工具调用评测；
-   重复建设 Memory Eval 的记忆检索评测；
-   修改 pi-coding-agent SDK 内核；
-   修改 Host 的正式权限、治理和验收规则；
-   将所有任务的最终答案正确性都归因于 Prompt。

**Prompt Eval 的核心职责是评估 Prompt 对 Agent
行为的影响，而不是重新评测 Agent 的全部能力。**

------------------------------------------------------------------------

## 二、与 Skill Eval、Tool Usage Eval 的职责边界

三个模块都可能使用相同的任务、相同的 Agent
和相同的执行轨迹，但它们关注的对象不同。

  ----------------------------------------------------------------------------------
  模块                    核心问题                           评测对象
  ----------------------- ---------------------------------- -----------------------
  Skill Eval              Agent 是否有效运用了专业方法？     Skill

  Tool Usage Eval         Agent 是否正确使用工具？           Tool Usage / Tool
                                                             Guidance

  **Prompt Eval**         Agent                              Prompt
                          是否正确理解任务并遵循工作指导？   
  ----------------------------------------------------------------------------------

以会员复购分析为例：

  执行表现                       应由哪个模块评价
  ------------------------------ ----------------------------
  是否理解需要分析复购率下降     Prompt Eval
  是否遵循先确认指标口径的要求   Prompt Eval
  是否按照规定输出分析报告       Prompt Eval
  是否正确使用会员分析 Skill     Skill Eval
  是否正确使用 DuckDB 查询数据   Tool Usage Eval
  是否正确执行复购率计算方法     Skill Eval / 专业指标校验
  是否违反只读数据权限           Guardrail Eval / Host 治理

需要特别区分：

-   Prompt Eval 评价任务指令中的业务约束是否得到遵循。
-   Guardrail Eval 评价正式安全规则、权限和行为边界是否得到遵守。
-   Skill Eval 评价专业分析方法是否被正确执行。

例如，Prompt 要求"分析时排除取消订单"，属于 Prompt Eval；Host 规定"Agent
只能读取订单数据，不能修改订单"，属于治理与 Guardrail Eval。

不能因为 Prompt 写了只读要求，就认为 Host 的权限治理可以省略。

------------------------------------------------------------------------

## 三、Prompt Eval 的评测维度

建议将 Prompt 效果拆成六个维度。

  -------------------------------------------------------------------------------
  评测维度                核心问题                 主要评价内容
  ----------------------- ------------------------ ------------------------------
  1\. Task Understanding  是否正确理解任务？       目标、对象、指标、范围

  2\. Instruction         是否遵循指令？           必须做、应该做、禁止做
  Following                                        

  3\. Constraint          是否遵循任务约束？       时间、范围、条件、口径要求
  Compliance                                       

  4\. Output Compliance   是否满足交付要求？       格式、结构、内容、完整性

  5\. Ambiguity Handling  面对模糊任务如何处理？   是否澄清、是否合理假设

  6\. Scope & Assumption  是否控制任务边界？       是否过度扩展、是否无依据推断
  Discipline                                       
  -------------------------------------------------------------------------------

### 3.1 Task Understanding｜任务理解

评价 Agent 是否正确理解用户要解决的问题。

例如，用户要求分析"会员复购率下降"，Agent 是否能够区分：

-   分析对象是会员，而非全部用户；
-   研究的是复购率，而不是 GMV；
-   目标是寻找下降原因，而不是单纯描述趋势；
-   需要结合业务数据，而不是只给出行业常识。

核心是检查 Agent 是否抓住任务的真实目标。

### 3.2 Instruction Following｜指令遵循

评价 Prompt 中明确要求的行为是否被执行。

例如 Prompt 要求：

1.  先核验指标定义；
2.  再进行数据分析；
3.  结论必须引用证据；
4.  不得将相关关系直接表述为因果关系。

评测 Agent 是否遗漏、违反或错误理解这些指令。

### 3.3 Constraint Compliance｜任务约束遵循

评价 Agent 是否遵守 Prompt 中明确的任务条件。

例如：

-   时间范围限定为最近三个月；
-   分析范围仅限会员；
-   退款订单需要单独处理；
-   不允许自行扩大研究范围；
-   数据不足时不得强行得出结论。

这里评测的是任务级约束，不替代 Host 的正式权限治理。

### 3.4 Output Compliance｜输出交付符合度

评价最终结果是否符合 Prompt 规定的交付形式。

例如：

-   是否包含执行摘要；
-   是否包含关键发现；
-   是否包含数据证据；
-   是否包含原因分析；
-   是否包含经营建议；
-   是否按照指定表格或 JSON 格式输出。

这一维度适合大量使用确定性断言，减少主观评分。

### 3.5 Ambiguity Handling｜模糊任务处理

评价 Agent 面对信息不完整的任务时，是否作出合理处理。

例如，用户说：

> 分析最近会员复购率下降的原因。

但没有明确：

-   "最近"指多长时间；
-   复购率采用什么定义；
-   是否有对照周期。

Prompt 应指导 Agent
判断哪些信息可以通过已有上下文确认，哪些必须向用户澄清，哪些可以在明确假设后继续执行。

这里不能简单认为提问越多越好。

合理的行为应该是：

-   有必要的信息已经存在，就直接使用；
-   缺少关键口径且无法可靠推断，就澄清；
-   非关键细节可以采用明确假设继续执行。

### 3.6 Scope & Assumption Discipline｜范围与假设控制

评价 Agent 是否出现任务漂移和无依据推断。

例如：

-   用户要求分析复购率，Agent 却擅自扩展到全面营销战略；
-   数据只支持相关性，Agent 却断言因果关系；
-   缺少商品供给数据，却断言商品缺货是主要原因；
-   为了让报告完整而自行编造数据。

这个维度对 OptraCall 尤其重要，因为它的定位是分析与决策
Agent，而不是单纯的内容生成 Agent。

------------------------------------------------------------------------

## 四、测试用例设计

建议 v0.1 先建立 **12
个基础测试用例**，覆盖六个评测维度。不需要一开始建设大型 Prompt
Benchmark。

### 4.1 首期测试用例清单

  --------------------------------------------------------------------------------------------
  ID                测试场景          Agent 预期行为                         主要评测维度
  ----------------- ----------------- -------------------------------------- -----------------
  P01               简单任务理解      正确识别分析对象和目标                 Task
                                                                             Understanding

  P02               多重任务约束      同时遵循时间、对象和指标要求           Instruction
                                                                             Following

  P03               指定输出格式      按指定结构和字段交付                   Output Compliance

  P04               必须与禁止指令    执行 Must 指令，遵守 Must Not 要求     Instruction
                                                                             Following

  P05               同级指令冲突      识别冲突，合理处理或请求澄清           Instruction
                                                                             Following

  P06               关键条件缺失      缺少必要信息时提出澄清                 Ambiguity
                                                                             Handling

  P07               数据不足          明确证据不足，不编造原因               Scope &
                                                                             Assumption

  P08               任务范围限定      只完成用户要求的任务                   Scope &
                                                                             Assumption

  P09               多轮任务延续      正确沿用当前 Session 中已确认的口径    Task
                                                                             Understanding

  P10               条件分支指令      根据不同输入条件执行对应要求           Instruction
                                                                             Following

  P11               无关上下文干扰    优先使用相关上下文，不被无关内容干扰   Constraint
                                                                             Compliance

  P12               同义表达测试      对等价任务表述保持稳定的行为           Robustness
  --------------------------------------------------------------------------------------------

P12 的 Robustness 可以作为辅助评测维度，不必在 v0.1
单独建立完整的鲁棒性评测系统。

### 4.2 典型案例：P06 关键条件缺失

**测试任务：**

"帮我分析会员复购率下降的原因。"

**测试上下文：**

没有提供复购率定义，也没有提供历史确认过的指标口径。

**Prompt A：**

要求 Agent 尽可能直接完成任务。

**Prompt B：**

要求 Agent
在关键指标口径不明确、且无法从已有业务上下文确认时，先向用户澄清；不得自行编造定义。

**预期结果：**

Prompt B 应该能够引导 Agent
识别缺失的关键条件，并提出必要的问题，而不是自行选择一个定义。

**评测断言：**

-   是否识别指标定义缺失；
-   是否没有虚构已确认口径；
-   是否提出必要且具体的澄清问题；
-   是否避免无关问题。

这里不要求 Agent 一定使用某种固定措辞，只评价行为是否合理。

### 4.3 典型案例：P03 指定输出格式

**测试任务：**

"分析会员复购率变化，并按指定 JSON Schema 输出结果。"

预期结构：

``` json
{
  "summary": "",
  "key_findings": [],
  "evidence": [],
  "limitations": [],
  "recommendations": []
}
```

评测重点：

1.  是否能够输出合法 JSON；
2.  是否包含全部必需字段；
3.  字段类型是否正确；
4.  是否出现额外的非 JSON 内容；
5.  内容是否符合任务要求。

这类测试优先使用程序断言，而不是让 LLM 判断 JSON 是否规范。

### 4.4 典型案例：P07 数据不足

**测试任务：**

"根据当前提供的数据，判断会员复购率下降是否由商品缺货造成。"

**测试条件：**

提供会员复购数据，但没有提供商品库存、缺货记录或商品可售数据。

**预期行为：**

Agent 应说明现有证据不足以确认商品缺货是原因，并指出需要哪些补充数据。

不能因为 Prompt 要求给出原因，就强行生成一个看似完整的因果解释。

------------------------------------------------------------------------

## 五、评测指标体系

建议采用 **5 项核心指标 + 3 项辅助指标**。v0.1
不需要建立复杂的综合评分算法，重点是让每一个评测结果都能解释。

### 5.1 核心指标

  --------------------------------------------------------------------------
  指标                    计算方式                   评价内容
  ----------------------- -------------------------- -----------------------
  Task Understanding      正确识别的任务目标要素数 / 任务理解
  Accuracy                预期目标要素总数           

  Instruction Adherence   满足的有效 Must 指令数 /   指令遵循
  Rate                    有效 Must 指令总数         

  Constraint Compliance   满足的任务约束数 /         约束遵循
  Rate                    适用约束总数               

  Output Contract Pass    通过的输出断言数 /         输出符合度
  Rate                    输出断言总数               

  Ambiguity Handling      正确处理的模糊任务数 /     模糊信息处理
  Accuracy                模糊任务总数               
  --------------------------------------------------------------------------

某个案例不涉及模糊任务时，Ambiguity Handling 应标记为
N/A，而不是计为零分。

### 5.2 辅助指标

  ------------------------------------------------------------------------------
  指标                    计算或观察方式                 目的
  ----------------------- ------------------------------ -----------------------
  Scope Drift Rate        出现明显任务范围偏移的案例数 / 检查任务漂移
                          有效案例数                     

  Unsupported Assumption  出现无依据假设的案例数 /       检查无依据推断
  Rate                    有效案例数                     

  Execution Cost          Prompt Token、总               衡量成本
                          Token、耗时、重试次数          
  ------------------------------------------------------------------------------

另外，建议增加一个总览指标：

**Prompt Task Pass Rate**

定义：一个测试案例中，所有关键断言均通过，且没有关键失败的案例比例。

\[ PassRate=`\frac{通过的案例数}{有效案例总数}`{=tex} \]

### 5.3 不建议简单加权形成唯一总分

例如：

  Prompt     任务理解   指令遵循   输出符合 关键违规
  -------- ---------- ---------- ---------- ----------
  A                85         90         95 0
  B                90         95         92 1

虽然 B
的平均分可能更高，但如果关键违规是遗漏用户明确要求的业务约束，就不应该因为其他维度得分较高而判定
B 更优。

建议采用：

-   维度分数；
-   案例通过率；
-   关键失败数量；
-   成本变化；
-   回归情况。

**关键失败作为硬门槛，不允许通过其他维度的高分抵消。**

### 5.4 评测方法：确定性断言优先，LLM Judge 辅助

Prompt Eval 有些内容可以直接程序判断，有些需要语义判断。

  评测内容               推荐评测方法
  ---------------------- ----------------------
  JSON 格式              程序断言
  必需字段               程序断言
  指定内容是否出现       规则检查
  是否违反明确禁止要求   规则 + 语义判断
  是否正确理解任务       Rubric / LLM Judge
  是否合理澄清           Rubric / LLM Judge
  是否存在无依据推断     证据对照 + LLM Judge
  是否出现任务漂移       Rubric / LLM Judge

LLM Judge 应使用独立、固定的评测 Prompt 和模型配置，不应随着被测 Prompt
一起变化。

建议采取：

1.  先执行确定性检查；
2.  再执行语义 Rubric 评估；
3.  对候选版本隐藏 A/B 标签，减少评审偏差；
4.  对部分样本进行人工复核；
5.  记录 Judge 版本和评价依据。

尤其要避免让候选 Prompt 自己定义自己的评分标准。

------------------------------------------------------------------------

## 六、数据结构设计

核心原则：**复用 Skill Eval 已有的 Case、Run、Trace、Result
数据结构，只新增 Prompt Eval 的专项字段。**

### 6.1 Prompt Eval Case

建议在现有共享 Eval Case 上增加 `prompt_eval` 扩展字段。

以下是目标数据契约示例，并非假定现有 Skill Eval 已经采用完全相同的
Schema。

``` json
{
  "case_id": "prompt-006",
  "name": "Missing Metric Definition",
  "category": "ambiguity_handling",
  "task": "分析会员复购率下降的原因",
  "input_data": {},
  "context_fixture_ref": "member-context-empty-v1",
  "prompt_eval": {
    "required_behaviors": [
      "识别复购率定义缺失",
      "提出必要澄清问题",
      "不得编造已确认口径"
    ],
    "forbidden_behaviors": [
      "自行假定复购率定义",
      "直接给出确定性因果结论"
    ],
    "constraints": [
      "只使用已提供的业务上下文"
    ],
    "output_contract": {
      "required_sections": [
        "missing_information",
        "clarification_questions"
      ]
    },
    "rubric_id": "ambiguity-rubric-v1",
    "critical_assertions": [
      "no_invented_metric_definition"
    ]
  }
}
```

Prompt 版本不直接写入 Case。同一个 Case 可以分别测试 Prompt A、Prompt
B、Prompt C，以保持测试案例与被测配置解耦。

### 6.2 Prompt Eval Run

每次评测运行需要记录：

``` typescript
interface PromptEvalRunRequest {
  suiteId: string;

  promptRef: {
    assetId: string;
    version: string;
  };

  modelSnapshot: {
    provider: string;
    modelId: string;
    parametersHash: string;
  };

  dependencies: {
    sdkVersion: string;
    skillVersions: string[];
    toolGuidanceVersion: string;
    extensionVersions: string[];
  };

  contextFixtureVersion: string;

  repeatCount: number;
  evaluationMode: "deterministic" | "rubric" | "hybrid";
}
```

`parametersHash`
用于关联完整模型参数配置。正式实验仍需保留必要的参数明细，确保可以复现。

### 6.3 Prompt Eval Trace

Prompt Eval 特别需要记录实际生效的 Prompt 配置。

``` typescript
interface PromptEvalTrace {
  sessionId: string;
  caseId: string;

  promptAssetId: string;
  promptVersion: string;

  renderedPromptHash: string;
  templateVariablesHash: string;

  modelSnapshot: string;
  sdkVersion: string;

  contextRefs: string[];
  skillVersions: string[];
  toolGuidanceVersion: string;

  outputRef: string;
  executionTraceRef: string;

  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}
```

为什么需要 `renderedPromptHash`？

因为 Prompt 不一定是一个固定文本文件。它可能由以下内容组合而成：

-   基础系统提示词；
-   OptraCall 自定义 Prompt；
-   当前任务 Prompt Template；
-   动态变量；
-   业务上下文。

即使 Prompt 文件版本没有变化，动态变量变化也可能导致最终输入模型的
Prompt 不同。

因此需要记录实际渲染结果的版本指纹，确保实验可追溯。

不建议默认将所有包含业务敏感信息的完整 Prompt
和上下文明文复制到评测记录中。优先保存资产引用、Hash、变量版本及受控证据引用。

### 6.4 Prompt Eval Result

``` json
{
  "eval_run_id": "prompt-run-001",
  "case_id": "prompt-006",
  "prompt_version": "member-analysis-v2",
  "status": "completed",
  "metrics": {
    "task_understanding": 1.0,
    "instruction_adherence": 1.0,
    "constraint_compliance": 1.0,
    "output_contract": 1.0,
    "ambiguity_handling": 1.0,
    "case_pass": true
  },
  "failures": [],
  "evidence_refs": [
    "output-ref-001",
    "trace-ref-001"
  ]
}
```

示例中的数值仅用于说明结构。

### 6.5 失败类型枚举

  Failure Type                     说明
  -------------------------------- ------------------------------
  `GOAL_MISUNDERSTOOD`             任务目标理解错误
  `INSTRUCTION_OMITTED`            遗漏明确指令
  `PRIORITY_CONFLICT_MISHANDLED`   未合理处理指令冲突
  `TASK_CONSTRAINT_VIOLATION`      违反任务约束
  `OUTPUT_CONTRACT_VIOLATION`      输出格式或结构不符合要求
  `AMBIGUITY_MISHANDLED`           信息不足时错误猜测或过度提问
  `UNSUPPORTED_ASSUMPTION`         无依据假设
  `CONTEXT_MISUSE`                 错误使用已提供的上下文
  `SCOPE_DRIFT`                    超出任务范围
  `INCONSISTENT_BEHAVIOR`          等价任务表述下行为明显不一致

这些类型应与 Skill Eval 和 Tool Usage Eval
的失败分类保持命名及字段风格一致，但不必强行使用完全相同的业务失败枚举。

------------------------------------------------------------------------

## 七、接口设计与 pi-sdk 集成

### 7.1 统一评测接口

沿用现有 Skill Eval 和 Tool Usage Eval 的统一操作契约：

`loadSuite → run → evaluate → compare`

建议接口：

``` typescript
interface PromptEvalModule {
  loadSuite(
    suiteId: string
  ): Promise<EvalSuite>;

  run(
    request: PromptEvalRunRequest
  ): Promise<EvalRun>;

  evaluate(
    runId: string
  ): Promise<PromptEvalResult>;

  compare(
    baselineRunId: string,
    candidateRunId: string
  ): Promise<PromptEvalComparison>;
}
```

接口定义是 Prompt Eval 的目标契约。落地时优先映射现有 Skill Eval
的实际方法和类型，不为追求命名一致而重构已有代码。

### 7.2 与 Skill Eval 复用关系

  能力                       处理方式
  -------------------------- --------------------------
  Test Case Loader           复用
  Eval Suite                 复用
  Agent Task Runner          复用
  pi-sdk Session 创建        复用
  Trace Recorder             复用
  Output Collector           复用
  通用 Assertion Framework   复用
  通用评分框架               复用，新增 Prompt Rubric
  Eval Result Store          复用
  A/B Comparison             复用
  Evaluation Report          复用
  Prompt 专项指标            新增
  Prompt Failure Analyzer    新增轻量逻辑

目标不是复制 Skill Eval，而是让 Prompt Eval 成为它的一个独立评测领域。

### 7.3 pi-coding-agent SDK 如何加载不同 Prompt？

Pi SDK 的公开文档提供了通过资源加载机制管理系统提示词、Prompt Templates
和上下文文件的方式。文档示例包括：

-   `systemPromptOverride`：替换默认系统提示词；
-   `appendSystemPromptOverride`：向默认系统提示词追加指令；
-   `promptsOverride`：管理 Prompt Templates；
-   `createAgentSession()`：创建 Agent Session；
-   `session.subscribe()`：订阅执行事件。

这为 Prompt Eval 提供了原生集成路径，不需要修改 pi-sdk 内核。

**OptraCall 首期应当更加谨慎：**

1.  优先测试 OptraCall 自己管理的 Prompt 片段和 Task Prompt Template。
2.  优先通过追加指令或官方支持的 Prompt Template 机制注入候选。
3.  不建议首期直接替换 Pi 原生基础 System Prompt。
4.  不测试 Host 的正式权限和治理规则。
5.  每个候选使用独立配置快照和隔离 Session。
6.  具体 API 必须以 OptraCall 当前锁定的 SDK 版本为准。

### 7.4 Prompt A/B 实验如何控制变量？

假设比较 Prompt A 和 Prompt B，必须保持以下条件一致：

  实验变量               是否允许变化
  ---------------------- --------------
  Prompt 版本            唯一主要变量
  Model                  固定
  Model Parameters       固定
  SDK Version            固定
  Skills                 固定
  Tool Guidance          固定
  Extension Versions     固定
  Memory / Context       固定
  测试任务               固定
  数据 Fixture           固定
  评测规则               固定
  Judge Prompt / Model   固定

每个案例使用独立的测试 Session，避免前一个 Prompt
的会话历史污染后一个候选。

对于多轮任务，应将相同的对话输入按相同顺序重放。

对于有随机性的模型执行，可以重复运行并比较平均表现与波动；不能根据单次输出就断言某个
Prompt 更优。

------------------------------------------------------------------------

## 八、实验运行机制

### 8.1 两种运行模式

**Mode A：Single Prompt Evaluation**

选择一个 Prompt 版本，对指定测试集执行评测。

适用场景：

-   检查当前 Prompt 是否符合预期；
-   建立 Prompt 质量基线；
-   发现具体指令缺陷；
-   回归测试。

**Mode B：Prompt A/B Evaluation**

同一测试集，分别运行 Prompt A 和 Prompt B，对比两者表现。

适用场景：

-   Prompt 版本升级；
-   Prompt 修改效果验证；
-   不同 Prompt Profile 比较；
-   后续 Harness Optimizer 候选评估。

### 8.2 标准执行流程

``` mermaid
flowchart TD
    A["选择 Prompt Profile"] --> B["加载 Prompt Eval Test Suite"]
    B --> C["加载 Baseline Prompt"]
    C --> D["创建隔离 pi-sdk Session"]
    D --> E["Agent 执行测试任务"]
    E --> F["收集输出与执行 Trace"]
    F --> G["确定性断言"]
    G --> H["Rubric / LLM Judge"]
    H --> I["计算维度指标"]
    I --> J["生成 Prompt Eval Report"]
    J --> K{"是否需要 A/B 比较？"}
    K -->|是| L["运行 Candidate Prompt"]
    L --> M["比较差异、成本和回归"]
    M --> N["输出评测结论"]
    K -->|否| N
```

### 8.3 评测报告

每次评测建议输出：

  报告部分           展示内容
  ------------------ ------------------------------
  Run Summary        测试数量、通过数量、失败数量
  Prompt Version     被测 Prompt 及版本
  Dimension Score    六个维度的评测结果
  Failure Analysis   失败案例及失败类型
  Evidence           输出、断言和执行记录引用
  Cost Analysis      Token、耗时、重试情况
  Regression         与基线相比出现的退步
  Conclusion         通过、待改进或不建议发布

正式报告还应展示各项指标的分母、N/A 案例数量及 Judge
版本，避免只展示百分比而无法判断统计基础。

------------------------------------------------------------------------

## 九、分期建设计划

建议采用 P0--P3 四个阶段。

  阶段   建设目标                 主要交付物
  ------ ------------------------ ----------------------------------------
  P0     复用审计与接口确认       Skill Eval 复用清单、Prompt 资产映射
  P1     Prompt Eval 基础 MVP     12 个案例、专项断言、报告、A/B 测试
  P2     增强评测能力             多轮任务、鲁棒性、保留测试集、重复实验
  P3     对接 Harness Optimizer   Prompt 候选自动生成与评测闭环

### 9.1 P0：复用审计

首先核对现有 Skill Eval 和 pi-sdk 集成情况。

重点确认：

1.  Skill Eval 是否支持不同 Prompt 版本注入？
2.  是否支持独立创建和销毁 Session？
3.  是否能够记录 Prompt 版本和执行配置？
4.  是否能够收集完整的最终输出及必要 Trace？
5.  是否支持确定性断言与 LLM Judge？
6.  是否支持 Baseline / Candidate 对照？
7.  当前 pi-sdk 版本如何加载 System Prompt 和 Prompt Template？

**P0 交付物：**

-   Skill Eval 复用能力清单；
-   Prompt 资产及加载方式映射；
-   pi-sdk 当前版本 API 核对表；
-   Prompt Eval Case 扩展 Schema；
-   一个最小 Prompt A/B 执行案例。

这一阶段不要求重构 Skill Eval。

### 9.2 P1：Prompt Eval 基础 MVP

**首期重点。**

建议将范围限制为：

  项目            首期范围
  --------------- -------------------------------
  Prompt 类型     OptraCall 自有任务指导 Prompt
  业务场景        通用数据分析任务
  测试案例        12 个
  目标模型        固定一个
  SDK 版本        固定当前锁定版本
  Skill 版本      固定
  Tool Guidance   固定
  Context         固定测试上下文
  评测方式        确定性断言 + LLM Judge
  对照方式        Baseline / Candidate
  发布方式        人工确认

首期只评测一个现有 Prompt Profile，不同时修改基础 Prompt、业务
Prompt、Skill 和 Tool Guidance。

**P1 交付物：**

1.  Prompt Eval Test Suite；
2.  Prompt Eval Case Schema；
3.  Prompt Version Trace；
4.  Prompt Assertion；
5.  Prompt Rubric；
6.  Prompt Eval Result；
7.  A/B Comparison；
8.  Prompt Evaluation Report；
9.  独立运行及验收说明。

### 9.3 P2：增强评测能力

P1 稳定后，增加：

-   多轮对话 Prompt 评测；
-   同义表达鲁棒性测试；
-   上下文干扰测试；
-   复杂约束和冲突指令测试；
-   不同任务类型的 Prompt Profile；
-   多次重复运行和波动分析；
-   Holdout 保留测试集；
-   人工评审与 LLM Judge 一致性校准。

可以逐步扩展到：

-   Data Analysis Prompt；
-   Deep Research Prompt；
-   Decision Analysis Prompt。

### 9.4 P3：与 Harness Optimizer 联动

这一阶段才引入自动优化。

典型流程：

1.  Prompt Eval 发现某类任务存在持续性问题。
2.  Harness Optimizer 分析失败原因。
3.  自动生成 Prompt Candidate A/B/C。
4.  Prompt Eval 对候选进行相同任务下的对照测试。
5.  Prompt Eval 输出质量、成本和回归结果。
6.  Harness Optimizer 根据证据提出推荐版本。
7.  经人工确认后发布。

**Prompt Eval 负责评测，Harness Optimizer 负责优化。**

Prompt Eval 不应该因为接入
HIS，就把候选生成、优化搜索和正式配置发布也纳入自身职责。

------------------------------------------------------------------------

## 十、P1 独立验收标准

建议将以下内容作为 v0.1 的验收清单。

  验收维度          通过标准
  ----------------- ---------------------------------------------------
  独立运行          可以单独加载 Prompt Test Suite 并执行
  测试案例          12 个基础用例均有可执行评价标准
  Prompt 版本追溯   能准确记录被测 Prompt 及渲染版本
  执行隔离          不同 Prompt 使用独立 Session
  变量控制          A/B 实验除 Prompt 外其他关键配置一致
  任务理解评测      能评价目标要素是否正确识别
  指令遵循评测      能发现遗漏或违反明确指令
  输出格式评测      支持程序化格式及结构检查
  模糊处理评测      能识别错误猜测和不必要澄清
  语义评价          支持固定 Rubric 的 LLM Judge
  失败定位          能定位到具体案例、断言和证据
  结果比较          能比较两个 Prompt 版本的表现
  成本记录          能记录 Token 和执行耗时
  SDK 稳定性        不修改 pi-sdk 内核
  基础设施复用      不重复建设 Skill Eval、Host 和 Extension 通用能力

应通过人工构造的正确、错误和边界输出验证评分器本身，防止评测器出现明显误判。

**不预设 Prompt 必须提高多少成功率。**
改善阈值应在正式实验前确定；如果没有可靠提升，也应该允许得出"不建议替换
Baseline"的结论。

------------------------------------------------------------------------

## 十一、风险与设计约束

  风险            可能问题                              应对方式
  --------------- ------------------------------------- -----------------------------
  Prompt 过拟合   只对固定测试任务表现好                引入 Holdout 和同义表达测试
  评测器偏差      LLM Judge 偏爱某种表达                盲评、固定 Rubric、人工抽查
  变量混杂        同时修改 Skill、Prompt、模型          一次只改变被测 Prompt
  评分标准漂移    为让候选通过而修改 Rubric             评测规则与候选生成分离
  上下文污染      A/B 任务继承不同历史                  独立 Session、固定上下文
  Prompt 冗余     不断增加指令导致效果下降              同时评估 Token 和复杂度成本
  职责重叠        与 Skill Eval、Tool Usage Eval 重复   按评测对象分工
  SDK 兼容问题    依赖未锁定版本的 API                  以当前 SDK 版本核对并适配

### 11.1 Prompt Eval 的特别原则

Prompt 不应该越长越好。

Prompt B 增加了很多分析步骤，可能提高任务完整度，但同时导致：

-   Token 成本增加；
-   执行时间延长；
-   Agent 过度遵循固定流程；
-   简单任务也执行复杂分析；
-   任务自主性下降。

所以 Prompt Eval 不仅要看质量是否提升，也要看是否产生额外复杂度。

`Net Prompt Gain = Quality Improvement - Cost - Regression`

安全和正式治理规则仍然是硬约束，不能通过质量得分进行抵消。

------------------------------------------------------------------------

## 十二、最终产品决策

  决策事项                      最终建议
  ----------------------------- ----------------------------------
  是否建设                      建设
  模块名称                      Prompt Eval
  所属体系                      OptraCall Harness Evaluation Kit
  是否独立运行                  是
  是否复用 Skill Eval           是
  是否复用 pi-sdk               是
  是否修改 pi-sdk 内核          禁止
  是否重建 Host 基础设施        否
  是否重建 Extension 基础设施   否
  是否重建通用 Trace            否
  首期评测对象                  OptraCall 自有任务指导 Prompt
  首期测试案例                  12 个
  首期评测方式                  确定性断言 + LLM Judge
  首期对照方式                  Prompt A/B
  首期自动优化                  不做
  后续优化主体                  Harness Optimizer

### 12.1 最终产品定义

**Prompt Eval：OptraCall Harness Evaluation Kit 中专门评价 Prompt 对
Agent 任务执行表现影响的轻量化评测模块。**

它通过固定模型、任务、Skill、工具和上下文，对不同 Prompt
版本进行独立执行和对照评测，评价 Agent
的任务理解、指令遵循、约束处理、输出交付、模糊信息处理和任务边界控制能力。

### 12.2 与其他评测模块形成统一体系

  模块              主要评价对象   主要回答的问题
  ----------------- -------------- ------------------------------------
  Skill Eval        Skill          Agent 是否掌握并运用了专业方法？
  Tool Usage Eval   工具使用行为   Agent 是否正确使用工具？
  Prompt Eval       Prompt         Agent 是否正确理解任务并遵循指令？

三个模块共享评测底座，但各自拥有独立的测试案例、指标、失败分类和验收标准。

未来与 Memory Eval、Guardrail Eval 等模块组合，逐步形成轻量化 Harness
Evaluation Kit。

------------------------------------------------------------------------

## 附录 A：建议的逻辑目录

``` text
prompt-eval/
├── cases/
│   └── prompt-basic-suite.json
├── rubrics/
│   ├── task-understanding.yaml
│   ├── instruction-following.yaml
│   ├── ambiguity-handling.yaml
│   └── scope-control.yaml
├── assertions/
│   ├── instruction-check.ts
│   ├── constraint-check.ts
│   └── output-contract-check.ts
├── adapter/
│   └── prompt-config-adapter.ts
├── evaluator.ts
├── comparison.ts
├── report.ts
└── README.md
```

这是建议的逻辑结构，不要求现有工程直接采用相同目录。Runner、Session、Trace、结果存储和通用报告能力继续复用
Skill Eval。

## 附录 B：实施前核对清单

-   [ ] 核对现有 Skill Eval 的 Case、Runner、Scorer、Trace 和 Result
    接口。
-   [ ] 确定当前 OptraCall 实际使用的 Prompt 资产类型。
-   [ ] 区分 pi-sdk 原生 System Prompt 与 OptraCall 自有 Prompt。
-   [ ] 核对当前锁定 pi-sdk 版本的 ResourceLoader 能力。
-   [ ] 确认 Prompt 版本和动态变量的追溯方式。
-   [ ] 建立 12 个基础测试案例。
-   [ ] 建立确定性断言和 LLM Judge Rubric。
-   [ ] 固定模型、Skill、Tool Guidance 和 Context。
-   [ ] 验证 A/B 实验使用独立 Session。
-   [ ] 确认评测结果可以被未来 Harness Optimizer 消费。

## 附录 C：参考资料

Pi 官方 SDK 文档及示例入口：

-   Pi SDK Documentation：<https://pi.dev/docs/latest/sdk>
-   Custom System Prompt
    Example：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/03-custom-prompt.ts>
-   Prompt Templates
    Example：<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/08-prompt-templates.ts>

说明：这些资料用于说明 Pi SDK 的 Prompt 和资源加载能力。实际实施必须以
OptraCall 当前锁定的 pi-coding-agent SDK 版本为准。

------------------------------------------------------------------------

**最终原则：Prompt Eval 只负责评价 Prompt 对 Agent 行为的影响；Skill
Eval 负责专业方法，Tool Usage Eval 负责工具使用，pi-sdk 负责 Agent
执行，Host 负责通用环境与治理，Harness Optimizer 负责未来的自动优化。**
