# prompt-ir-eval

独立的 SAP 分析方法版本测评器，命令为 `ir-eval`。回执分别给出方法正确性和适用边界、Agent 是否查读并正确采用，以及同条件的配对结果。

首版运行公开合成验收，也能复算导出的 Pi 会话证据。使用 Node.js 24 及以上版本，无须安装依赖。

## 在 Qoder 中使用

调用 `/skill:ir-eval-flow 跑一次离线冒烟` 可验证整条离线链路。Qoder 调用测评器、复算回执，并返回报告路径。

评估具体方法时，把测评材料目录放到 [待测区](pending/)，然后调用 `/skill:ir-eval-flow 回放待测方法`。也可以在这句话里直接给包目录。待测区只有一个包时自动选中，有多个包时 Qoder 请你选一个。

- `plan.json` 是待冻结计划。在采集前调用 `/skill:ir-eval-flow 冻结待测计划`，生成 `frozen/`。
- 将已有原始档案放入包下的 `captures/`。回放读取同包的 `frozen/` 和 `captures/`，完成后给出经过复算的报告。
- 通过后，CLI 自动把 `pending/` 的直属材料包整体移到 `archive/<运行 ID>/bundle/`，并写入 `archive.json`，链接原运行和报告。待测区继续接收新包。
- 要核对已有回执，调用 `/skill:ir-eval-flow 复核运行 <运行目录>`。

归档要求录制回放已复算，方法正确性、适用性和处理侧任务均通过，计划档案完整且未发现执行身份或隔离异常。基线业务失败可作为对照。复用与真实增益按回执单列。合成演示、未通过及缺证据的包保持原位；`archive/` 和 `pending/` 的材料默认留在本机，Git 只追踪目录标记。

仓库内的 [Skill 源文件](skills/ir-eval-flow/SKILL.md) 可链接到 Qoder 扫描的 `~/.agents/skills/ir-eval-flow`。在其他机器上，从仓库根执行：

```sh
mkdir -p ~/.agents/skills
ln -s "$(pwd -P)/skills/ir-eval-flow" ~/.agents/skills/ir-eval-flow
qoderclicn skills list
```

也可直接调用 `node src/flow.ts`。旧运行可用 `node src/flow.ts archive <运行目录> <待测包目录>` 补归档，仍核对冻结和原件哈希。归档目录只有 `archive.json` 时表示移动尚未完成，使用同一个运行和包可以续做。使用 `--pending` 指定其他待测目录时，归档位于它旁边的 `archive/`。底层计分仍由同一个 `ir-eval` 执行。当前自动化覆盖已有档案和合成演示。新开 OptraCall 任务需执行接入及真实环境授权。

## 命令行演示

```sh
npm test
run_dir=$(node src/cli.ts demo)
node src/cli.ts verify "$run_dir"
```

运行目录默认位于 `.local/ir-eval`。打开其中的 `report.md` 查阅结论，通过 `receipt.json` 定位断言和原始证据。运行和核验命令的退出码表示操作是否完成。方法与案例的 `PASS`、`FAIL` 和 `UNKNOWN` 以回执为准。

演示用四个业务案例、三个任务族、十二份合成档案验证评分和取证。B′ 按访客权重得到 **4.00%** 中间率，错用会话权重得到 **4.75%**，两个结果都能闭合到 **+1.00 个百分点**。操作数、单位和各分解项分别核验。缺基期会话数的案例，指出缺口并停止归因可通过边界判据，业务数值保持 `UNKNOWN`。先算后读的迁移案例只凭读后证据确认复核。

本机缺交接所指的已发布《渠道转化率变动拆解》v1 正文及原始验收材料。演示使用独立身份的合成替身，回执只用于离线验收。真实 v1、Provider、在线 SAP、实际隔离探针和正式留出集均为 `NOT_RUN`。复用审计与冻结口径见 [离线计划](docs/offline-plan.md)。

## 冻结与重放

```sh
node src/cli.ts freeze ./plan.json ./frozen
node src/cli.ts replay ./frozen ./captures ./.local/ir-eval
node src/cli.ts verify ./.local/ir-eval/<run-id>
```

在收集结果前冻结套件、固定设置、用例、评阅准则和精确 SAP 版本。每次回放创建独立运行目录，归档捕获文件的原始字节，再从归档评分。重试或复算可给 `replay` 追加 `--parent <run-id> --reason '<理由>'`。原回执和原始证据继续可查。若归档中止，查看 `run.json` 中的计划矩阵及可写入时的 `interrupted.json`。已完成回执带 `completed.json`。

`verify` 检查源码、Node、计划、原件清单及哈希，从原件重算回执与报告。归档和冻结目录应保存在受控路径。哈希用于读回比对，可信冻结时点及采集者身份由保管方保证。导入前由保管方确认材料范围及脱敏。

## 首版输入约定

[合成计划和档案构造](src/demo.ts) 可直接作为 `SYNTHETIC_REPLAY` 格式样例。运行 `demo` 后也可在输出目录的 `demo-inputs` 下找到展开的 JSON。面向导出的 Pi 记录使用 `RECORDED_REPLAY`。

- **计划** `schemaVersion: 1`。包括套件 ID 与版本、固定设置、评阅方标识和案例。候选包含 `source`、`isolated`、源 SAP 版本的完整 JSON 字符串 `versionBody`。每个目标使用 `{kind:"sap-method",methodId,version,publishedHash}`，隔离 ID 可变化，版本和发布哈希一致。发布哈希按 OptraCall SAP 契约验证，完整正文另有 SHA-256。
- **案例** 包含 `id`、`family`、`purpose`（`source-replay`、`migration` 或 `boundary`）、`question`、`scenario` 与独立 `rubric`。场景指定 `visitors` 或 `sessions`，按 `before`/ `after` 记录各渠道转化数及分母。给任务的输入是 `caseId`、`question`、`scenario`。同源变体用同一任务族。判据和候选正文保存在评估侧。
- **档案** 每个案例计划 `<caseId>.method.json`、`<caseId>.baseline.json`、`<caseId>.treatment.json`。方法侧是独立推演与评阅，基线和处理侧是配对任务。记录实际终态、会话及工作区 ID、任务和设置指纹、隔离检查及目录目标。终态包括 `COMPLETED`、`TIMEOUT`、`FAILED`、`CANCELLED`。缺档案记 `NOT_RUN`，格式损坏记 `INVALID_CAPTURE`。计划外的常规文件仍归档。
- **输出与评阅** `output.report` 保留原报告，`output.analysis` 提供逐期渠道操作数、转化率与分解项，或结构化停止决定和缺字段清单。率用 `%`，效应用 `pp`，两者也接受 `ratio`。独立评阅方按冻结准则复核报告、计算证据及业务解释，通过 `outputHash`、`rubricHash` 与两者绑定。源任务方法核验另记录 `fidelity`。使用 `src/evaluate.ts` 的 `fingerprint` 生成这些指纹。
- **查读与采用** 录制档案在 `native` 提供原生 Pi v3 JSONL 字符串与 Host 导出的 `leafId`。测评器在该分支关联调用及结果，核验正式目录命中、完整目标、回执和正文，其他读取渠道单列。正式读取后仍需绑定采用证据。录制侧使用已配对的原生工具调用及实际结果，评阅需绑定 `adoption.callHash`、`adoption.eventHash`。结果 `details` 要有 `type: "ir-eval.analysis-proof"`、相应 `kind`、计算阶段 `phase` 与实际 `analysis`。现有工具记录缺这种结构化证据时，采用为 `UNKNOWN`。原生事件索引可通过回执中的 `nativeEventLines` 定位到 JSONL 行。
- **配对** 各侧冻结数据、Prompt、模型、参数、工具、Skill、上下文和预算。两侧只改变目标方法是否可用。失去证据、身份漂移、污染、复用会话或工作区的配对记为 `UNKNOWN`。按任务族等权，只把完整可比的任务族纳入观察差值。缺完整覆盖时整体状态为 `UNKNOWN`。录制模式可核验档案内容，当前没有独立运行真实 Host 隔离探针，因此真实增益保留 `UNKNOWN`。
