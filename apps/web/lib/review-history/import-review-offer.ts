interface ExistingReviews {
  reviewCount: number;
  reviews: readonly { id: string; title: string }[];
}

/** An optional deduplication offer must not replace a newer review intent. */
export async function offerImportedReview(input: {
  recovering: boolean;
  deduplicated: boolean;
  isCurrent: () => boolean;
  readSelectionEpoch: () => number;
  refresh: (isCurrent: () => boolean) => Promise<void>;
  loadExisting: () => Promise<ExistingReviews>;
  confirmExisting: (impact: ExistingReviews) => boolean;
  openReview: (id: string) => Promise<void>;
  onError: () => void;
}): Promise<void> {
  const selectionEpoch = input.readSelectionEpoch();
  const isCurrent = () => input.isCurrent() && input.readSelectionEpoch() === selectionEpoch;
  await input.refresh(isCurrent);
  if (input.recovering || !input.deduplicated || !isCurrent()) return;
  try {
    const impact = await input.loadExisting();
    if (!isCurrent()) return;
    const latest = impact.reviews[0];
    if (!latest) return;
    const accepted = input.confirmExisting(impact);
    if (isCurrent() && accepted) await input.openReview(latest.id);
  } catch {
    if (isCurrent()) input.onError();
  }
}
