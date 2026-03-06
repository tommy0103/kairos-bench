export class RemoteAsyncIterable<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private isDone = false;
  private error: unknown;

  push(item: T): void {
    if (this.isDone) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.queue.push(item);
  }

  end(): void {
    if (this.isDone) {
      return;
    }
    this.isDone = true;
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      waiter({ value: undefined as T, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.isDone) {
      return;
    }
    this.error = error;
    this.isDone = true;
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      waiter({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift() as T;
          return { value, done: false };
        }
        if (this.error) {
          throw this.error;
        }
        if (this.isDone) {
          return { value: undefined as T, done: true };
        }
        const result = await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
        if (this.error) {
          throw this.error;
        }
        return result;
      },
    };
  }
}
