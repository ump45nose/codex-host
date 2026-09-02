/**
 * 判断指定 Host 是否承载 CodexHost 私有 RPC。
 *
 * 官方自动发现的 SSH Host 只运行原生 Codex app-server，向其发送
 * `codexhost/*` 会得到 unknown variant，并可能把原生任务误锁为加载失败。
 */
export function supportsCodexHostPrivateRpc(hostId: string | null): hostId is string {
  if (!hostId) return false;
  return !hostId.startsWith("remote-ssh-discovered:");
}
