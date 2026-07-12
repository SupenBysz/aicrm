export interface AuthenticatedSseEvent<T = unknown> {
  /** Persisted event sequence. Connection-level frames intentionally omit it. */
  id?: number;
  event: string;
  data: T;
}

export interface EventStreamOptions<T = unknown> {
  /** Last fully applied persisted sequence. Must be a non-negative integer. */
  after?: number;
  signal?: AbortSignal;
  retryDelayMs?: number;
  onOpen?: () => void;
  onEvent: (event: AuthenticatedSseEvent<T>) => void;
  onError?: (error: unknown) => void;
  /** Defaults to event names ending in `.stream.closed` or `.closed`. */
  shouldClose?: (event: AuthenticatedSseEvent<T>) => boolean;
}

export interface EventStreamSubscription {
  readonly done: Promise<void>;
  close(): void;
}
