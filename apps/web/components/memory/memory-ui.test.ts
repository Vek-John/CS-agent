import { describe, expect, it } from "vitest";
import {
  confidenceLabel,
  memoryKindLabel,
  memoryProfileDetails,
  memoryRecordStateDescription,
  memoryRuntimePresentation,
  memorySourceLabels,
  memoryStatusLabel,
  profileSaveFeedback,
  sourceCategoryLabel,
  visibleMemoryLimitations,
} from "./memory-ui";

describe("memory management display helpers", () => {
  it("keeps source provenance understandable", () => {
    expect(sourceCategoryLabel("USER")).toBe("用户提供");
    expect(sourceCategoryLabel("INFERENCE")).toBe("教练推断");
    expect(sourceCategoryLabel("EVIDENCE")).toBe("可追溯证据");
  });

  it("bounds confidence and provides stable labels for unknown values", () => {
    expect(confidenceLabel(0.876)).toBe("88%");
    expect(confidenceLabel(2)).toBe("100%");
    expect(confidenceLabel(null)).toBe("未提供");
    expect(memoryStatusLabel("CANDIDATE")).toBe("待确认");
    expect(memoryKindLabel("LEARNING_THREAD")).toBe("学习主题");
    expect(memoryStatusLabel("future-status")).toBe("future-status");
  });

  it("presents localhost process memory as a supported temporary mode", () => {
    expect(memoryRuntimePresentation("IN_MEMORY", "LOCAL_IN_MEMORY_STORAGE")).toEqual({
      localNote: "localhost 使用临时的进程内存储；重启本地服务后会清空。",
    });
    expect(visibleMemoryLimitations([
      "LOCAL_IN_MEMORY_STORAGE",
      "职业证据暂不可用",
      "LOCAL_IN_MEMORY_STORAGE",
    ])).toEqual(["职业证据暂不可用"]);
    expect(memoryRuntimePresentation("UNAVAILABLE", "POSTGRES_EXECUTOR_NOT_CONFIGURED")).toEqual({
      warning: "POSTGRES_EXECUTOR_NOT_CONFIGURED",
    });
  });

  it("keeps profile feedback specific and excludes profiles from Agent Brief", () => {
    expect(profileSaveFeedback(false)).toBe("资料已保存。这是你管理的资料，不会进入 Agent Brief。");
    expect(profileSaveFeedback(true)).toBe("资料没有变化，已确认当前内容；不会进入 Agent Brief。");
    expect(memoryKindLabel("PROFILE")).toBe("用户资料");
    expect(memoryRecordStateDescription({ kind: "PROFILE", status: "CONFIRMED", active: true }))
      .toBe("用户管理资料，不进入 Agent Brief");
    expect(memoryRecordStateDescription({ kind: "HABIT", status: "ACTIVE", active: true }))
      .toBe("会影响后续教练优先级");
  });

  it("uses profile labels, preserves extension keys, and deduplicates visible sources", () => {
    expect(memoryProfileDetails({
      displayName: "小林",
      role: "support",
      primaryMap: "Mirage",
      learningGoal: "等待补枪",
      yearsPlaying: 3,
    })).toBe("称呼：小林 · 常用定位：support · 常练地图：Mirage · 当前学习目标：等待补枪 · yearsPlaying：3");
    expect(memorySourceLabels([
      { namespace: "USER_PROFILE", label: "explicit user profile" },
      { namespace: "USER_PROFILE", label: "explicit user profile" },
      { namespace: "DEMO_FACT" },
    ])).toEqual(["explicit user profile", "DEMO_FACT"]);
  });
});
