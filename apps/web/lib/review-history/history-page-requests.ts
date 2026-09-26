export interface HistoryPageRequest {
  owns(): boolean;
  acceptCursor(cursor: string | undefined): void;
  finish(): void;
}

/** Owns only the current query/cursor; synchronous guards also cover pre-render clicks. */
export class HistoryPageRequests {
  #search = "";
  #cursor?: string;
  #epoch = 0;
  #pending = false;

  changeSearch(search: string): boolean {
    if (search === this.#search) return false;
    this.#search = search;
    this.#cursor = undefined;
    this.#epoch += 1;
    this.#pending = true; // The new first page has not started in React's effect yet.
    return true;
  }

  refresh(search: string): HistoryPageRequest | undefined {
    if (search !== this.#search) return undefined;
    return this.begin();
  }

  more(search: string, cursor: string | undefined): HistoryPageRequest | undefined {
    if (this.#pending || search !== this.#search || !cursor || cursor !== this.#cursor) return undefined;
    return this.begin();
  }

  private begin(): HistoryPageRequest {
    const epoch = ++this.#epoch;
    this.#pending = true;
    const owns = () => epoch === this.#epoch;
    return {
      owns,
      acceptCursor: cursor => { if (owns()) this.#cursor = cursor; },
      finish: () => { if (owns()) this.#pending = false; },
    };
  }
}
