/**
 * A reservation is released only for a generation that never reached the provider. Once a
 * paid job has been dispatched it is billable whether or not Postora managed to record it.
 */
export function shouldReleaseReservation(state: { reserved: boolean; dispatched: boolean }): boolean {
  return state.reserved && !state.dispatched;
}

export interface InsertResult<T> {
  data: T | null;
  error: { message: string } | null;
}

/**
 * Records a job row for a generation that has already started, retrying once. A thrown
 * insert is folded into `error` so the caller keeps one path for an unrecorded job.
 */
export async function insertWithOneRetry<T>(insert: () => PromiseLike<InsertResult<T>>): Promise<InsertResult<T>> {
  let last: InsertResult<T> = { data: null, error: { message: "insert not attempted" } };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      last = await insert();
    } catch (err) {
      last = { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
    }
    if (!last.error) return last;
  }
  return last;
}
