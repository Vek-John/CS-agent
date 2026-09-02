"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  ChevronLeft,
  FilePlus2,
  Library,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  Search,
  Trash2,
  UserRoundPlus,
} from "lucide-react";
import styles from "./review-history-sidebar.module.css";

export type ReviewHistoryStatus = "PREPARING" | "READY" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "STALE";

/** This is intentionally a browser DTO: no file paths, capabilities, or artifacts. */
export interface ReviewHistoryItem {
  readonly id: string;
  readonly demoId: string;
  readonly title: string;
  readonly playerName: string;
  readonly originalFilename: string;
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly status: ReviewHistoryStatus;
  readonly progress: number;
  readonly map?: string;
  readonly scoreText?: string;
  readonly demoStatus: "IMPORTING" | "READY" | "MISSING" | "CORRUPT";
  readonly completedCueCount: number;
  readonly totalCueCount: number;
}

export interface ReviewHistorySidebarProps {
  readonly items: readonly ReviewHistoryItem[];
  readonly activeReviewId?: string;
  readonly loading?: boolean;
  readonly error?: string;
  readonly importProgress?: { readonly completedBytes: number; readonly totalBytes: number };
  readonly hasMore?: boolean;
  readonly onImportDemo: () => void;
  readonly onSearchChange?: (query: string) => void;
  readonly onLoadMore?: () => void;
  readonly onOpenReview: (reviewId: string) => void;
  readonly onRenameReview: (review: ReviewHistoryItem) => void;
  readonly onReanalyzeReview: (review: ReviewHistoryItem) => void;
  readonly onCreateForAnotherPlayer: (review: ReviewHistoryItem) => void;
  readonly onStartOver: (review: ReviewHistoryItem) => void;
  readonly onDeleteReview: (review: ReviewHistoryItem) => void;
  readonly onDeleteDemo: (review: ReviewHistoryItem) => void;
  readonly onOpenLibrary: () => void;
  readonly onOpenStats: () => void;
}

type Group = "今天" | "昨天" | "过去 7 天" | "过去 30 天" | "更早";

function groupForDate(value: string, now = new Date()): Group {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "更早";
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const days = Math.floor((today - new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf()) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days <= 7) return "过去 7 天";
  if (days <= 30) return "过去 30 天";
  return "更早";
}

function statusLabel(review: ReviewHistoryItem): string {
  if (review.demoStatus === "MISSING") return "文件缺失";
  if (review.demoStatus === "CORRUPT") return "文件损坏";
  if (review.demoStatus === "IMPORTING") return "正在导入";
  if (review.status === "PREPARING") return "准备中";
  if (review.status === "IN_PROGRESS") return "复盘中";
  if (review.status === "COMPLETED") return "已完成";
  if (review.status === "FAILED") return "需重新分析";
  if (review.status === "STALE") return "旧分析版本";
  return "可继续";
}

function reviewMeta(review: ReviewHistoryItem): string {
  return [review.map, review.playerName, review.scoreText].filter(Boolean).join(" · ") || review.originalFilename;
}

export function ReviewHistorySidebar(props: ReviewHistorySidebarProps) {
  const [query, setQuery] = useState("");
  const [openMenu, setOpenMenu] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const close = () => setOpenMenu(undefined);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => props.onSearchChange?.(query), 160);
    return () => window.clearTimeout(timer);
  }, [props.onSearchChange, query]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpenMenu(undefined); setCollapsed(true); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const buckets = new Map<Group, ReviewHistoryItem[]>();
    for (const review of props.items) {
      if (normalized && !`${review.title} ${review.playerName} ${review.map ?? ""} ${review.originalFilename}`.toLocaleLowerCase().includes(normalized)) continue;
      const group = groupForDate(review.updatedAt);
      const bucket = buckets.get(group) ?? [];
      bucket.push(review);
      buckets.set(group, bucket);
    }
    return (["今天", "昨天", "过去 7 天", "过去 30 天", "更早"] as const)
      .map((label) => [label, buckets.get(label) ?? []] as const)
      .filter(([, reviews]) => reviews.length > 0);
  }, [props.items, query]);

  return (
    <aside className={`${styles.sidebar}${collapsed ? ` ${styles.collapsed}` : ""}`} aria-label="复盘历史">
      <div className={styles.topline}>
        {!collapsed ? <strong>复盘历史</strong> : null}
        <button type="button" className={styles.iconButton} onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "展开复盘历史" : "收起复盘历史"}>
          <ChevronLeft aria-hidden="true" />
        </button>
      </div>

      <button type="button" className={styles.importButton} onClick={props.onImportDemo} title="导入 Demo" aria-busy={Boolean(props.importProgress)}>
        <FilePlus2 aria-hidden="true" />
        <span>{props.importProgress ? `正在导入 ${Math.round(props.importProgress.completedBytes / props.importProgress.totalBytes * 100)}%` : "导入 Demo"}</span>
      </button>
      {props.importProgress && !collapsed ? <progress className={styles.importProgress} value={props.importProgress.completedBytes} max={props.importProgress.totalBytes} aria-label="Demo 导入进度" /> : null}

      {!collapsed ? <label className={styles.search}>
        <Search aria-hidden="true" />
        <span className="cs2d-visually-hidden">搜索复盘历史</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索复盘历史" />
      </label> : null}

      {!collapsed ? <div className={styles.list} aria-live="polite">
        {props.loading ? <p className={styles.muted}>正在读取本地复盘…</p> : null}
        {props.error ? <p className={styles.error} role="status">{props.error}</p> : null}
        {!props.loading && !props.error && groups.length === 0 ? <div className={styles.empty}>
          <Library aria-hidden="true" />
          <strong>还没有复盘记录</strong>
          <p>导入一份 Demo 后，之后可直接从这里继续复盘。</p>
        </div> : null}
        {groups.map(([label, reviews]) => <section key={label} className={styles.group}>
          <h2>{label}</h2>
          {reviews.map((review) => <div key={review.id} className={`${styles.row}${review.id === props.activeReviewId ? ` ${styles.active}` : ""}`}>
            <button type="button" className={styles.reviewButton} onClick={() => props.onOpenReview(review.id)} aria-current={review.id === props.activeReviewId ? "page" : undefined}>
              <span className={styles.reviewTitle}>{review.title}</span>
              <span className={styles.reviewMeta}>{reviewMeta(review)}</span>
              <span className={styles.statusLine}>
                <i data-status={review.demoStatus === "READY" ? review.status : review.demoStatus} aria-hidden="true" />
                {statusLabel(review)}
                {review.status === "PREPARING" || review.status === "IN_PROGRESS" ? <b>{Math.max(0, Math.min(100, Math.round(review.progress)))}%</b> : null}
                {review.totalCueCount > 0 && review.status !== "PREPARING" ? <b>{review.completedCueCount}/{review.totalCueCount}</b> : null}
              </span>
            </button>
            <div className={styles.menuWrap} onPointerDown={(event) => event.stopPropagation()}>
              <button type="button" className={styles.more} onClick={() => setOpenMenu((current) => current === review.id ? undefined : review.id)} aria-label={`${review.title} 的更多操作`} aria-expanded={openMenu === review.id}>
                <MoreHorizontal aria-hidden="true" />
              </button>
              {openMenu === review.id ? <div className={styles.menu} role="menu">
                <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); props.onOpenReview(review.id); }}><Play aria-hidden="true" />继续复盘</button>
                <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); props.onStartOver(review); }}><RotateCcw aria-hidden="true" />从头查看</button>
                <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); props.onRenameReview(review); }}><Pencil aria-hidden="true" />重命名</button>
                <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); props.onReanalyzeReview(review); }}><RotateCcw aria-hidden="true" />重新分析</button>
                <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); props.onCreateForAnotherPlayer(review); }}><UserRoundPlus aria-hidden="true" />为另一个玩家创建复盘</button>
                <hr />
                <button type="button" role="menuitem" className={styles.danger} onClick={() => { setOpenMenu(undefined); props.onDeleteReview(review); }}><Trash2 aria-hidden="true" />删除复盘</button>
                <button type="button" role="menuitem" className={styles.danger} onClick={() => { setOpenMenu(undefined); props.onDeleteDemo(review); }}><Trash2 aria-hidden="true" />删除 Demo 及所有复盘</button>
              </div> : null}
            </div>
          </div>)}
        </section>)}
        {props.hasMore ? <button type="button" className={styles.loadMore} onClick={props.onLoadMore} disabled={props.loading}>加载更多</button> : null}
      </div> : null}

      <div className={styles.bottomActions}>
        <button type="button" onClick={props.onOpenStats} title="在设置中管理"><BarChart3 aria-hidden="true" /><span>在设置中管理</span></button>
        <button type="button" onClick={props.onOpenLibrary} title="刷新资料库"><Library aria-hidden="true" /><span>刷新资料库</span></button>
      </div>
    </aside>
  );
}
