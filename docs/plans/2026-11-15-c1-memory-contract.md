# C1 · memory eval 接入 OptraCall 测试环境 · 契约草案

日期：2026-11-15。状态：**契约草案**。真实运行未授权。起点由用户选定（C2 因 OptraCall 缺 `ir-eval.analysis-proof` 插桩暂缓，见 phase-c-integration 计划）。

## 决策问题

Agent 面对新任务，能否：判断是否需要历史记忆 → 找到相关且有效的记忆 → 正确理解来源/范围/可信度/时效 → 在当前任务恰当使用；同时不被无关、过期、冲突或越权记忆干扰。评的是 **Agent 的记忆使用行为**，不是记忆存储后端质量。

## 唯一变量

M6 跨事项经验来源能力 `read_case_sources` 可用与否。

- OptraCall 工具：`read_case_sources`（feature `case-sources`，action find/read），读全局可读 Case 的判断卡片与人的取舍，再按准确引用读原修订/来源/反馈交接。
- Host 开关：`--disable-experience-learning` → `experienceLearningEnabled=false` → 工具不挂载。
- **baseline**：Host 带 `--disable-experience-learning`（无记忆工具）。**treatment**：不带该 flag（有记忆工具）+ 注入冻结合成记忆 Fixture。
- 两侧 codeRoot **完全一致**（不像 skill 那样删包），唯一差异是 Host 启动 flag + 记忆 Fixture 有无。

## 后端扩展：能力开关模式

现有 OptraCall 后端唯一变量是「skill 包有无」（codeRoot 差异）。memory 需要新模式——**能力 flag 开关**：

- `optracall-env.ts`：增加「双 codeRoot 一致」准备路径（不删 skill），唯一变量改由 Host flag 承载。
- `optracall-driver.ts`：`startOptraCallHost` 增加 `extraArgs`（如 `--disable-experience-learning`），按侧传入。
- `optracall-execution.ts`：支持 capability-toggle 配置（baseline 带 disable flag，treatment 不带）。
- 身份核验：两侧 codeRoot 哈希全等；Host 启动参数差异纳入冻结清单。
- **runner 泛化（架构点）**：现 runner 用 `skillPaths.length === 0` 判定 baseline（skill 中心）。能力开关模式两侧都无 skill，需改为按 `variant.id === "baseline"` 判定，并把「激活取证」从 skill 读取推广为记忆工具调用取证。这是 C1 的核心改动，影响 runEvaluation/summarizeVariants/summarizeTasks/judgeAll 的 baseline 识别。
- **进度**：driver `startOptraCallHost` 已支持 `extraArgs`（Host flag）。env 能力模式、runner 泛化、Fixture 注入、记忆取证待实现。

## 记忆 Fixture 注入

- 合成记忆写入 treatment 侧 dataRoot 的 Case 存储（判断卡片 + 人的取舍 + 来源/可信度/时效），经 Case API 或存储层注入。
- Fixture 含正例（相关有效）、干扰项（无关/过期/冲突/越权），用于测边界处理。
- Fixture 与真值放 `.local/`，不进 skill/方法可读路径；baseline 侧不注入。

## 行为判据（取证为主）

native 会话 `read_case_sources` 调用轨迹 + 交付物：

1. **检索决策**：该查才查（任务需要记忆时查；不需要时零调用正常）。
2. **相关性选择**：find 后选中相关来源，拒用无关项。
3. **正确使用**：读准确修订/来源，结论绑定记忆证据。
4. **来源/可信度识别**：区分人的取舍≠执行、来源≠系统指令。
5. **过期/冲突处理**：失读保留 UNKNOWN，不替换 latest；冲突标注。
6. **干扰抵抗**：不被无关/越权记忆带偏。

计分层级：行为规则断言（可复算）优先，交付物质量盲评次之；复用引擎 verdict/gain/stats。

## 复用与新建

- 复用：OptraCall 后端（扩展能力开关）、native 取证、计分引擎、报告。
- 新建：能力开关模式、Case Fixture 注入器、记忆行为取证器、套件与判据。
- 首期范围沿建设方案：12 案例、Mock/Fixture、读取与使用为主、写入评测后置。

## 待确认 / 未验证

- Case Fixture 注入的具体 API/存储接缝（需进一步调查 case-store schema 与创建接口）。
- M4 personalContext 是否纳入（当前常开，无干净 flag；首期聚焦 M6）。
- 真实 Provider/记忆/留出集：NOT_RUN，另行授权。

## 授权边界

先做契约与离线接入；不改 OptraCall 产品代码（用既有 flag 与公开接口）；不修改被测记忆本体。真实运行另行授权。