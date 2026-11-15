# IR 测评器首版离线计划

## 冻结契约

| 项目 | 首版约定 |
| --- | --- |
| 决策 | 分别回答方法的数值正确性和适用边界、Agent 的查读与正确采用、相同条件下的配对差异。离线样本用于验测评器。 |
| 对象与唯一变化 | 固定 SAP 的方法 ID、版本、发布哈希和正文，核对源与隔离目标的映射。基线目录不含目标，处理侧目录含目标。任务、数据、Prompt、模型配置、授权 Skill、工具和预算保持一致。 |
| 输入与控件 | 同口径回放、独立合成迁移、可统一分母与不可比边界。A/B′ 是业务场景。错会话权重仍闭合、缺字段、只查未采用、先算后读、污染和超时作为诊断控件。公开夹具与参考信息不具备留出集资格。 |
| 判据与分母 | 由输入重算聚合率、权重、分解项和闭合。关键错误判 FAIL，证据缺失判 UNKNOWN。不可比时可给边界 PASS，业务数值仍 UNKNOWN。主指标是可比任务的二元通过差，任务族等权，完整报告所有计划项。每个任务计划一个方法核验和一组配对。 |
| 执行与停止 | 仅处理本地合成材料和回放档案，无模型或评委调用，预算为离线配置指纹的一部分。冻结、归档和报告写入失败即停止。超时、取消、失败和未运行按原记录逐项保留。 |
| 证据范围 | 原生 Pi 正式 SAP 取证必须限定有效分支。采集接缝另需 Host 记录环境读回与泄漏检查，以及审阅方绑定输出、采用阶段与具体证据。真实隔离探针和执行接入须按新任务授权验证。 |

方法核验记录用于检查独立审阅者按候选方法完成的推演。Agent 配对中处理侧即使答对，也不能代替方法核验。正式测评需在看到结果前冻结留出集和计划，失败后新建计划与案例分区。

## 本机复用审计

- 本机 `../skill-eval` 的 HEAD 为交接指定的 `e0f2b65e4ad57780e468e7ba057482582fc417b2`。查阅 `src/cli/main.ts` 的 `pending`、`check`、`eval`、`report`、`archive`。沿用候选冻结、先声明运行矩阵、保全未运行项、原件哈希和从归档重算的模式。Skill Eval 的 `run-manifest.ts`、`runner.ts`、`gain.ts` 分别是这些行为的实现参考。
- `pending.ts` 和 `archive.ts` 依赖 Skill 包与归档契约，`suite.ts` 和 `assertions.ts` 面向 Skill 专项判据，`runner.ts` 通过 Skill 可见性构造基线。`isolation.ts` 和 `contamination.ts` 依赖该测评器控制的会话与工作区。现有包没有发布独立公共库入口，IR 通过轻量回放边界接入，避免跨仓运行时依赖。
- 仓库的 Prompt 讨论稿提供固定其他变量、优先确定性断言、关键错误单列、独立语义评阅及报告带证据的原则。交接定义本期对象为 SAP 方法版本，Prompt 保持固定。
- OptraCall 接缝以 `85d8b2e5a944e162db4a1cff4f5740ea5b44c49c` 为准，核对 `extensions/business-plugins/metric-factory/methods/store.ts`、`src/host/native-session-snapshot.ts`、`src/host/ui/semantic-context-history.ts` 与 `tests/sap-methods-host.test.ts`。见 [SAP 实现契约](https://github.com/gadfly-hbo/OptraCall/blob/85d8b2e/openspec/changes/sap-analysis-methods/implementation-contract.md) 和 [M6 协议](https://github.com/gadfly-hbo/OptraCall/blob/85d8b2e/openspec/changes/fourbase-experience-learning/evaluation-protocol.md)。
- 交接机器上的历史验收目录和已发布 v1 正文在本机未取得。夹具参考历史 [A/B′ 已记录结果](https://github.com/gadfly-hbo/OptraCall/blob/85d8b2e/openspec/changes/product-system-prompt-v2/result.md#L79) 独立重建。历史《渠道转化率变动拆解》v1 的 ID 为 `05a07d48-fdc2-4da5-802d-afa91a805994`，发布哈希为 `c09286762d863512ac91dfea1bbe585af17136f2dd73d4f76d95c9425c55c80f`。合成替身另用独立 ID 和哈希。

## 验收记录

- Node `v24.21.0` 执行 `npm test`，41 项通过、0 失败、0 跳过。使用本机 Skill Eval 已安装的 TypeScript 编译器对本仓 `src/*.ts` 与 `test/*.ts` 完成严格类型检查。未安装依赖。
- `node src/cli.ts demo` 归档 4 案、3 个任务族、12 份原始档案。`node src/cli.ts verify <run-directory>` 从归档复算返回 `VERIFIED`。本机运行目录为 `.local/ir-eval/e60d0ba7-4820-48fd-9345-5ec54d0c1492`，内含 `report.md`、`receipt.json`、冻结记录及 `raw/`。
- 套件 `channel-conversion-offline@1.0.0`，冻结计划 SHA-256 `a54d9cc77a10dff81ab678602229c4a478e6be71af2b65192d064e839dffa28d`，实际执行源码指纹 `0ff885920f0322aeb8c12b96d665e5984a80cc00c57af3c6b16280e0687290d1`。文件级指纹见 `freeze.json`。
- 独立复核重现了跨案例复用状态、先算后读的初算误判、无关工具回执、原生失败或追问尾项、档案解析溢出和缺配对时整体误报。修复后逐项离线复验，未留下已知高影响问题。回放按件快照归档，当前没有会话事件写入器。
- 真实 Provider、实际隔离探针、在线 SAP 接入及正式留出测评均为 `NOT_RUN`。真实 v1 正文缺失，方法有效性和实际增益待测。

## Qoder 编排入口

`ir-eval-flow` 参照本机 `skill-eval-flow` 的待测区和交互方式。Qoder 选择包与动作，`src/flow.ts` 调用同一个测评器冻结、回放及核验。编排输出 JSON 状态和报告路径。该入口只在采集前创建冻结记录，缺档案、失败和不可判定仍由原始测评器记录。

本机 Qoder CN CLI `skills list` 显示 `ir-eval-flow [Enabled]`。独立试用从仓库外的临时目录走完待测包发现、冻结、放入 12 份合成档案、回放及复算。另验证已有档案但缺原冻结时会停止准备。通过新入口复算旧离线运行仍返回 `VERIFIED`。新入口的默认演示报告在 `.local/ir-eval/439d2b67-8f7c-4f74-9bba-c1c3c473153b/report.md`。实际 Qoder 模型会话、在线 SAP 与真实 Provider 执行均为 `NOT_RUN`。

`npm test` 通过 47 项，0 失败、0 跳过。使用本机 Skill Eval 的编译器通过严格 TypeScript 检查。独立复核发现不同冻结计划可以误挂父运行，修复后拒绝跨计划关联，并验证同一原冻结仍能复算。

## 待测包归档

参照本机 `skill-eval-flow` 的 S5，先复算指定运行，再核对归档条件与原包身份。IR 采用录制回放中的方法正确性、适用性、处理侧任务与档案完整性作为本地归档条件，复用和真实增益继续单列。整包原子移入 `archive/<运行 ID>/bundle/`，`archive.json` 记录候选身份及原运行证据。未通过或证据不足时保留待测包及运行记录。待测包和归档包默认忽略 Git。

全仓 `npm test` 通过 59 项，0 失败、0 跳过，严格 TypeScript 检查通过。独立复核发现移动后包内输出别名失效，以及预留写入后中断无法重试。修复后验证报告真实路径可读，同一次运行可恢复匹配的预留，普通冲突仍会拒绝。实际待测区为空，本次整包移动由隔离临时目录中的录制形状夹具验证。
