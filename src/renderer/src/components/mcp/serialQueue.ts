/**
 * Runs async tasks one at a time, in the order they were queued. A failing task does not stop the ones after it.
 * `busy()` is true while any task is running or waiting.
 */
export interface SerialQueue {
  enqueue: <T>(task: () => Promise<T>) => Promise<T>
  busy: () => boolean
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve()
  let count = 0
  return {
    enqueue: <T>(task: () => Promise<T>): Promise<T> => {
      count++
      const run = tail.then(task, task)
      const done = (): void => {
        count--
      }
      tail = run.then(done, done)
      return run
    },
    busy: () => count > 0
  }
}
