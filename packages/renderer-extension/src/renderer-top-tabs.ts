export {
  TOP_TABS_ROOT_ATTRIBUTE,
  TOP_TAB_ATTRIBUTE,
  collectSidebarThreads,
  computeAgentIconSignature,
  computeTopTabsDensity,
  installRendererTopTabs,
  isUnreadOrActiveSessionStatus,
  resolveShortHostLabel,
  rollupTopTabStatus,
  type ActiveSessionStripItem,
  type InstallRendererTopTabsOptions,
  type RendererTopTabsHandle,
  type SidebarThreadSnapshot,
  type TopTabStatus,
  type TopTabsDensityMode,
} from "./renderer-top-tabs/index.js";
export {
  DEFAULT_TOP_TABS_ENABLED,
  TOP_TABS_ENABLED_STORAGE_KEY,
  TOP_TABS_PREFERENCE_CHANGE_EVENT,
  readTopTabsEnabledPreference,
  setTopTabsEnabledPreference,
  subscribeTopTabsPreference,
  writeTopTabsEnabledPreference,
} from "./renderer-top-tabs/preference.js";
export {
  TOP_TABS_STYLE_ID,
  buildTopTabsCss,
  ensureTopTabsStyles,
} from "./renderer-top-tabs/style.js";
