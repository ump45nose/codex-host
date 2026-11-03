# Claude Code 入口标识

Claude Code 用 `CLAUDE_CODE_ENTRYPOINT` 识别是哪个产品在运行它。Anthropic 据此决定开放哪些功能，并据此归属用量。

## 默认

codexhost 启动的会话报告 `codexhost-sdk`（`packages/adapters/claude-code/src/entrypoint.ts`）。Claude Code 的原生会话选择器会隐藏通用 SDK 入口，这个值让 codexhost 会话仍然可见，同时不冒充交互式 CLI。进程环境中原有的 `CLAUDE_CODE_ENTRYPOINT` 一律被覆盖。

## Claude Desktop 入口（选择加入）

设置 `CODEXHOST_CLAUDE_ENTRYPOINT=claude-desktop` 后，会话改为报告 `claude-desktop`，Claude Code 随之开放 Artifacts 等仅限 Desktop 的工具。2026-11-03 在 macOS 上实测：自带 CLI 与独立安装的 CLI 设置该入口后都会出现 Artifact 工具；发布页面还需要 claude.ai 登录，尚未验证。

- 只接受 `claude-desktop` 这一个值，其他值仍报告 `codexhost-sdk`，不能用来冒充其他客户端。
- 开启期间，连接页的安装检查显示警告：这会向 Anthropic 误报客户端身份，可能与其使用条款冲突，用量也会被记为 Claude Desktop，风险由用户自担。
- 默认关闭，codexhost 不会替用户开启。删除变量并重新打开 Thread 即恢复默认。
