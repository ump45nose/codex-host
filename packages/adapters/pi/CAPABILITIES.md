# Pi 能力清单（本轮验证范围）

## 基本信息

| 项 | 内容 |
|---|---|
| Harness ID | pi |
| 原生接口与传输方式 | Pi 原生 RPC；gotgenes 公开服务与生命周期事件 |
| 已验证的原生版本 | Pi 1.4.0 / @gotgenes/pi-subagents 25.0.1 源码与父子历史 |
| 交付范围 | 既有 Pi Adapter 的原生子代理、可见进度和流式内容修复 |
| 参考插件 | 复用现有 Pi nicobailon 子代理公共映射及只读 transcript |
| 最后验证 | 2026-10-28，macOS / Node 24；本轮未新增模型请求，既有子代理实测记录保留 |

## 能力

| # | 功能 | 必做 | 优先级 | 结论 | 实现位置 | 证据 | 备注 |
|---|---|---|---|---|---|---|---|
| A1 | Manifest | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A2 | 工厂 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A3 | 检查 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A4 | 创建 Session | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A5 | 执行 Turn | 必做 | P0 | 受限 | Pi RPC / adapter | 请求与自主回合组合回归 | 本轮验证准入、输出和终态；Desktop 应用待验收 |
| A6 | 取消 | 必做 | P0 | 受限 | Pi RPC / adapter | 首消息前取消、旧轮收尾、close 回归 | 不误取消后继自主回合 |
| A7 | 只读快照 | 必做 | P0 | 受限 | pi-history | 真实历史候选回放 | 可见通知、phase 和命令元数据；不宣称所有快照形态已覆盖 |
| A8 | 持久身份 + resume | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| A9 | 错误与并发 | 必做 | P0 | 受限 | Pi RPC / adapter | 异步预检竞争、typed sessionBusy 回归；Pi 1.5.2 实机 steer | 未接纳输入不 dispatch、不自动重试；运行中的用户 Turn 经原生 `steer` 同轮插入（见下文） |
| A10 | 关闭 | 必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B1 | 切换 Model | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B2 | 切换 Thinking | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B3 | 权限模式 | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B4 | 无人值守执行 | 必做（支持或明确拒绝） | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B5 | Fork | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B6 | 跨目录 Fork | 原生有则必做 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B7 | 回滚最后一轮 | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B8 | 工具、命令、文件内容 | 原生有则必做 | P0 | 受限 | pi-history / pi-tool-command | 命令元数据、旧文件输出回归 | 本轮不扩充媒体输出能力 |
| B9 | 审批 | 原生有则必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B10 | 提问 | 原生有则必做 | P0 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B11 | 原生 Subagent | 原生有则必做 | P2 | 受限 | pi-gotgenes-subagents / extension / history | 公开服务、事件、真实父子 JSONL、定向回归 | 身份、状态、只读 transcript；GUI 由集成负责人验收 |
| B12 | 自主 Turn | 原生有则必做 | P1 | 受限 | Pi RPC / adapter lifecycle | 原生 agent_start 到终态组合回归 | 实时观察、稳定身份；应用后 Desktop 验收待完成 |
| B13 | 会话用量 | 原生有则必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B14 | 请求级计量 | 原生有则必做 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B15 | 接收委派 | 必做（验证项） | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| B16 | 向下委派 | 原生有则必做 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C1 | 展示元数据 | 必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C2 | 手动安装指引 | 必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C3 | 版本检查与更新 | 必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C4 | 首次安装 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C5 | 自定义启动路径 | 条件必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C6 | 会话导入 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C7 | 全局用量统计 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| C8 | 账号额度 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D1 | Workspace / 构建 | 预装时必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D2 | 预装清单 | 预装时必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D3 | 加载测试 | 预装时必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D4 | 文档 | 预装时必做 | P1 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |
| D5 | 其他 | 可选 | P2 | 待验证 | 既有 Adapter | 本次未重验 | 只验 B11 及受影响路径 |

## Windows UNC 启动验证范围

- 范围：A4、A8、B5、C5 的进程启动边界；仅处理 Windows UNC 工作目录与标准 Pi CMD launcher 的组合，不改 RPC、Model、Thinking、扩展或历史语义。
- 优先级：P0；结论：受限。`pi-unc-launch.ts` 识别标准 npm 与官方 managed launcher，直接执行同一安装的 Node 入口；无法识别的 batch launcher 明确拒绝，不能静默在 Windows 目录启动。
- 证据：`pi-unc-launch.test.ts` 的 39 项回归覆盖入口与安装归属、Node 选择、原参数与环境、普通目录不变、UNC 新建／恢复／Fork 参数；真实 Node 子进程验证字面 argv、工作目录及 managed 版本与环境选择。Pi command / RPC / Adapter 合计 4 文件 212 项通过。
- 构建与加载：Pi 生产构建、完整类型检查、定向 ESLint / Prettier、boundary 检查通过；候选 Bundle 在临时隔离根经公共 Loader 冷加载，创建／关闭未启动原生进程或请求模型。
- 限制：本地为 macOS / Node 24.18.0；Windows／WSL 实机验证未执行，跨平台合成回放不作为实机通过。保留既有 Native Session 的目录，不把 Windows Pi 自动切换为 WSL 内的 Pi。
- 插件外改动：`docs/architecture/harness-executable-discovery.md` 补充此启动边界；无 Host、Renderer、共享契约或其他 Adapter 改动。

## 受限与已知缺口

本清单补记于既有 Adapter 修复；未影响的能力本轮不重新验收，因此明确列为待验证，不代表原实现不支持。声明子代理修复及下述输出修复实际覆盖范围。Desktop 应用待空闲时重启并验收，不把候选插件通过验证当作已生效。

## 插件外改动

对应 docs/harnesses/pi/pi-subagents.md、pi-progress.md 功能说明及 docs/index.md 链接描述；不新增公共合同或 Harness 专用 Host/Renderer 分支。

## 验证记录

- `npm run typecheck`、`npm run build:typescript` / `build:plugins`、定向 ESLint / Prettier、boundary 检查通过。
- 受影响的 history / RPC / adapter / gotgenes 回归通过；最后的 widget 归属修复重新执行 RPC / adapter 2 文件 148 项通过；既有 nicobailon 子代理分支的前置定向回归亦通过；新增 gotgenes 测试覆盖机器协议、事件生命周期、父历史不能覆盖实时状态、角色保留、真实子文件归属、服务被同进程 child 覆盖、switch/shutdown 与资源回收。
- 在仓库外的临时插件根用公共 Loader 读取真实合成父历史：2 个 collab 卡片，2 份真实子 transcript，无可写 checkpoint。另一次真实新回合（父子均 Astra/high）验证 running → completed、运行中与终态 child transcript、父子结果标记和资源回收；公共投影输出 7 条 collab 消息。未据此宣称 GUI 已显示正确。


- 真实组合测试验证 process 自动唤醒、子代理通知与取消交错、deferred 自主轮及用户替换输入；Pi 1.4 原型无模型复现保留了 agent_settled 后 get_state 为 Streaming 的合法事件次序。精确 AbortSignal error 形状经原始历史重放核对，取消状态不再被重开误标为失败。

## 可见输出验证范围

- `display:true` custom 通知在活动回合和历史恢复中映射为 `commentary`，隐藏消息不展示；原生重试与扩展 `notify` 显示来源和实际内容；`setStatus` 临时页脚更新不写入对话，公共协议没有可替换的状态槽。
- 最终正文保留原生 phase，通知出现在正文之后也不会把答复降为普通进度。流式内容按块核对完成态，补齐合法后缀，已展示内容发生冲突时明确报错。
- 历史命令保留原生有效耗时和退出码；缺失退出码保持未知。
- 限制：完全 idle 时通知保留到下个真实回合，队列溢出明确提示；未持久化的状态不补造历史。
- Node 24.19.0：Pi 四个相关测试文件 183 项通过；流式 helper 与公共投影三个文件 51 项通过；Pi 生产构建、Pi 测试专项类型检查、Host Runtime TypeScript 构建通过。
- 候选 bundle 经公共 Loader 冷加载成功；真实既有历史的两条后台通知恢复为 commentary，命令耗时恢复为 2211ms，最终答复 phase 保持 final_answer；候选 RPC 隔离回放补齐正文和摘要后缀，未调用模型或改动安装文件。

## 自主回合准入验证

原生自动续跑从 `agent_start` 开始向 Host 公布忙状态和实时进度。异步预检后再次仲裁用户输入；已在收尾的旧轮取消不会作用于后继新轮，关闭期间当前轮的真实取消回执仍能完成入账。

2026-10-28：Node 24 下 Pi 生产构建、专项测试类型检查通过，5 个相关测试文件 194 项通过；新增 7 个真实 Adapter＋RPC 组合回归覆盖启动空档、预检竞争、递延回合、显式重试、取消、重试过程及关闭。独立代码审查确认旧轮取消与 closing 终态两项问题已解决。候选插件经公共 Loader 加载及隔离 RPC 回放，确认 `agent_start` 即 busy、自主正文在终态前发出、竞争输入没有下发、唯一终态保留原生身份。未重启或修改运行环境。

## 运行中插入（steer）验证范围（2026-11-14）

- 能力：`capabilities.steer` 实时读取，仅在用户发起的 Turn 的 prompt 已获 Pi 回执 `disposition: "started"`（预检失败时插入不会遗留到下一 Turn）、未开始取消、未进入收尾，且 RPC 会话可写时为 `true`；自主 Turn 与其他情况走 Host 的停止后重发。`turn.steer` 写入前复查同样条件。
- 原生形态：Pi 1.5.2 `docs/rpc-commands.md` 与 `dist/modes/rpc/rpc-mode.js` 的 `steer` 命令（`{type:"steer", message}`，回执 `data.disposition` 为 `queued` / `handled`）；`agent-session.js` 与 `pi-agent-core` 的 `agent-loop.js` 显示插入在当前工具调用结束后、下一次模型请求前送达，同一 Run 结束前（含 `agent_end` 后的续跑检查）都会取走队列。只有 `success:false` 回执视为未收下（如扩展命令不可排队、旧版本未知命令）；写入后超时或断开按回执丢失抛出，不报告为拒绝。
- Run 已过最后一次队列检查才收到的插入会留在 Pi 队列，原本会混入下一次 prompt。Turn 收尾时先等所有插入回执，再按 `get_state.pendingMessageCount` 检查：有残留时用 `clear_queue` 取出，以 `prompt` 在同一 Turn 内续跑；已请求取消时只清除、不续跑（与 Pi 交互模式 Esc 先清队列再中止一致）。续跑 prompt 回执为 `handled`（扩展接管、未开 Run）时 Turn 直接收尾；prompt 被拒时 Turn 失败，错误信息带上该插入原文；续跑预检期间收到的取消会被 Pi 忽略，因此回执 `started` 后再发一次 `abort`。被一并取出的 follow-up 用 `follow_up` 放回。
- 历史：Pi 把每条已送达的插入记成普通 User Entry，冷历史在插入点分轮；实时 Turn 仍用自身 prompt 的 User Entry 作为 nativeTurnRef，checkpoint 取最后一条插入所在原生轮。插入后的 Fork / 撤销由 Host 的 steered Turn 保护处理。
- 实机：本机 Pi 1.5.2，经构建后的 `PiAdapter` 开始要求执行 `sleep 8` 的 Turn（magpie/qoder/qmodel_latest），工具运行中 `turn.steer` 4 ms 返回 accepted；Turn 以 succeeded 结束，最终回复满足插入的要求，未产生自主 Turn，nativeTurnRef 为原 prompt，checkpoint 为插入所在 Entry；冷历史为两轮。另一次用 antigravity 模型时，插入后的模型请求被服务端 403 拒绝，Turn 按 failed 结束，身份与 checkpoint 同样正确。
- 回归：pi-rpc-session.test.ts 新增 8 项（真实 Adapter＋RPC 组合下的同轮插入与身份、原生拒绝为未收下、收尾残留插入同轮续跑、取消时丢弃残留、prompt 回执前不收插入、续跑被扩展接管时收尾、续跑被拒时保留原文、续跑预检中取消时补发 abort），改动前全部失败；Pi 全部 26 个测试文件 410 项通过；`npx tsc -b`、所改文件 ESLint / Prettier、boundary 检查通过。
- 限制：只发送文字，Desktop 图片附件在 steer 中仍只是路径文字。残留插入续跑与取消丢弃只有合成回放，未在真实 Pi 上复现该时序。未在真实 Desktop 上验收插入展示与刷新后的分轮显示。
