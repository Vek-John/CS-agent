export * from "./index";
export {
  DesktopReviewLibrary,
  ReviewLibraryError,
  type ReviewLibraryErrorCode,
  type DesktopReviewLibraryOptions,
  type IssueImportCapabilityInput,
  type ImportDemoInput,
  type ViewerDemoSource,
  type DeleteDemoOptions,
} from "./library";

import type { DesktopReviewLibrary } from "./library";

const REVIEW_LIBRARY_SYMBOL = Symbol.for("cs-agent.desktop.review-library.v1");
type ReviewLibraryGlobal = typeof globalThis & {
  [REVIEW_LIBRARY_SYMBOL]?: DesktopReviewLibrary;
};

export function installDesktopReviewLibrary(
  library: DesktopReviewLibrary | undefined,
): void {
  const target = globalThis as ReviewLibraryGlobal;
  if (library) target[REVIEW_LIBRARY_SYMBOL] = library;
  else Reflect.deleteProperty(target, REVIEW_LIBRARY_SYMBOL);
}

export function currentDesktopReviewLibrary(): DesktopReviewLibrary | undefined {
  return (globalThis as ReviewLibraryGlobal)[REVIEW_LIBRARY_SYMBOL];
}
