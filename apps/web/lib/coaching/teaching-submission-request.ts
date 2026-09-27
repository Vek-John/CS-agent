export interface TeachingSubmissionOwner {
  isCurrent(): boolean;
  release(): void;
}

/** Synchronous intent ownership across the interaction save and diagnosis work. */
export class TeachingSubmissionRequest {
  private active?: TeachingSubmissionOwner;

  async run(input: {
    claim(): TeachingSubmissionOwner | undefined;
    pending(): void;
    persistInteraction(): Promise<void>;
    interactionFailed(): void;
    execute(interactionDurable: boolean, isCurrent: () => boolean): Promise<void>;
  }): Promise<void> {
    // A stale cue/epoch/history owner cannot block the next valid request.
    if (this.active?.isCurrent()) return;
    const owner = input.claim();
    if (!owner?.isCurrent()) return;
    this.active = owner;
    try {
      input.pending();
      let interactionDurable = true;
      try { await input.persistInteraction(); }
      catch {
        interactionDurable = false;
        if (owner.isCurrent()) input.interactionFailed();
      }
      if (owner.isCurrent()) await input.execute(interactionDurable, () => owner.isCurrent());
    } finally {
      if (this.active === owner) {
        this.active = undefined;
        owner.release();
      }
    }
  }
}
