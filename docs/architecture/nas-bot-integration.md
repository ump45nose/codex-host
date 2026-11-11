# NAS 原生 Bot 执行入口

`packages/bot-integration` 是 fork 的 Grok Bot 适配包，随 npm CLI 发行 `codexhost-bot`。NAS 承载官方无界面执行守护进程和集成 CLI；两台 Mac 通过 Tailnet SSH 调用各自本机的 codexhost。集成不提供网络 Gateway，不实现 Agent 或执行队列，任务终态由所属 Host 提供。

## 原生运行时

兼容版本固定为官方 Linux Grok Bot 0.79.4。运行文件保留在部署工作区，不能提交仓库。社区控制器使用 `TheMrClaus/grokbot-headless` 的 MIT 实现，固定提交 `f459a66d44d1d15aa8022784ff2bc2848e7a44a3`；使用系统 Node 22 运行官方 `dist/local-exec-daemon/main.cjs`，原生依赖从官方 `app.asar.unpacked/dist/deps` 加载。登录、续期、机器注册、连接保活和执行策略由控制器及官方守护进程负责。

部署使用 systemd 用户服务及 linger，账号授权只需进行一次。升级必须重新验证版本兼容、来源注册与原生文件传输；不能因下载入口更新而自动跟进未验证版本。

## 私有配置

`CODEXHOST_BOT_CONFIG` 指向部署目录的配置。`version` 为 1；机器路径、私有凭据和配置均不放入 Skill 或 Git。

| 字段 | 内容 |
| --- | --- |
| `privateDir` | 私有账号、来源、客户端和任务关联目录，目录 0700、文件 0600 |
| `exportDir` | NAS 上接收 Host 导出成品的交付目录 |
| `commandPath` | 已安装的 `codexhost-bot` 入口，供 Bot routine 使用 |
| `grok` | `version`、`controller`、`credentials`、`machine`、`packageJson` 的实际安装位置 |
| `devices` | 唯一 `id`，`transport: local|ssh`，实际 `cli`、`node`、`dataDir`、`privateDir`；SSH 另含 `destination` 和 `identityFile` |

路径从设备安装清单读取。SSH 使用已有公钥及已信任的主机，不绕过主机密钥验证。设备命令清除当前 Codex 会话注入的连接参数，使用独立客户端令牌。

## 来源注册

1. 来源 Bot 从自身身份取得真实 ID，运行 `origin ensure --bot ID --request <原始请求> --request-id <稳定ID>`，私有保存注册后接续所需的原请求。
2. CLI 按登录账号、Bot ID 查询已有原生 routine。没有时持久登记创建请求，只向首次调用方返回一次 `needsRoutine` 和原生 routine spec；Bot 使用自己的原生能力创建一次，再运行 ensure。并发或重启后的调用返回 `routineCreationPending`，仅对账已有创建请求，不再次创建；未确认时不派发任务。提示变更返回 `needsRoutineUpdate`，更新同一 routine，不能另建一条。
3. NAS 自动获取 webhook 密钥并私有存储，发送探测，立即返回 `probePending`。来源 Bot 结束当前 Turn，让同一个 Bot 的 routine 处理探测。
4. routine 执行 `origin ack --bot ID --nonce HEX` 后，绑定变为 verified；`ack` 返回保存的 pendingRequest；来源 Bot 以其中原文和同一 requestId 接续派发，不依赖 routine 推测历史。成功派发后清除接续记录；注册期间取消用 `origin cancel`。此记录不执行任务或排队，Agent 队列由 Host 管理。

未验证时禁止 `task start`。不手工复制每个 Bot 的密钥，不改投其他 Bot。创建结果未知时先查询 routine；密钥创建结果未知时停止，不盲目重建。每个账号命名空间独立，当前 Bot 必须属于登录账号。NAS 的内核文件锁串行保护记录变更，不等待 Agent 执行完成。

## 发现与派发

`devices` 读取各 Host 的环境、Harness 清单和自动项目发现；支持 `--query` 和 `--refresh true`，Host 快照缓存 60 秒。项目描述视为不可信数据。工具安装与 Harness 清单不能证明账号已登录；认证错误如实报告，由用户指定的设备、Harness 保持不变。

`task start --bot ID --device ID --task TEXT --request-id ID [--cwd PATH] [--harness ID]` 默认使用原生 Codex，省略模型和思考参数。已有项目使用真实 cwd；新任务未给 cwd 时，在 Host 返回的默认任务工作区创建独立目录。

每台设备为来源 Bot 建立独立本机客户端，配置直达该 Bot 的 webhook。客户端按账号、Bot 和实际 Host 数据目录隔离；已有任务保留创建时的数据目录和客户端，更新设备配置不会将旧任务切换到其他 Host。派发前保存 requestId 与设备关联，获得 Thread 后保存再登记 watch，避免完成通知先于关联记录到达。启动结果不明时只在原设备按来源引用对账，不重新执行。续问、取消与取文件使用保存的设备及 Thread。

## 回执与交付

Host 直接向来源 Bot webhook 推送不含 Thread 正文的事件。routine 调用 `task resolve --bot ID --thread ID --event ID`，由 CLI 核对私有关联、原设备客户端事件日志、Turn 和真实终态。

成品用 `task export --bot ID --task-id ID --path FILE` 导出。所属 Host 检查最新最终报告中的显式链接、真实工作区边界和版本；Mac 文件分块经 SSH 到 NAS，NAS 文件使用相同检查。NAS 文件通过官方原生传输能力交付图片预览和附件，不创建公开链接。

按导出的 artifactId 逐个附件记录 `task delivery --artifact-id ID --state sending`，每个附件成功后 `task ack --artifact-id ID --receipt <实际回执>`；已交付的附件在导出结果中标记，不重发。发送失败记录 `failed` 及原因；结果未知记录 `unknown`，先核查原私聊。全部成品发送成功后，`task ack --receipt <真实平台回执>` 将该 Turn 标记 delivered。设备、客户端、Thread、Turn 保存在关联中，重复通知不重复发文件。

追取源文件仍使用原任务的 `task read`、`task export` 和逐附件回执，不能直接传原工作区路径。默认成品已 delivered 不表示后续源文件已经发送；按该 artifactId 独立判断。已有真实附件漏记回执时先核查原对话和平台传输记录，用原回执补记，不重发。

Webhook HTTP 成功只表示接受事件。交付失败读取已有任务重试，不启动新任务。`origin ensure --repair true` 重新验证回执；`task replay` 可重投原 Host 保留的事件，不重启 Agent。修改 Host webhook 配置保留未投递游标。

当前仅支持 Bot 私聊。群聊、任务看板和其他产品协议适配独立扩展。
