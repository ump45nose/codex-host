export interface StashUiStrings {
  sectionTitle: string;
  sectionEmpty: string;
  badgeDue: string;
  menuStash: string;
  menuUnstash: string;
  menuSetDue: string;
  duePopoverTitle: string;
  dueTomorrow: string;
  dueIn3Days: string;
  dueNextMonday: string;
  dueCustom: string;
  dueClear: string;
  dueApply: string;
  dueCancel: string;
  notifyTitleOne: string;
  notifyTitleMany: (count: number) => string;
}

export const ZH: StashUiStrings = {
  sectionTitle: "收纳箱",
  sectionEmpty: "暂无收纳的会话",
  badgeDue: "到期",
  menuStash: "收纳",
  menuUnstash: "移出收纳箱",
  menuSetDue: "设置恢复日期",
  duePopoverTitle: "恢复日期",
  dueTomorrow: "明天",
  dueIn3Days: "3 天后",
  dueNextMonday: "下周一",
  dueCustom: "自定义…",
  dueClear: "不设日期",
  dueApply: "应用",
  dueCancel: "取消",
  notifyTitleOne: "收纳箱：有会话到期",
  notifyTitleMany: (count) => `收纳箱：${count} 个会话到期`,
};

export const EN: StashUiStrings = {
  sectionTitle: "Stash",
  sectionEmpty: "No stashed threads",
  badgeDue: "Due",
  menuStash: "Stash",
  menuUnstash: "Remove from stash",
  menuSetDue: "Set resume date",
  duePopoverTitle: "Resume date",
  dueTomorrow: "Tomorrow",
  dueIn3Days: "In 3 days",
  dueNextMonday: "Next Monday",
  dueCustom: "Custom…",
  dueClear: "No date",
  dueApply: "Apply",
  dueCancel: "Cancel",
  notifyTitleOne: "Stash: a thread is due",
  notifyTitleMany: (count) => `Stash: ${count} threads due`,
};

export function pickStrings(locale: string | null | undefined): StashUiStrings {
  const value = (locale ?? "").toLowerCase();
  if (value.startsWith("zh")) return ZH;
  return EN;
}
