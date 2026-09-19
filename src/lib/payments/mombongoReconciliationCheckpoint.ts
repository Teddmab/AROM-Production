import { doc, getDoc, runTransaction } from "firebase/firestore/lite";
import { serverDb } from "@/lib/firebase/serverDb";

/**
 * Durable reconciliation checkpoint — AROM-Backend's merged
 * `mombongoReconciliationState/harvest-offers` (PR #14, 751b3bc). Closed
 * schema {streamId, completedThrough?, updatedAt}; isMombongoWebhook()-only;
 * `completedThrough` is an ISO UTC string with exactly millisecond precision,
 * ABSENT until a real boundary exists, and can then only stay equal or move
 * forward (Rules reject anything else). `updatedAt` never decreases.
 */
export const RECONCILIATION_STREAM_ID = "harvest-offers";

const STRICT_ISO_MS =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

/** Same shape the Backend Rules require — anything else can never be committed. */
export function isCheckpointTimestamp(value: unknown): value is string {
  return typeof value === "string" && STRICT_ISO_MS.test(value);
}

function checkpointRef() {
  return doc(serverDb, "mombongoReconciliationState", RECONCILIATION_STREAM_ID);
}

export interface CheckpointState {
  exists: boolean;
  /** Undefined until a real boundary exists — never a sentinel. */
  completedThrough?: string;
}

/** Caller must already be signed in as the trusted system identity (getMombongoConfig() does this). */
export async function readCheckpoint(): Promise<CheckpointState> {
  const snap = await getDoc(checkpointRef());
  if (!snap.exists()) return { exists: false };
  const value = snap.data()?.completedThrough;
  return isCheckpointTimestamp(value)
    ? { exists: true, completedThrough: value }
    : { exists: true };
}

export type AdvanceResult =
  | { kind: "advanced"; previous: string | null; current: string }
  | { kind: "noop"; current: string }
  | { kind: "superseded"; current: string };

/**
 * Compare-and-set forward advancement. Reads the stored boundary inside a
 * transaction and writes only a strictly greater one:
 *   - stored >= proposed  -> nothing is written ("noop" when equal,
 *     "superseded" when a newer run already advanced);
 *   - otherwise create (no doc) / update (doc without or with an older
 *     boundary) with the proposed value.
 * If the Rules reject the write (a concurrent run committed a newer boundary
 * between our read and commit), re-read: stored >= proposed means this run is
 * superseded and stops safely; anything else is a genuine failure and is
 * rethrown. Never retries with an older value.
 */
export async function advanceCheckpoint(proposed: string): Promise<AdvanceResult> {
  if (!isCheckpointTimestamp(proposed)) throw new Error("invalid_checkpoint_timestamp");
  const ref = checkpointRef();

  try {
    return await runTransaction(serverDb, async (tx): Promise<AdvanceResult> => {
      const snap = await tx.get(ref);
      const stored = snap.exists() ? snap.data()?.completedThrough : undefined;
      const storedTs = isCheckpointTimestamp(stored) ? stored : undefined;
      if (storedTs !== undefined && storedTs >= proposed) {
        return storedTs === proposed
          ? { kind: "noop", current: storedTs }
          : { kind: "superseded", current: storedTs };
      }
      // Rules also require updatedAt to be >= the stored one.
      const storedUpdatedAt = snap.exists() ? snap.data()?.updatedAt : undefined;
      const now = new Date().toISOString();
      const updatedAt =
        isCheckpointTimestamp(storedUpdatedAt) && storedUpdatedAt > now ? storedUpdatedAt : now;
      if (!snap.exists()) {
        tx.set(ref, {
          streamId: RECONCILIATION_STREAM_ID,
          completedThrough: proposed,
          updatedAt,
        });
      } else {
        tx.update(ref, { completedThrough: proposed, updatedAt });
      }
      return { kind: "advanced", previous: storedTs ?? null, current: proposed };
    });
  } catch (err) {
    const after = await readCheckpoint().catch(() => null);
    if (after?.completedThrough !== undefined && after.completedThrough >= proposed) {
      return { kind: "superseded", current: after.completedThrough };
    }
    throw err;
  }
}
