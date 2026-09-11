# ZCode Weekend Plan 接入

CodexHost 将 ZCode 当作 **模型供应商**，而不是新的 Coding Agent。完整链路如下：

```text
ZCode Weekend / Coding Plan
  -> ZCode Proxy（OpenAI / Anthropic / Responses）
  -> Codex CLI 或 OpenCode
  -> CodexHost
  -> Codex Desktop UI
```

这样可以继续复用 Codex/OpenCode 的原生 Session、工具、审批、历史与恢复能力。CodexHost 不读取或保存 ZCode OAuth 凭据；登录状态仍由 [ZCode Proxy](https://github.com/TriDefender/zcode-api) 管理。[zcode-cli](https://github.com/kingsword09/zcode-cli) 是另一套独立 Agent Runtime，不是这条 Provider 链路的运行依赖。

## 使用

1. 从 ZCode Proxy Release 安装与你平台匹配的程序，完成登录并启动本地代理。默认地址为 `http://127.0.0.1:8080`。
2. 通过 `codexhost` 启动 Codex Desktop。
3. 在 Codex 账号选择器中选择 **ZCode Weekend Plan**，或选择 OpenCode 后从模型列表中选择 **ZCode Weekend Plan / GLM**。

Launcher 默认传入 `CODEXHOST_ZCODE_ENABLED=auto`。可在启动 `codexhost` 前覆盖以下环境变量：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEXHOST_ZCODE_ENABLED` | `auto` | `0`/`false`/`off` 可完全禁用接入 |
| `CODEXHOST_ZCODE_BASE_URL` | `http://127.0.0.1:8080/v1` | ZCode Proxy 的 Responses/OpenAI 兼容端点 |
| `CODEXHOST_ZCODE_API_KEY` | 本地占位值 | 代理启用访问密钥时设置；不会写入 Codex 配置文件 |
| `CODEXHOST_ZCODE_MODELS` | 内置 GLM 列表 | 逗号分隔的模型 ID |
| `CODEXHOST_ZCODE_DEFAULT_MODEL` | `glm-5.3` | Codex 隔离账号的默认模型 |

## 隔离与恢复

- 官方 Codex 账号继续使用原来的 `~/.codex`，不会被改写。
- ZCode Codex 配置位于 CodexHost 数据目录下的 `codex-homes/zcode/config.toml`。
- 配置文件只声明 `env_key = "ZCODE_API_KEY"`，不会落盘代理密钥或 OAuth 凭据。
- OpenCode 配置通过受管 Server 的 `OPENCODE_CONFIG_CONTENT` 合并注入；已有 Provider、默认模型和权限设置优先保留。
- 已创建的任务会继续绑定创建时使用的 Codex 账号或 OpenCode Session，不会因切换选择器而改路由。
