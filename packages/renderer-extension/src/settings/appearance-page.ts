import {
  REASONING_SOFT_WRAP_CHANGE_EVENT,
  readReasoningTranscriptSoftWrap,
  setReasoningTranscriptSoftWrap,
} from "../renderer-transcript-dom.js";
import {
  isArchiveChildrenMode,
  readArchiveChildrenMode,
  setArchiveChildrenMode,
  subscribeArchiveChildrenMode,
} from "../renderer-archive-children-preference.js";
import {
  readSidebarStashEnabledPreference,
  setSidebarStashEnabledPreference,
  subscribeSidebarStashEnabledPreference,
} from "../renderer-sidebar-stash.js";
import {
  readSidebarAutoCollapsePreference,
  setSidebarAutoCollapsePreference,
  subscribeSidebarAutoCollapsePreference,
} from "../renderer-sidebar-overlay.js";
import {
  readTopTabsEnabledPreference,
  setTopTabsEnabledPreference,
  subscribeTopTabsPreference,
} from "../renderer-top-tabs.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { mountDelegationCapacityControls } from "./delegation-capacity-controls.js";
import { mountIdleReleaseControls } from "./idle-release-controls.js";
import type { LoadedSessionsClient } from "./loaded-sessions-table.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSelect,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";
import { mountUserInstructionsControls } from "./user-instructions-controls.js";

export function createAppearanceSettingsPage(
  messages: RendererSettingsMessages,
  getLoadedSessionsClient: () => LoadedSessionsClient | null = () => null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "appearance",
    label: messages.pageLabels.appearance,
    icon: "settings",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const ownerWindow = document.defaultView;
      if (!ownerWindow) return;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.appearance;

      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.appearanceDescription;

      const { group, card } = createPreferenceGroup(document, messages.appearanceGroup);
      const softWrapId = preferenceId("reasoning-soft-wrap");
      const row = createPreferenceItem(document, {
        title: messages.reasoningSoftWrapTitle,
        description: messages.reasoningSoftWrapDescription,
        controlId: softWrapId,
      });
      const toggle = createPreferenceSwitch(document, softWrapId, row.description.id);
      toggle.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      toggle.addEventListener("change", () => {
        setReasoningTranscriptSoftWrap(ownerWindow, toggle.checked);
      });
      const sync = (): void => {
        toggle.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      };
      ownerWindow.addEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
      row.item.append(toggle);
      card.append(row.item);

      const sidebar = createPreferenceGroup(document, messages.sidebarGroup);
      const archiveChildrenId = preferenceId("archive-children");
      const archiveChildrenRow = createPreferenceItem(document, {
        title: messages.archiveChildrenTitle,
        description: messages.archiveChildrenDescription,
        controlId: archiveChildrenId,
      });
      const archiveChildren = createPreferenceSelect(document, {
        id: archiveChildrenId,
        describedBy: archiveChildrenRow.description.id,
        options: [
          { value: "ask", label: messages.archiveChildrenAsk },
          { value: "always", label: messages.archiveChildrenAlways },
          { value: "never", label: messages.archiveChildrenNever },
        ],
      });
      archiveChildren.value = readArchiveChildrenMode(ownerWindow);
      archiveChildren.addEventListener("change", () => {
        if (isArchiveChildrenMode(archiveChildren.value)) {
          setArchiveChildrenMode(ownerWindow, archiveChildren.value);
        }
      });
      const disposeArchiveChildren = subscribeArchiveChildrenMode(ownerWindow, () => {
        archiveChildren.value = readArchiveChildrenMode(ownerWindow);
      });
      archiveChildrenRow.item.append(archiveChildren);
      sidebar.card.append(archiveChildrenRow.item);

      const stashId = preferenceId("sidebar-stash");
      const stashRow = createPreferenceItem(document, {
        title: messages.sidebarStashTitle,
        description: messages.sidebarStashDescription,
        controlId: stashId,
      });
      const stashToggle = createPreferenceSwitch(document, stashId, stashRow.description.id);
      stashToggle.checked = readSidebarStashEnabledPreference(ownerWindow);
      stashToggle.addEventListener("change", () => {
        setSidebarStashEnabledPreference(ownerWindow, stashToggle.checked);
      });
      const disposeStashPref = subscribeSidebarStashEnabledPreference(ownerWindow, () => {
        stashToggle.checked = readSidebarStashEnabledPreference(ownerWindow);
      });
      stashRow.item.append(stashToggle);
      sidebar.card.append(stashRow.item);

      const autoCollapseId = preferenceId("sidebar-auto-collapse");
      const autoCollapseRow = createPreferenceItem(document, {
        title: messages.sidebarAutoCollapseTitle,
        description: messages.sidebarAutoCollapseDescription,
        controlId: autoCollapseId,
      });
      const autoCollapseToggle = createPreferenceSwitch(
        document,
        autoCollapseId,
        autoCollapseRow.description.id,
      );
      autoCollapseToggle.checked = readSidebarAutoCollapsePreference(ownerWindow);
      autoCollapseToggle.addEventListener("change", () => {
        setSidebarAutoCollapsePreference(ownerWindow, autoCollapseToggle.checked);
      });
      const disposeOverlayMode = subscribeSidebarAutoCollapsePreference(ownerWindow, () => {
        autoCollapseToggle.checked = readSidebarAutoCollapsePreference(ownerWindow);
      });
      autoCollapseRow.item.append(autoCollapseToggle);
      sidebar.card.append(autoCollapseRow.item);

      const topTabsId = preferenceId("top-tabs-enabled");
      const topTabsRow = createPreferenceItem(document, {
        title: messages.topTabsTitle,
        description: messages.topTabsDescription,
        controlId: topTabsId,
      });
      const topTabsToggle = createPreferenceSwitch(document, topTabsId, topTabsRow.description.id);
      topTabsToggle.checked = readTopTabsEnabledPreference(ownerWindow);
      topTabsToggle.addEventListener("change", () => {
        setTopTabsEnabledPreference(ownerWindow, topTabsToggle.checked);
      });
      const disposeTopTabsPref = subscribeTopTabsPreference(ownerWindow, () => {
        topTabsToggle.checked = readTopTabsEnabledPreference(ownerWindow);
      });
      topTabsRow.item.append(topTabsToggle);
      sidebar.card.append(topTabsRow.item);

      context.content.append(heading, description, group, sidebar.group);
      const disposeIdleRelease = mountIdleReleaseControls(
        context,
        messages,
        getLoadedSessionsClient,
      );
      const disposeDelegationCapacity = mountDelegationCapacityControls(context, messages);
      const disposeUserInstructions = mountUserInstructionsControls(
        context,
        messages,
        getLoadedSessionsClient,
      );
      return () => {
        ownerWindow.removeEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
        disposeArchiveChildren();
        disposeStashPref();
        disposeOverlayMode();
        disposeTopTabsPref();
        disposeIdleRelease();
        disposeDelegationCapacity();
        disposeUserInstructions();
      };
    },
  });
}
