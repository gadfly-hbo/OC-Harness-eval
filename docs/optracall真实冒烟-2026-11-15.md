# OptraCall 产品环境 · 真实最小冒烟记录

日期：2026-11-15（Asia/Shanghai）。证据层级：**真实模型运行**（real-model）。授权：用户确认按「非 OS 沙箱」方案执行最小冒烟。

## 范围

1 题（attr-sales，归因分析）× 2 侧 × 1 次 + 1 轮盲评 = 2 被评会话 + 1 评委会话。运行 ID `run-20261115-144512-216e0c06`（原始产物在 `runs/`，已忽略，不入库）。

- 被评模型 `minimax-cn/MiniMax-M3.1-Flash`，评委 `xiaomi-token-plan-cn/mimo-v2.6-flash`。
- 候选：OptraCall checkout `f559251` 的 `extensions/analysis-assets/data-analysis` 整包；Pi SDK 1.4.0；Host/worker Node v26.0.0。
- 入口：`eval --optracall /Users/huangbo/Dev/OptraCall --optracall-node <node26> --home ~/.skill-eval/pi-home --repeat 1 --judge-repeat 1`，套件 `suites/optracall-smoke.json`。

## 结果

| 项 | baseline | skill |
| --- | --- | --- |
| 终态 | success（185.6s） | success（297.2s） |
| 激活 | not_activated（0 读取） | activated（SKILL.md + 4 附属文件） |
| 六段契约 mustMatch | ❌ | ✅ |
| 样本量 mustContain | ✅ | ✅ |
| 环比 +10% numeric | ❌ 未提取到数值 | ❌ 未提取到数值 |
| AI 套话 mustNotMatch | ✅ | ✅ |
| 断言合计 | 2/4 | 3/4 |
| 交付物 060_reports/analysis.md | present | present |
| 污染检测 | clean | — |

- 评委 1 轮判 **win**（scoreDelta 28）；integrity verified、isolation verified（backend `optracall-host-eval-roots`）。
- 激活率 baseline 0 / skill 1.0；唯一变量成立（基线物理移除 skill，污染取证 clean）。

## 判定

**结论不足（inconclusive）**：有效计分判定仅 1 对，低于最低 4 对；任务等权增益 95% Hoeffding 区间 [-100pp, +100pp] 跨零（独立任务 1 个）。

这是单题冒烟的诚实结论：**证明真实执行链路通**（正常任务入口 → 激活取证 → 交付采集 → 盲评 → 计分），**不证明 skill 有效**。有效性需正式套件、足够独立任务与重复另行测评。

## 费用（三口径分开）

- 用量合计 2,311,031 tokens（baseline 816,785 / skill 1,494,246）。
- SDK 成本估计：US$0.0788（summary 口径，native usage.cost）。
- 保守等价上界：US$0.367（subject，按冻结费率全输入/cache 计未缓存价；baseline 0.130 + skill 0.237，见 `optracall-ledger.jsonl`）。
- 现金账单、剩余额度、后端模型修订：**未知**。保守等价不是现金账单。

## 已知问题与限制

- numeric 断言（环比 +10%）两侧均「未提取到数值」：报告措辞与正则不匹配，**草案判据需校准**；六段契约断言区分度良好（baseline ❌ / skill ✅）。
- 单题、单轮盲评未做位置偏好探测；正式测评需 `--judge-repeat ≥ 2`。
- 产品正常任务非 OS 沙箱；隔离靠独立评测根 + 基线物理移除 skill + 污染取证（详见驱动契约）。
- skill 侧出现 codemode 工具报错后自主恢复（err=true → 重试），属 Agent 自主纠错，保留为过程数据。

## 下一步

正式测评：校准产品环境套件判据（尤其 numeric 措辞等价形式），扩充独立任务与重复，另行冻结矩阵与授权后执行。