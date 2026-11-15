# OptraCall 真实执行链路驱动 · 离线验收记录

日期：2026-11-15（Asia/Shanghai）。证据层级：**离线夹具 + 真实 Host 本地链路**；真实 Provider 鉴权/计费与候选效果**未验证**（待另行授权的真实冒烟）。

## 交付物

新增 OptraCall 执行后端，与现有裸 Pi 受控 worker 并列；runner 的冻结、配对、断言、盲评、结论、回归门禁全部复用。

| 模块 | 职责 |
| --- | --- |
| `src/core/optracall-env.ts` | 双 codeRoot 环境准备与全量哈希身份核验（唯一变量＝目标 skill 包） |
| `src/core/optracall-driver.ts` | Host 生命周期 + 正常任务入口 HTTP 驱动（建项目/任务/上传/消息/终态） |
| `src/core/optracall-evidence.ts` | native 会话 JSONL → 指标/事件流；项目终态只读取证 |
| `src/core/optracall-execution.ts` | 复合执行层：subject 走 OptraCall，judge 走受控 Pi 会话 |
| `src/core/optracall-setup.ts` | 模板加载、凭证读取、配置身份、冻结清单段 |
| `suites/optracall-data-analysis-v1.json` | 产品环境套件（草案，合成模板） |
| `scripts/optracall-host-integration.ts` | 真实 Host API 链路离线验证（无模型调用） |
| `scripts/optracall-model-integration.ts` | 完整模型调用链路离线验证（本地假 Provider） |

CLI：`eval --optracall <checkout> [--optracall-node <node25+>]`；套件声明 `optracall` 段时启用。`run-manifest.json` 增加 `optracall` 冻结段（源 commit、SDK 身份、环境哈希、模板哈希、配置身份，**不含 apiKey**）。

## 实际命令与结果

| 命令 | 结果 |
| --- | --- |
| `npm run check`（tsc --noEmit + 离线测试） | 类型通过；**566/566 通过，0 失败、0 跳过** |
| `node --experimental-strip-types scripts/optracall-host-integration.ts --checkout /Users/huangbo/Dev/OptraCall --node <node26>` | **PASS**：真实 Host 启动（sdk 1.4.0 / transport 8.12.2），真实 HTTP 协议头、配置/项目/任务/上传均通过，上传文件落到真实项目目录 |
| `node --experimental-strip-types scripts/optracall-model-integration.ts --checkout … --node <node26>` | **PASS**：Host→worker→Pi SDK→本地假 Provider→native 会话 JSONL（9 条）→取证解析出最终输出 `OK`、tokens=6；任务终态 completed |
| `node … src/cli/main.ts check --suite suites/optracall-data-analysis-v1.json` | 套件校验通过（计分 1 / 诊断 1 / 负向误触发 1，断言 4） |
| `eval --suite … --model …`（缺 `--optracall`） | 按预期拒绝：「产品环境套件需要 --optracall」 |

新增单测覆盖：环境唯一变量与漂移/新增/符号链接 fail-closed；native JSONL 解析（输出/读取取证/用量/失败读取不计入）；终态采集（020/060 入 workspace、010 只留哈希、native 整份拷贝）；驱动协议头与错误映射、终态轮询/超时/Host 退出；复合执行成功/baseline/单样本失败不停批/skill 身份不符停批/Host 故障停批；装配模板/凭证/配置身份脱敏。

## 源码与依赖指纹

- skill-eval 基线 HEAD：`e0f2b65e4ad57780e468e7ba057482582fc417b2`（本次为其上的未提交增量）。
- OptraCall checkout HEAD：`f5592518cbe6d27552501a3ed46a757c363857f0`（clean）。
- Pi SDK：`@earendil-works/pi-coding-agent` 1.4.0（Host `host-ready` 与 `/api/health` 实测一致）。
- 解释器：驱动进程 Node v24.21.0；Host/worker Node v26.0.0（OptraCall 要求 25+）。
- 离线测试守卫：临时空 HOME、清除凭证环境变量、拒绝真实网络；驱动单测用注入 fetch 与桩 Host，不触网。

## 已验证 / 未验证

**已验证（离线）：**
- 驱动与真实 OptraCall Host 的 HTTP 协议一致（真实服务，非桩）。
- 完整模型调用链路在本地假 Provider 下跑通，native JSONL 格式与取证解析兼容。
- 唯一变量环境准备与身份核验；失败/Host 故障的分母与停批语义；judge 复用受控会话。
- 计分/报告/回归引擎无回归（566/566）。

**未验证（明确保留）：**
- 真实 Provider 鉴权、模型修订、计费配额与现金账单。
- data-analysis skill 在 OptraCall 真实模型下的激活率与增益（候选效果）。
- CLI `eval --optracall` 真实端到端（含凭证注入与评委轮次）——核心模块已离线验证，CLI 真实路径待真实冒烟。
- 产品环境套件的正式区分度校准（当前为草案，合成模板；numeric 断言措辞敏感性待真实运行校准）。
- 受管/protected 执行模式、联网工具、MCP/用户扩展（本驱动走普通 unmanaged 任务，两侧默认关闭这些能力）。

## 已知限制与边界

- 产品正常任务**非 OS 沙箱**：worker 以用户权限运行，010 禁读为提示词软约束。隔离依靠独立评测根、每次 attempt 全新项目、基线物理移除 skill、污染取证；与裸 Pi 受控会话的 OS 网络/文件拒绝不同，报告须注明。
- 环境排除 `node_modules/.git/dist/.runtime/.local`：`.local` 私有材料绝不复制；`.runtime` 运行时 Python 不复制，评测用系统 python3（两侧一致）。真实分析任务若依赖 OptraCall 托管 Python，需另行 provisioning。
- v1 被评模型固定 `minimax-cn/MiniMax-M3.1-Flash`（受控成本 profile subject）；其他模型需先扩展费率与额度核验。
- 评测 Host 为独立实例（临时端口），不连接/停止/修改用户正在运行的试用服务或 Mac mini 服务。

## 下一步（另行授权）

真实最小冒烟：1 题 × 2 侧 × 1 次 + 1 轮盲评，用真实模型核实激活取证、交付与用量；确认模型、规模与费用后执行。正式测评与消融再另冻结。