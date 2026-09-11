# ZCode Weekend Plan Harness 接入

ZCode 在 CodexHost 中与 Pi、DeepSeek Harness、OpenCode 并列，是独立 Harness，不是 Codex 账号或 Codex Provider。

调用链如下：

```text
ZCode Weekend Plan
        ↓
zcode app-server（ZCode 原生 NDJSON 协议）
        ↓
ZCode Harness 插件
        ↓
CodexHost / Codex Desktop UI
```

## 前置条件

1. 安装并登录 [ZCode CLI](https://github.com/kingsword09/zcode-cli)。
2. 在 ZCode 自身配置中完成 Weekend Plan 模型配置。
3. 运行 `zcode --version`，确认 CLI 可被 CodexHost 的启动环境找到。

插件直接启动 `zcode app-server`，从原生会话快照读取模型、思考等级与历史消息，并使用 `session/create`、`session/resume`、`session/send` 等原生方法管理任务。它不会修改 Codex 账号，也不依赖 OpenCode。

## 可选环境变量

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEXHOST_ZCODE_COMMAND` | `zcode` | 指定 ZCode CLI 可执行文件路径 |

若 CodexHost 运行在远程机器上，需要在该远程 Host 安装并登录 ZCode；本地安装状态不会自动复制到远程环境。
