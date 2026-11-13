# Pet（avatar-overlay）集成

Codex Desktop 的 Pet 窗口（`app://-/index.html?initialRoute=%2Favatar-overlay`）自带会话卡片栈：本机与已连接远端的进行中、待处理、未读会话都以原生卡片显示，折叠、展开、滑动关闭和回复均为原生能力。codexhost 不另建会话列表，只做以下几件事。

## 外部 Harness 卡片图标

- 主窗口在侧栏会话变化时，把外部 Harness 会话写入 `localStorage` 的 `codexhost.pets-thread-agents.v1`（键为 `hostId:threadId`，值为 Agent），并把插件图标写入 `codexhost.pets-harness-catalog.v1`。内容不变时不重写。
- Pet 读取原生卡片的 `data-avatar-overlay-activity-stack-item`（`local:local:<id>` 或 `remote-host:<hostId>:<id>`），给外部 Harness 卡片加 `data-codexhost-pets-agent` 属性；图标由样式表在标题前的 `::before` 中绘制。原生节点只多一个属性，不插入子节点。Codex 会话不加图标。
- 从 Quick Chat 发起的会话，卡片在会话建好后仍保留 `client-new-thread:<uuid>`。真实会话由原生通知的 `notificationPreferenceId` 给出；Pet 从卡片栈组件的 `notifications` prop 读取这一映射后再查 Agent。

## 会话栈最大高度

- Codex 在 Pet chunk 中写死了卡片栈的可视高度：未展示 Quick Chat 时为 208px，展示时为工作区高度一半减 52px。
- `desktop-control` 连接 Pet 页面时，通过 CDP `Fetch` 拦截 `app://*/assets/async/*.js`，把 `activityStackMaxViewportHeight$` 的表达式改为先调用 `globalThis.__codexhostPetsStackMaxHeight(quickChat, 原生值)`，并以原生值兜底（`avatar-overlay-chunk-patch.ts`）。拦截期间关闭 HTTP 缓存，因为缓存命中的 `app://` 脚本不会经过 `Fetch`。
- 若连接时 Pet 已加载完毕，会重新加载一次；重新加载前可见的 Pet，会经主窗口发送 `avatar-overlay-open` 重新打开。每个 Pet target 只重新加载一次。
- Pet 内的钩子读取设置 → 通用 → 侧边栏 →「Pet 会话栈最大高度」（`codexhost.pets-stack-max-height.v1`，默认 600px，范围 200–1600px）。实际高度不超过工作区高度减 240px（吉祥物、控制行与边距），也不低于一张卡片的 56px。
- Codex 只在收到布局时重算高度，所以修改设置后，Pet 会重放最近一次 `avatar-overlay-layout-changed` 消息，立即生效。
- Codex 更新后若表达式不再匹配，chunk 原样加载，卡片栈退回原生高度；这是兼容性审计要检查的位置。

## Quick Chat 的位置与 Agent 选择

- 仅在 Quick Chat 处于 `composing` 状态时，在原生 `[data-above-composer-portal]` 中显示胶囊；菜单上半部分选位置（本机或远端项目），下半部分选该位置可用的 Agent。Agent 存入 Pet 自己的 `codexhost.pets-quick-chat-agent.v1`，位置存入 `codexhost.pets-quick-chat-target.v1`，不影响主窗口的新建会话默认值。
- 主窗口从侧栏远端项目行的原生 `group` prop 读取项目（hostId、projectId、路径、名称），连同主机地球颜色与该主机已安装的 Harness，写入 `codexhost.pets-remote-projects.v1`。
- Codex 的 Quick Chat 只在本机无项目处新建会话。`desktop-control` 改写同一个 Pet chunk，把新建目标改为先调用 `globalThis.__codexhostQuickChatTarget(clientThreadId)`：选了远端项目时返回原生支持的 `{ type: "remoteProject", hostId, projectId, path }`，否则沿用原生的本机无项目目标。远端没有无项目会话，所以远端位置必须选具体项目。所选 Agent 不在该主机上时退回 Codex。
- 胶囊与菜单在 `mousedown` 时阻止默认行为，避免编辑器失焦后原生退出 `composing`。
- 发送时改写 `startConversation` capnweb 帧中的模型为 `encodeHarnessPluginRoute({ harnessId })`；选择 Codex 时不改写。Pet 经同一个 `connect-app-host` 端口访问所有主机，远端会话的帧同样经过这一改写。

## 顶部活动会话条

- 主窗口只把运行中、待确认、未读与正在查看的会话放进条中，数据来自侧栏原生行。Codex 同时挂载多个页面，条挂在 `data-app-shell-active-page="true"` 的页面里。
- 每排 5 个，默认两排（设置 → 通用 → 侧边栏 →「会话标签双排显示」，关闭后一排）。放不下时最后一格变为 `+N`，点开为菜单；正在查看的会话总留在可见格中。
- 远端会话不显示设备名，改为显示 Codex 的地球图标，颜色取自侧栏远端项目图标的 `--remote-host-globe-color`；设备名留在悬停提示里。
