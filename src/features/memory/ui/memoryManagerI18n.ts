// 记忆管理面板文案：跟随设置页语言（简 / EN）。
// 仅 UI 展示用，不改 memoryTypes 里的中文常量真源。

import type { MemoryType, Sensitivity, SubjectType } from "../memoryTypes";
import {
  loadSettingsLanguage,
  type SettingsLanguage
} from "../../settings/settingsI18n";

type MemoryManagerCopy = {
  eyebrow: string;
  title: string;
  close: string;
  searchPlaceholder: string;
  all: string;
  clearAll: string;
  clearSection: string;
  done: string;
  localSynced: string;
  emptyTitle: string;
  emptyText: string;
  emptySearchTitle: string;
  emptySearchText: string;
  confidence: string;
  confirmCancel: string;
  confirmClearAllTitle: string;
  confirmClearAllText: string;
  confirmClearSectionTitle: string;
  confirmClearSectionText: string;
  confirmDanger: string;
  deleteAria: string;
  typeLabels: Record<MemoryType, string>;
  subjectLabels: Record<SubjectType, string>;
  sensitivityLabels: Record<Sensitivity, string>;
};

const MEMORY_MANAGER_COPY: Record<SettingsLanguage, MemoryManagerCopy> = {
  "zh-CN": {
    eyebrow: "本地长期记忆",
    title: "记忆管理",
    close: "关闭记忆管理",
    searchPlaceholder: "搜索记忆内容…",
    all: "全部",
    clearAll: "清空全部记忆",
    clearSection: "清空本区",
    done: "完成",
    localSynced: "本地已同步",
    emptyTitle: "暂无记忆条目",
    emptyText: "对话中确认过的事实会按分区落在这里。",
    emptySearchTitle: "没有匹配的记忆",
    emptySearchText: "试试换个关键词，或切换左侧分区。",
    confidence: "置信度",
    confirmCancel: "取消",
    confirmClearAllTitle: "清空全部记忆？",
    confirmClearAllText: "此操作不可撤销，所有分区的本地记忆都会被删除。",
    confirmClearSectionTitle: "清空本区记忆？",
    confirmClearSectionText: "将删除当前分区下的全部条目，此操作不可撤销。",
    confirmDanger: "确认清空",
    deleteAria: "删除该条记忆",
    typeLabels: {
      userProfile: "用户画像",
      emotionTrend: "情绪状态",
      longTermGoal: "长期目标",
      healthRecord: "健康档案",
      relationship: "人际关系",
      preference: "偏好习惯",
      task: "任务待办",
      knowledgeCache: "专业知识缓存",
      agentRelationship: "VOID 与用户"
    },
    subjectLabels: {
      self: "用户本人",
      relative: "亲属",
      friend: "朋友",
      other: "其他"
    },
    sensitivityLabels: {
      normal: "普通",
      sensitive: "敏感",
      highSensitive: "高敏感"
    }
  },
  "en-US": {
    eyebrow: "Local long-term memory",
    title: "Memory manager",
    close: "Close memory manager",
    searchPlaceholder: "Search memories…",
    all: "All",
    clearAll: "Clear all memories",
    clearSection: "Clear section",
    done: "Done",
    localSynced: "Synced locally",
    emptyTitle: "No memories yet",
    emptyText: "Confirmed facts from conversations will appear here by section.",
    emptySearchTitle: "No matching memories",
    emptySearchText: "Try another keyword or switch the section on the left.",
    confidence: "Confidence",
    confirmCancel: "Cancel",
    confirmClearAllTitle: "Clear all memories?",
    confirmClearAllText: "This cannot be undone. Every local memory in every section will be deleted.",
    confirmClearSectionTitle: "Clear this section?",
    confirmClearSectionText: "All entries in the current section will be deleted. This cannot be undone.",
    confirmDanger: "Clear",
    deleteAria: "Delete this memory",
    typeLabels: {
      userProfile: "User profile",
      emotionTrend: "Emotion trend",
      longTermGoal: "Long-term goals",
      healthRecord: "Health records",
      relationship: "Relationships",
      preference: "Preferences",
      task: "Tasks",
      knowledgeCache: "Knowledge cache",
      agentRelationship: "VOID & user"
    },
    subjectLabels: {
      self: "User",
      relative: "Relative",
      friend: "Friend",
      other: "Other"
    },
    sensitivityLabels: {
      normal: "Normal",
      sensitive: "Sensitive",
      highSensitive: "Highly sensitive"
    }
  }
};

export function getMemoryManagerCopy(language?: SettingsLanguage): MemoryManagerCopy {
  const resolvedLanguage = language ?? loadSettingsLanguage();
  return MEMORY_MANAGER_COPY[resolvedLanguage];
}

export function formatMemoryTimestamp(timestamp: number, language: SettingsLanguage): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");

  if (language === "en-US") {
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}
