export class ExecutionCancelledError extends Error {
  constructor(message = "Run cancelled.") {
    super(message);
    this.name = "ExecutionCancelledError";
  }
}

export class ExecutionTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Run exceeded its ${timeoutMs} ms timeout.`);
    this.name = "ExecutionTimeoutError";
    this.timeout_ms = timeoutMs;
  }
}

const defaultTimer = Object.freeze({
  setTimeout(callback, milliseconds) {
    return globalThis.setTimeout(callback, milliseconds);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle);
  },
});

export async function runWithControls(operation, { signal, timeoutMs, timer = defaultTimer }) {
  let timeoutHandle;
  let abortListener;
  const operationPromise = Promise.resolve().then(operation);
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = timer.setTimeout(() => reject(new ExecutionTimeoutError(timeoutMs)), timeoutMs);
  });
  const cancellationPromise = new Promise((_, reject) => {
    if (signal.aborted) reject(new ExecutionCancelledError());
    else {
      abortListener = () => reject(new ExecutionCancelledError());
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise, cancellationPromise]);
  } finally {
    timer.clearTimeout(timeoutHandle);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    operationPromise.catch(() => undefined);
  }
}
