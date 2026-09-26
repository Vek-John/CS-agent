import type { ReviewHistoryItem } from "../../components/history/review-history-sidebar";

/** Refresh presentation only; an older request cannot publish into its successor. */
export async function refreshHistoryPage(input: {
  load: () => Promise<{ items: ReviewHistoryItem[]; nextCursor?: string }>;
  accept: (page: { items: ReviewHistoryItem[]; nextCursor?: string }) => void;
  isCurrent: () => boolean;
  ownsRequest: () => boolean;
  setLoading: (loading: boolean) => void;
  setError: (update: (previous: string | undefined) => string | undefined) => void;
  clearError: boolean;
}): Promise<void> {
  const live = () => input.ownsRequest() && input.isCurrent();
  if (!live()) return;
  input.setLoading(true);
  try {
    const page = await input.load();
    if (!live()) return;
    input.accept(page);
    if (input.clearError) input.setError(() => undefined);
  } catch {
    if (live()) input.setError(previous => input.clearError ? "无法读取本地复盘历史。" : previous ?? "无法读取本地复盘历史。");
  } finally {
    // A superseded route may finish its own spinner, but never another request's.
    if (input.ownsRequest()) input.setLoading(false);
  }
}
