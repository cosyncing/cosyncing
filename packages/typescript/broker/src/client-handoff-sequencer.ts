/**
 * Preserve ordinary per-socket concurrency while making ownership handoff an
 * exclusive boundary. Work accepted before handoff settles first; work
 * accepted afterwards waits until the socket has been retargeted.
 */
export class ClientHandoffSequencer {
  private readonly active = new Set<Promise<void>>();
  private handoffBarrier: Promise<void> = Promise.resolve();

  /** Work already accepted on this socket. Handoff refuses instead of
   *  waiting past the client's bounded confirmation window. */
  get hasActiveWork(): boolean {
    return this.active.size > 0;
  }

  run(
    work: () => Promise<void>,
    options: { after?: Promise<void>; handoff?: boolean } = {},
  ): Promise<void> {
    let task: Promise<void>;
    if (options.handoff) {
      const acceptedBeforeHandoff = [...this.active];
      task = Promise.allSettled(acceptedBeforeHandoff).then(work);
      this.handoffBarrier = task.then(
        () => undefined,
        () => undefined,
      );
    } else {
      // Capture the current barrier now. A later handoff must wait for this
      // accepted operation, never jump ahead of it and reverse frame order.
      const barrier = this.handoffBarrier;
      task = (options.after ?? Promise.resolve())
        .then(() => barrier)
        .then(work);
    }

    this.active.add(task);
    void task.then(
      () => this.active.delete(task),
      () => this.active.delete(task),
    );
    return task;
  }
}
