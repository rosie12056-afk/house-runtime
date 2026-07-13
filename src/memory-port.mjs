export class SQLiteMemoryPort {
  constructor(store) {
    this.store = store;
  }

  list(subjectId, limit = 20, options = {}) {
    return this.store.listMemories(subjectId, limit, options);
  }

  save(runId, memory) {
    this.store.saveMemory(runId, memory);
  }

  saveResignature(runId, resignature) {
    this.store.saveResignature(runId, resignature);
  }

  latestResignature(subjectId) {
    return this.store.getLatestResignature(subjectId);
  }

  listResignatures(subjectId, limit = 20) {
    return this.store.listResignatures(subjectId, limit);
  }
}

export function assertMemoryPort(port) {
  for (const method of ["list", "save", "saveResignature", "latestResignature", "listResignatures"]) {
    if (!port || typeof port[method] !== "function") throw new Error(`memoryPort must implement ${method}()`);
  }
  return port;
}
