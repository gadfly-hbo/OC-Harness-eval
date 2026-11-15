# OC-Harness-eval

在 **OptraCall 产品环境**里评估 Agent Skill 的实际价值：不是看它写得好不好，而是测它**是否真被激活、激活后是否真让输出变好**。

两侧都经过 OptraCall 的正常任务入口（Host HTTP → 统一会话层 → Pi SDK），带着产品的系统提示、业务工具与交付流程。唯一变量是目标 skill 是否可用。

```
baseline（codeRoot 移除目标 skill）  ┐
                                     ├─→ 同一任务 · 同一模型 · 重复 N 次 → 规则断言 + 匿名盲评 → 门禁结论
variant（codeRoot 含目标 skill）     ┘
```

## 核心方法

评估一个 skill 要同时回答三个问题，缺一不可：

| 问题 | 测量方式 | 失败意味着 |
| --- | --- | --- |
| **是否被激活** | native 会话读取路径取证（命中 skill 包 = 强激活）+ 关键词弱证据 | skill 写得再漂亮，不被触发就是死代码 |
| **激活后是否更好** | 与 baseline 成对比较，匿名评委给 win/tie/loss | skill 只是让回答更长 |
| **是否稳定有效** | 重复运行后的激活率与胜率分布、任务等权增益区间 | 一次侥幸赢不算有效 |

关键约束：

- **唯一变量**。两份 codeRoot 除目标 skill 包外逐字节一致（全量哈希核验），独立 dataRoot/projectsRoot，每次 attempt 全新项目；模型、任务文本、模板、轮数两侧一致。
- **判定分层**。规则断言（客观、可复算）优先于模型评委（主观）；冲突时以规则为准并记录分歧。
- **独立评委**。评委只看到任务、预期要点、评分标准、两份匿名输出（顺序随机化），看不到 skill 名/路径/来源。
- **失败即数据**。崩溃、超时、空输出、判失败全计入分母，不做选择性重跑；失败/空输出不跑负向断言。
- **证据留痕**。每次运行的 native 会话、交付物、usage、激活取证、断言、评委票、账本均落盘，可复核可回放。

## 隔离边界

OptraCall 正常任务**不是 OS 沙箱**：worker 以用户权限运行，010 禁读是提示词软约束。评测隔离依靠独立评测根（与用户真实 `~/.optracall`、`~/OptraCallProjects` 完全分离）、每次 attempt 全新项目、基线物理移除 skill、污染取证。评测 Host 是独立实例（临时端口），不连接、不停止、不修改用户运行中的试用服务。结论限于冻结的 OptraCall commit/SDK/模型/题集所定义的产品环境。

## 快速开始

```bash
npm install
npm run check                    # 类型检查 + 断网离线测试

# 只读预检模型身份（不调用 Provider）
npm run eval -- preflight \
  --model minimax-cn/MiniMax-M3.1-Flash \
  --judge-model xiaomi-token-plan-cn/mimo-v2.6-flash \
  --home ~/.skill-eval/pi-home

# 真实对照评估（产生费用，先确认规模）
npm run eval -- eval \
  --suite suites/optracall-smoke.json \
  --optracall /path/to/OptraCall \
  --optracall-node /path/to/node25+ \
  --model minimax-cn/MiniMax-M3.1-Flash \
  --judge-model xiaomi-token-plan-cn/mimo-v2.6-flash \
  --home ~/.skill-eval/pi-home \
  --repeat 1 --judge-repeat 1
```

- 套件须声明 `optracall` 段（`skillName`、可选 `templateDir`）；目标 skill 取自 checkout 的 `extensions/analysis-assets/<skillName>`。
- Host/worker 需 Node 25+；默认用当前解释器，不足时 `--optracall-node` 指定。
- 凭证仅从 `--home` 的 Pi 隔离配置读取，注入评测 Host 的独立 dataRoot，不触碰用户真实配置。
- v1 被评模型固定 `minimax-cn/MiniMax-M3.1-Flash`；其他模型需先扩展费率与额度核验。
- 完整矩阵 = `任务数 × repeat × 2` 被评会话 + `任务数 × repeat × judgeRepeat` 评委会话。

### 离线链路验证（无真实费用）

```bash
node --experimental-strip-types scripts/optracall-host-integration.ts --checkout <checkout> --node <node25+>
node --experimental-strip-types scripts/optracall-model-integration.ts --checkout <checkout> --node <node25+>
```

前者验证真实 Host API 链路（无模型调用）；后者用本地假 Provider 验证完整模型调用链路（Host→worker→SDK→native JSONL→取证）。

## 常用命令

```bash
npm run eval -- check --suite suites/optracall-data-analysis-v1.json   # 套件静态体检
npm run eval -- report --run runs/<run-id> --suite-file <套件.json>     # 从原始产物重算，另存 analyses/
npm run eval -- verify --generate-broken <SKILL.md> --out <目录>        # 阴性对照：生成契约剥离版
npm run eval -- verify --original <原版运行> --broken <破坏版运行>      # 阴性对照：核验区分度
npm run eval -- calibrate --run runs/<run-id> --export <盲审表.json>    # 人工匿名盲审导出
npm run eval -- threshold                                            # 查看判定与回归门禁阈值
```

## 套件与判据

套件定义见 `schemas/suite.schema.json`。产品环境套件要点：

- 任务文本冻结交付文件名（如 `060_reports/analysis.md`），`deliverablePath` 指向它；规则与评委均用该文件的采集快照。
- 初始资料模板放 `templateDir`（`010_draw`/`020_clean` 平铺文件），两侧一致。
- 断言检验 skill 声称的**行为约束**，不是措辞风格；负向断言往往更有区分度。写不出有区分度的断言 → 标 `diagnostic`。
- 断言**先于观察结果**冻结；私有真值与隐藏断言存 `.local/`，不进入 skill 可读路径。

判定门禁（`paired-task-v2.1`）：有效评判覆盖率 ≥ 70%、skill 侧超时率 ≤ 20%、全样本胜率下界 ≥ 50%、任务等权断言增益 ≥ 10pp、最低 4 对计分样本；以独立任务为统计单位用保守 95% Hoeffding 区间。小套件可能 `inconclusive`，不靠复制题目或放宽门槛制造显著性。

## 仓库结构

```text
src/
├── core/          评估内核（无业务耦合，可单测）
│   ├── runner.ts            对照实验编排、停批及 NOT_RUN
│   ├── execution.ts         评委受控会话与账本
│   ├── optracall-env.ts     双 codeRoot 环境准备与哈希身份核验
│   ├── optracall-driver.ts  Host 生命周期 + 正常任务入口 HTTP 驱动
│   ├── optracall-evidence.ts native JSONL → 指标/事件；项目终态取证
│   ├── optracall-execution.ts 复合执行层（subject 走 OptraCall，judge 走受控 Pi）
│   ├── optracall-setup.ts   模板/凭证/配置身份/冻结清单段
│   ├── verdict.ts           综合结论判定引擎
│   ├── judge.ts             成对匿名评委、多轮聚合
│   ├── assertions.ts        规则断言判定
│   ├── activation.ts        激活检测（工具取证 + 正负向触发分离）
│   ├── gain.ts / stats.ts   任务等权配对增益、保守区间
│   ├── controlled-session.ts / controlled-worker.ts  评委用受控 Pi 会话
│   └── ...                  阈值、成本、回归、阴性对照、校准等
├── cli/           命令行入口
└── report/        Markdown 报告生成
schemas/           JSON Schema（套件定义）
suites/            评估套件（optracall-*）与合成模板
skills/            工具自身的 skill（skill-eval-flow）
scripts/           离线测试守卫、真实 Host 链路验证
docs/              测评器开发规范、驱动契约、验收与冒烟记录
governance/        方法来源
```

## 工作规则

见 [AGENTS.md](AGENTS.md) 与 [测评器开发规范](docs/测评器开发规范.md)。方法与边界见 [驱动契约](docs/plans/2026-11-15-optracall-driver-contract.md)、[离线验收](docs/optracall驱动离线验收-2026-11-15.md)、[真实冒烟](docs/optracall真实冒烟-2026-11-15.md)。