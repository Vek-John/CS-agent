import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ReviewHistorySidebar, type ReviewHistorySidebarProps } from "./review-history-sidebar";

function nodes(tree: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children as ReactNode)];
}

function props(): ReviewHistorySidebarProps {
  return {
    items: [{ id: "review-a", demoId: "demo-a", title: "Mirage 复盘", playerName: "Player", originalFilename: "match.dem",
      updatedAt: "2026-09-26T00:00:00Z", createdAt: "2026-09-26T00:00:00Z", status: "IN_PROGRESS", progress: 25,
      demoStatus: "READY", completedCueCount: 1, totalCueCount: 4 }],
    activeReviewId: "review-a", onImportDemo: vi.fn(), onOpenReview: vi.fn(), onRenameReview: vi.fn(),
    onReanalyzeReview: vi.fn(), onCreateForAnotherPlayer: vi.fn(), onStartOver: vi.fn(), onDeleteReview: vi.fn(),
    onDeleteDemo: vi.fn(), onOpenLibrary: vi.fn(), onOpenStats: vi.fn(),
  };
}

/** Real React hooks and rendered callbacks; no browser or assistive-technology claim. */
function capture(input: ReviewHistorySidebarProps) {
  let tree: ReactNode;
  function Capture() { tree = ReviewHistorySidebar(input); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { tree, html };
}

it("does not offer checkpoint retry without a retry owner", () => {
  const { html } = capture({ ...props(), error: "历史列表读取失败。" });
  expect(html).not.toContain("重试保存");
  expect(html).not.toContain("恢复点保存未确认");
  expect(html).toContain("历史列表读取失败。");
  expect(html).toContain("Mirage 复盘");
});

it("offers the actual retry callback independently from an ordinary history error", () => {
  const input = props(); const onRetry = vi.fn();
  const view = capture({ ...input, checkpointRetry: { busy: false, onRetry } });
  const status = nodes(view.tree).find(node => node.props.role === "status")!;
  const retry = nodes(status).find(node => node.type === "button" && node.props.children === "重试保存")!;
  expect(retry.props.type).toBe("button");
  expect(retry.props.disabled).toBe(false);
  expect(view.html).toContain("恢复点保存未确认，当前讲解仍保留。");
  (retry.props.onClick as () => void)();
  expect(onRetry).toHaveBeenCalledOnce();
  expect(input.onOpenReview).not.toHaveBeenCalled();
  expect(input.onReanalyzeReview).not.toHaveBeenCalled();
});

it("announces retrying and disables the native button while preserving the history list and error", () => {
  const onRetry = vi.fn();
  const view = capture({ ...props(), error: "历史列表读取失败。", checkpointRetry: { busy: true, onRetry } });
  const retry = nodes(view.tree).find(node => node.type === "button" && node.props.children === "正在重试…")!;
  expect(retry.props.disabled).toBe(true);
  expect(view.html).toMatch(/<button[^>]*disabled=""[^>]*>正在重试…<\/button>/);
  expect(view.html).toContain("历史列表读取失败。");
  expect(view.html).toContain("Mirage 复盘");
  expect(view.html).toContain('aria-current="page"');
  expect(onRetry).not.toHaveBeenCalled();
});
