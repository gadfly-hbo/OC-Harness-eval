# OptraCall 真实执行链路对照驱动 · 契约与冻结清单

日期：2026-11-15。状态：驱动建设与离线验收阶段；**真实模型运行未授权、未运行**。

## 决策问题与结论范围

回答：data-analysis skill 在 **OptraCall 产品环境**中是否被真正读取，以及读取后是否让任务交付更好。
结论只限于冻结的 OptraCall commit、Pi SDK 版本、模型配置与任务集所定义的产品环境；不外推到裸 Pi 会话（现有 `controlled-worker` 的环境范围）或其他产品。

现有执行器（`src/core/controlled-worker.ts`）创建裸 Pi 会话并关闭上下文文件、扩展、模板与主题，测得的效果不含产品系统提示、业务上下文、工具、权限与交付流程。本驱动让两侧都经过 OptraCall 的正常任务入口（Host HTTP API → 统一会话层 → `project-entry.mjs` worker → Pi SDK），只改变目标 skill 是否可用。

## 候选、基线与唯一变化

- 候选：OptraCall 内置 `extensions/analysis-assets/data-analysis` 整包（冻结哈希）。
- 基线：同一产品环境，目标 skill 目录不存在。
- 唯一变量：两份 codeRoot 除 `extensions/analysis-assets/data-analysis/` 外逐字节一致（全量 SHA-256 清单核验）；`node_modules` 指向同一冻结安装的只读符号链接，两侧共享同一 SDK 身份。
- 每侧独立 `dataRoot`（配置、项目元数据、native 会话）与 `projectsRoot`（项目文件）；**每次 attempt 新建项目**，初始资料来自冻结模板，经正常上传入口送入。
- 两侧模型配置（provider/model/baseUrl/api/thinkingLevel/revision）、任务文本、模板、上传顺序完全一致；任务能力开关（modelTools/weatherTools/tradeAreaTools/simulationTools）两侧同为默认关闭。
- worker 的 `agentDir = <dataRoot>/pi` 全新创建，无用户级 skill/扩展/MCP；内置其余 skill 两侧一致。

## 独立任务、真值与正负控

- 任务集：产品环境套件（`suites/` 新增，判据先于观察冻结）。任务文本冻结交付文件名（`060_reports/<name>.md`），两侧一致。
- 私有真值与隐藏断言存 `.local/`，不进入项目目录、模板、codeRoot 或任何 skill 可读路径。
- 正负控沿用仓库阴性对照方法（契约剥离版独立运行），本轮先建驱动，消融另行冻结。
- 旧裸 Pi 套件的断言不静默沿用；产品环境判据重新冻结并另存版本。

## 判分规则、阈值与分母

- 计分载体：冻结交付路径的采集快照（`deliverable.md`），规则断言与盲评均作用于它；聊天最终文本只作过程记录。
- 状态读回：项目三目录完整树 + 逐文件哈希；`020_clean`/`060_reports` 内容随证据落盘。
- 激活取证：native 会话 JSONL 中 `read` 工具实际读取路径命中变体 codeRoot 内 skill 包 → 强激活；关键词弱证据单列。baseline 侧用原始 checkout 路径做污染检测。
- 判定优先级、任务簇统计、覆盖率/超时惩罚、回归门禁阈值全部复用现有引擎（`paired-task-v2.1`），不另立口径。
- 失败即数据：`lastRun` 为 failed/cancelled/interrupted、交付缺失、Host 故障、显式超时全部计入分母；失败/空输出不跑负向断言；不选择性重跑。

## 执行矩阵、授权与停止条件

- 矩阵：`任务数 × repeat × 2 侧` 被评会话 + `任务数 × repeat × judgeRepeat` 评委会话（评委仍走 skill-eval 受控 Pi 会话，独立盲评）。
- v1 被评模型限 `minimax-cn/MiniMax-M3.1-Flash`（OptraCall 预设 `minimax-m31-flash`，SDK 内置目录原生额度），评委 `xiaomi-token-plan-cn/mimo-v2.6-flash`；其他模型需先扩展费率与额度核验，不在本轮范围。
- 凭证：仅从 `--home` 的 Pi 隔离配置读取，经 `PUT /api/configuration` 注入评测 Host 的 `dataRoot/auth.json`（0600）；不触碰用户真实 `~/.optracall`。
- 停止条件：Host 进程退出、环境身份哈希漂移、证据持久化失败、用户中止 → 停批保全证据；单样本终态失败 → 记失败继续。
- 真实运行授权：本轮仅建设与离线验收。真实冒烟/正式测评的模型、规模、费用另行确认后执行。

## 冻结清单与身份核验

运行清单（`run-manifest.json`）在现有字段外增加 `optracall` 段：

- 源 checkout 绝对路径、commit、dirty 状态；Pi SDK 版本（`host-ready`/`/api/health` 实测）与安装哈希。
- 目标 skill 名与整包哈希；两侧 codeRoot 全量文件哈希清单及「唯一差异」核验结果。
- 模板文件清单与哈希；模型配置身份（provider/model/baseUrl/api/thinkingLevel/revision，**不含 apiKey**）。
- 每次 attempt 记录：projectId/taskId/requestId、native sessionFile 路径与哈希、Host 端口与启动参数、`lastRun` 终态。

## 隔离边界（诚实声明）

- 产品正常任务**不是 OS 沙箱**：worker 以用户权限运行，010 禁读是提示词软约束。本驱动不改变产品权限模型。
- 评测隔离依靠：独立 codeRoot/dataRoot/projectsRoot（与用户真实数据根完全分离）、每次 attempt 全新项目、基线物理移除目标 skill、污染取证、私有真值不进可读路径。
- 不启用 OS 网络拒绝；产品正常工具与联网能力按任务配置保留，两侧一致。报告须注明该边界与裸 Pi 受控会话的差异。
- 评测 Host 为独立实例（`--port=0` 临时端口），不连接、不停止、不修改 Mac mini 或本机正在运行的试用服务。

## 费用口径

native 会话 usage（tokens）为权威用量；SDK cost 估计、按冻结费率表的保守等价（仅 minimax 在表）、现金账单未知，三者分别记录于 `optracall/usage.json` 与账本，不混报。

## 离线命令、结果与证据路径

已完成离线验收，详见 [OptraCall 驱动离线验收记录](../optracall驱动离线验收-2026-11-15.md)：

- `npm run check`：类型通过，566/566 测试通过，0 失败、0 跳过。
- `scripts/optracall-host-integration.ts`：真实 Host API 链路 PASS（无模型调用）。
- `scripts/optracall-model-integration.ts`：完整模型调用链路 PASS（本地假 Provider，native JSONL 9 条，输出/用量取证一致）。
- 源码指纹：skill-eval 基线 `e0f2b65`（未提交增量）；OptraCall `f559251`；Pi SDK 1.4.0。

## 真实冒烟与正式测评各自的授权、状态和证据

- 真实冒烟：**未授权、未运行**。
- 正式测评：**未授权、未运行**。

## 独立复核、未验证项与交付状态

- 已知未验证：真实 Provider 鉴权与计费、OptraCall 真实模型下的候选效果、CLI 真实端到端、套件正式区分度校准（详见离线验收记录）。
- 交付状态：驱动与离线验收完成；真实冒烟/正式测评待另行授权。