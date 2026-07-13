export class RoomQueue {
  #tails = new Map();

  run(roomId, task) {
    const previous = this.#tails.get(roomId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tail = current.finally(() => {
      if (this.#tails.get(roomId) === tail) this.#tails.delete(roomId);
    });
    this.#tails.set(roomId, tail);
    return current;
  }

  get activeRooms() {
    return this.#tails.size;
  }
}
