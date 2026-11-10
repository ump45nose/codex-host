/**
 * The entrypoint codexhost reports for Claude Code sessions it starts. Claude Code
 * hides generic SDK entrypoints from its native Session picker; this one keeps
 * codexhost Sessions discoverable without claiming to be the interactive CLI.
 */
export const CODEXHOST_ENTRYPOINT = "codexhost-sdk";

/**
 * Opt-in: report the Claude Desktop entrypoint instead, which makes Claude Code
 * enable the Desktop-only tools (such as Artifacts). Only this one value is
 * accepted, so it cannot be used to claim any other client.
 */
export const CLAUDE_ENTRYPOINT_ENV = "CODEXHOST_CLAUDE_ENTRYPOINT";
const DESKTOP_ENTRYPOINT = "claude-desktop";

export function claudeDesktopEntrypointEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment[CLAUDE_ENTRYPOINT_ENV] === DESKTOP_ENTRYPOINT;
}

export function claudeCodeEntrypoint(environment: NodeJS.ProcessEnv): string {
  return claudeDesktopEntrypointEnabled(environment) ? DESKTOP_ENTRYPOINT : CODEXHOST_ENTRYPOINT;
}

/** Shown on the connection page while the opt-in is on. */
export const DESKTOP_ENTRYPOINT_NOTICE = {
  en: `${CLAUDE_ENTRYPOINT_ENV}=${DESKTOP_ENTRYPOINT} is set: Claude Code sessions identify themselves to Anthropic as Claude Desktop to enable Desktop-only tools such as Artifacts. This misreports the client, may conflict with Anthropic's terms, and is at your own risk. Unset it to report codexhost again.`,
  "zh-CN": `已设置 ${CLAUDE_ENTRYPOINT_ENV}=${DESKTOP_ENTRYPOINT}：Claude Code 会话会以 Claude Desktop 的身份向 Anthropic 报告，以启用 Artifacts 等仅限 Desktop 的工具。这会误报客户端身份，可能与 Anthropic 的使用条款冲突，风险自负。删除该变量即恢复以 codexhost 身份报告。`,
};
