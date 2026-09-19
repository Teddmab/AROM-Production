import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileMombongoOffers } from "./mombongoReconciliation";
import {
  advanceCheckpoint,
  isCheckpointTimestamp,
  readCheckpoint,
} from "./mombongoReconciliationCheckpoint";
import { getMombongoConfig } from "./mombongoConfig";

const CP = "mombongoReconciliationState/harvest-offers";
type Entry = { exists: boolean; data?: Record<string, unknown> };
let mockRegistry: Record<string, Entry> = {};
let beforeCheckpointCommit: (() => void) | null = null;
let failWritePath: string | null = null;
const checkpointAccess: number[] = [];
let seq = 0;

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("./mombongoConfig", () => ({ getMombongoConfig: vi.fn() }));
vi.mock("./mombongoSigning", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mombongoSigning")>();
  return { ...actual, signHmac: vi.fn().mockResolvedValue("deadbeef") };
});

vi.mock("firebase/firestore/lite", () => {
  const snap = (ref: { path: string; id: string }) => {
    const entry = mockRegistry[ref.path];
    return { exists: () => !!entry?.exists, data: () => entry?.data, id: ref.id };
  };
  return {
    doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, id })),
    getDoc: vi.fn(async (ref: { path: string; id: string }) => {
      if (ref.path === CP) checkpointAccess.push(++seq);
      return snap(ref);
    }),
    getDocs: vi.fn(
      async (q: { collectionPath: string; whereField?: string; whereValue?: unknown }) => {
        const docs = Object.entries(mockRegistry)
          .filter(
            ([p, v]) =>
              v.exists &&
              p.startsWith(`${q.collectionPath}/`) &&
              v.data?.[q.whereField!] === q.whereValue,
          )
          .map(([p, v]) => ({ id: p.split("/")[1], data: () => v.data }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    ),
    collection: vi.fn((_db: unknown, path: string) => ({ collectionPath: path })),
    query: vi.fn(
      (
        base: { collectionPath: string },
        ...c: { type: string; field?: string; value?: unknown }[]
      ) => {
        const w = c.find((x) => x?.type === "where");
        return { ...base, whereField: w?.field, whereValue: w?.value };
      },
    ),
    where: vi.fn((field: string, _op: string, value: unknown) => ({ type: "where", field, value })),
    limit: vi.fn(() => ({ type: "limit" })),
    setDoc: vi.fn(),
    updateDoc: vi.fn((ref: { path: string }, data: Record<string, unknown>) => {
      mockRegistry[ref.path] = { exists: true, data: { ...mockRegistry[ref.path]?.data, ...data } };
    }),
    // Enforces the merged Backend Rules for the checkpoint doc: completedThrough may never decrease or vanish.
    runTransaction: vi.fn(async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      const writes: { kind: "set" | "update"; path: string; data: Record<string, unknown> }[] = [];
      const tx = {
        get: async (ref: { path: string; id: string }) => {
          if (ref.path === CP) checkpointAccess.push(++seq);
          return snap(ref);
        },
        set: (ref: { path: string }, data: Record<string, unknown>) =>
          writes.push({ kind: "set", path: ref.path, data }),
        update: (ref: { path: string }, data: Record<string, unknown>) =>
          writes.push({ kind: "update", path: ref.path, data }),
      };
      const result = await fn(tx);
      for (const w of writes) {
        if (failWritePath === w.path) throw new Error("boom");
        if (w.path === CP) {
          if (beforeCheckpointCommit) {
            const h = beforeCheckpointCommit;
            beforeCheckpointCommit = null;
            h();
          }
          checkpointAccess.push(++seq);
          const cur = mockRegistry[CP]?.data?.completedThrough as string | undefined;
          const next = (w.kind === "set" ? w.data : { ...mockRegistry[CP]?.data, ...w.data })
            .completedThrough as string | undefined;
          if (cur && (!next || next < cur)) throw new Error("PERMISSION_DENIED");
        }
      }
      for (const w of writes)
        mockRegistry[w.path] = {
          exists: true,
          data: w.kind === "set" ? w.data : { ...mockRegistry[w.path]?.data, ...w.data },
        };
      return result;
    }),
  };
});

const SECRET = "TOP_SECRET_DO_NOT_LEAK";
const BASE_CONFIG = {
  baseUrl: "https://example.invalid",
  partnerId: "partner-1",
  inboundSigningSecret: SECRET,
  outboundVerifySecret: SECRET + "_2",
  active: true,
  reconciliationBootstrapSince: "full-history" as string | undefined,
};

// ---- fake Mombongo: strict > filter, (updatedAt, offerId) order, opaque per-run cursor ----
type Remote = {
  offerId: string;
  externalReference: string | null;
  listingId: string | null;
  status: string;
  quantityKg: number;
  unitPriceCdf: number;
  currency: string;
  createdAt: string | null;
  updatedAt: string;
  invoiceId: string | null;
};
let remote: Remote[] = [];
const requests: { updatedSince?: string; cursor?: string; limit?: number }[] = [];
const bodies: Record<string, unknown>[] = [];
let scripted:
  | ((b: { cursor?: string }, n: number) => { offers: Remote[]; nextCursor: string | null })
  | null = null;
let onPage: ((n: number) => void) | null = null;
let badCursor = false;
let pageNo = 0;

const T = (m: number) => new Date(Date.UTC(2026, 8, 19, 10, m)).toISOString(); // minute offsets
function offer(
  id: string,
  updatedAt: string,
  status = "pending",
  extra: Partial<Remote> = {},
): Remote {
  return {
    offerId: `mb-${id}`,
    externalReference: `ext-${id}`,
    listingId: `l-${id}`,
    status,
    quantityKg: 100,
    unitPriceCdf: 500,
    currency: "CDF",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt,
    invoiceId: null,
    ...extra,
  };
}
function seedLocal(id: string, data: Record<string, unknown> = {}) {
  mockRegistry[`harvestOffers/ext-${id}`] = {
    exists: true,
    data: {
      id: `ext-${id}`,
      status: "pending",
      listingId: `l-${id}`,
      mombongoOfferId: `mb-${id}`,
      ...data,
    },
  };
}
function seedAll(ids: string[]) {
  ids.forEach((i) => seedLocal(i));
}

function installRemote() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toContain("/getExternalHarvestOffers");
      const b = JSON.parse(init.body as string);
      requests.push({ updatedSince: b.updatedSince, cursor: b.cursor, limit: b.limit });
      bodies.push(b);
      pageNo++;
      if (scripted) {
        const r = scripted(b, pageNo);
        return { status: 200, json: async () => r };
      }
      if (badCursor && b.cursor) return { status: 400, json: async () => ({}) };
      let rows = remote.filter((o) => (b.updatedSince ? o.updatedAt > b.updatedSince : true));
      rows.sort((a, c) => (`${a.updatedAt}|${a.offerId}` < `${c.updatedAt}|${c.offerId}` ? -1 : 1));
      if (b.cursor) {
        const [u, i] = Buffer.from(b.cursor, "base64url").toString().split("|");
        rows = rows.filter((o) => `${o.updatedAt}|${o.offerId}` > `${u}|${i}`);
      }
      const page = rows.slice(0, b.limit ?? 20);
      const last = page[page.length - 1];
      const nextCursor =
        last && page.length === (b.limit ?? 20)
          ? Buffer.from(`${last.updatedAt}|${last.offerId}`).toString("base64url")
          : null;
      onPage?.(pageNo); // a remote write landing right AFTER this page was read
      return { status: 200, json: async () => ({ offers: page, nextCursor }) };
    }),
  );
}
const cp = () => mockRegistry[CP]?.data?.completedThrough;
const status = (id: string) => mockRegistry[`harvestOffers/ext-${id}`]?.data?.status;
const OVERLAP = 60 * 60 * 1000;
const minus = (iso: string, ms: number) => new Date(Date.parse(iso) - ms).toISOString();

beforeEach(() => {
  mockRegistry = {};
  remote = [];
  requests.length = 0;
  bodies.length = 0;
  scripted = null;
  checkpointAccess.length = 0;
  seq = 0;
  beforeCheckpointCommit = null;
  failWritePath = null;
  onPage = null;
  badCursor = false;
  pageNo = 0;
  vi.mocked(getMombongoConfig)
    .mockReset()
    .mockResolvedValue({ ...BASE_CONFIG });
  installRemote();
});
afterEach(() => vi.restoreAllMocks());

describe("bootstrap (no durable boundary yet)", () => {
  it("absent config fails closed: not_configured, no Mombongo request, nothing written", async () => {
    vi.mocked(getMombongoConfig).mockResolvedValue({
      ...BASE_CONFIG,
      reconciliationBootstrapSince: undefined,
    });
    const s = await reconcileMombongoOffers();
    expect(s).toMatchObject({ status: "not_configured", reason: "bootstrap_not_configured" });
    expect(requests).toHaveLength(0);
    expect(mockRegistry[CP]).toBeUndefined();
  });
  it("an invalid config value fails closed", async () => {
    vi.mocked(getMombongoConfig).mockResolvedValue({
      ...BASE_CONFIG,
      reconciliationBootstrapSince: "last week",
    });
    expect((await reconcileMombongoOffers()).status).toBe("not_configured");
  });
  it("'full-history' sends NO lower bound (provably covers every offer)", async () => {
    await reconcileMombongoOffers();
    expect(requests[0].updatedSince).toBeUndefined();
  });
  it("a configured ISO lower bound is used verbatim", async () => {
    vi.mocked(getMombongoConfig).mockResolvedValue({
      ...BASE_CONFIG,
      reconciliationBootstrapSince: "2026-09-01T00:00:00.000Z",
    });
    await reconcileMombongoOffers();
    expect(requests[0].updatedSince).toBe("2026-09-01T00:00:00.000Z");
  });
  it("a state doc that exists without completedThrough also bootstraps", async () => {
    mockRegistry[CP] = { exists: true, data: { streamId: "harvest-offers", updatedAt: T(0) } };
    await reconcileMombongoOffers();
    expect(requests[0].updatedSince).toBeUndefined();
  });
  it("no records: nothing to commit, so no fabricated boundary and no state doc is created", async () => {
    const s = await reconcileMombongoOffers();
    expect(s.status).toBe("complete");
    expect(mockRegistry[CP]).toBeUndefined();
  });
});

describe("overlap and strict-> handling", () => {
  it("queries from completedThrough minus one hour by default", async () => {
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(120), updatedAt: T(120) },
    };
    await reconcileMombongoOffers();
    expect(requests[0].updatedSince).toBe(minus(T(120), OVERLAP));
  });
  it("never uses less than the 15-minute Backend minimum", async () => {
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(120), updatedAt: T(120) },
    };
    await reconcileMombongoOffers({ overlapMs: 1_000 });
    expect(requests[0].updatedSince).toBe(minus(T(120), 15 * 60 * 1000));
  });
  it("a larger configured overlap is honored", async () => {
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(300), updatedAt: T(300) },
    };
    await reconcileMombongoOffers({ overlapMs: 3 * OVERLAP });
    expect(requests[0].updatedSince).toBe(minus(T(300), 3 * OVERLAP));
  });
  it("a record whose updatedAt EQUALS the committed boundary is re-fetched under strict > (the overlap sits before it)", async () => {
    seedAll(["a"]);
    remote = [offer("a", T(120), "accepted")];
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(120), updatedAt: T(120) },
    };
    const s = await reconcileMombongoOffers();
    expect(s.offersExamined).toBe(1);
    expect(status("a")).toBe("accepted");
  });
  it("overlap replay is idempotent: re-running over already-applied offers changes nothing", async () => {
    seedAll(["a", "b"]);
    remote = [offer("a", T(1), "accepted"), offer("b", T(2), "declined")];
    const first = await reconcileMombongoOffers();
    expect(first.updated).toBe(2);
    const second = await reconcileMombongoOffers();
    expect(second.offersExamined).toBe(2); // replayed via overlap
    expect(second).toMatchObject({ updated: 0, noops: 2, imported: 0, conflicts: 0 });
    expect(status("a")).toBe("accepted");
    expect(status("b")).toBe("declined");
  });
});

describe("checkpoint advancement and compare-and-set", () => {
  it("creates the state doc with the greatest REMOTE updatedAt (not a local clock)", async () => {
    seedAll(["a", "b"]);
    remote = [offer("a", T(1), "accepted"), offer("b", T(7), "accepted")];
    const s = await reconcileMombongoOffers();
    expect(cp()).toBe(T(7));
    expect(mockRegistry[CP].data).toMatchObject({
      streamId: "harvest-offers",
      completedThrough: T(7),
    });
    expect(s.checkpoint).toEqual({ advanced: true, previous: null, current: T(7) });
  });
  it("advances an existing boundary forward and reports previous/current", async () => {
    seedAll(["a"]);
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(1), updatedAt: T(1) },
    };
    remote = [offer("a", T(9), "accepted")];
    const s = await reconcileMombongoOffers();
    expect(s.checkpoint).toEqual({ advanced: true, previous: T(1), current: T(9) });
  });
  it("equal proposal is a harmless no-op: no write, advanced=false", async () => {
    seedAll(["a"]);
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(5), updatedAt: T(5) },
    };
    remote = [offer("a", T(5), "accepted")];
    const s = await reconcileMombongoOffers();
    expect(s.checkpoint.advanced).toBe(false);
    expect(cp()).toBe(T(5));
  });
  it("advanceCheckpoint never moves backward: an older proposal is superseded without writing", async () => {
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(9), updatedAt: T(9) },
    };
    expect(await advanceCheckpoint(T(3))).toEqual({ kind: "superseded", current: T(9) });
    expect(cp()).toBe(T(9));
  });
  it("advanceCheckpoint equal is a noop", async () => {
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(9), updatedAt: T(9) },
    };
    expect(await advanceCheckpoint(T(9))).toEqual({ kind: "noop", current: T(9) });
  });
  it("advanceCheckpoint fills in a doc that has no boundary yet, and creates a missing doc", async () => {
    mockRegistry[CP] = { exists: true, data: { streamId: "harvest-offers", updatedAt: T(0) } };
    expect((await advanceCheckpoint(T(2))).kind).toBe("advanced");
    mockRegistry = {};
    expect((await advanceCheckpoint(T(2))).kind).toBe("advanced");
    expect(cp()).toBe(T(2));
  });
  it("rejects a non-timestamp proposal before touching Firestore", async () => {
    await expect(advanceCheckpoint("yesterday")).rejects.toThrow();
    expect(isCheckpointTimestamp("2026-09-19T10:00:00Z")).toBe(false);
    expect(isCheckpointTimestamp(T(1))).toBe(true);
  });
  it("concurrent newer advancement: a Rules-denied stale write re-reads and stops as superseded, never retrying older", async () => {
    seedAll(["a"]);
    remote = [offer("a", T(3), "accepted")];
    // Another run commits T(50) between our read and our commit.
    beforeCheckpointCommit = () => {
      mockRegistry[CP] = {
        exists: true,
        data: { streamId: "harvest-offers", completedThrough: T(50), updatedAt: T(50) },
      };
    };
    const s = await reconcileMombongoOffers();
    expect(s).toMatchObject({ status: "partial", reason: "superseded_by_newer_run" });
    expect(cp()).toBe(T(50)); // the newer boundary stands
  });
  it("a slower run cannot overwrite a newer boundary (Rules-level denial is handled, value untouched)", async () => {
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(50), updatedAt: T(50) },
    };
    beforeCheckpointCommit = null;
    // Force the transaction to believe the stored value is older than it is, then commit.
    const res = await advanceCheckpoint(T(10));
    expect(res.kind).toBe("superseded");
    expect(cp()).toBe(T(50));
  });
  it("an unexplained write failure (stored boundary not newer) is reported, not swallowed", async () => {
    seedAll(["a"]);
    remote = [offer("a", T(3), "accepted")];
    failWritePath = CP;
    const s = await reconcileMombongoOffers();
    expect(s).toMatchObject({ status: "partial", reason: "checkpoint_write_failed" });
    expect(cp()).toBeUndefined();
  });
});

describe("pagination and timestamp ties", () => {
  it("multiple pages: follows the cursor within one run and commits the final greatest timestamp", async () => {
    seedAll(["a", "b", "c", "d", "e"]);
    remote = ["a", "b", "c", "d", "e"].map((id, i) => offer(id, T(i + 1), "accepted"));
    const s = await reconcileMombongoOffers({ pageSize: 2 });
    expect(s.pagesProcessed).toBe(3);
    expect(s.status).toBe("complete");
    expect(requests[1].cursor).toBeTruthy();
    expect(requests.every((r) => r.updatedSince === undefined)).toBe(true);
    expect(cp()).toBe(T(5));
  });
  it("same timestamp within one page: every tied offer is processed", async () => {
    seedAll(["a", "b", "c"]);
    remote = [
      offer("a", T(4), "accepted"),
      offer("b", T(4), "declined"),
      offer("c", T(4), "accepted"),
    ];
    const s = await reconcileMombongoOffers();
    expect(s.updated).toBe(3);
    expect(cp()).toBe(T(4));
  });
  it("tie split across pages: the trailing tie group is NOT committed until a later page completes it", async () => {
    seedAll(["a", "b", "c", "d"]);
    remote = [
      offer("a", T(1), "accepted"),
      offer("b", T(2), "accepted"),
      offer("c", T(2), "accepted"),
      offer("d", T(3), "accepted"),
    ];
    // Page 1 = [a(T1), b(T2)] — T2's tie group continues with c on page 2.
    const s = await reconcileMombongoOffers({ pageSize: 2, maxPages: 1 });
    expect(s).toMatchObject({ status: "partial", reason: "page_cap_reached" });
    expect(cp()).toBe(T(1)); // strictly below the possibly-incomplete T2 group
    // Next run re-fetches from T1 − overlap: c is not missed.
    const s2 = await reconcileMombongoOffers({ pageSize: 2 });
    expect(status("c")).toBe("accepted");
    expect(s2.status).toBe("complete");
    expect(cp()).toBe(T(3));
  });
  it("a whole page of one timestamp cannot advance early, but the next page/run still completes it", async () => {
    seedAll(["a", "b", "c"]);
    remote = [
      offer("a", T(2), "accepted"),
      offer("b", T(2), "accepted"),
      offer("c", T(2), "accepted"),
    ];
    const s = await reconcileMombongoOffers({ pageSize: 2, maxPages: 1 });
    expect(cp()).toBeUndefined();
    expect(s.reason).toBe("page_cap_reached");
    await reconcileMombongoOffers({ pageSize: 2 });
    expect(cp()).toBe(T(2));
    expect(status("c")).toBe("accepted");
  });
  it("a new remote record appearing during pagination (newer than the cursor) is picked up in the same run", async () => {
    seedAll(["a", "b", "late"]);
    remote = [offer("a", T(1), "accepted"), offer("b", T(2), "accepted")];
    onPage = (n) => {
      if (n === 1) remote.push(offer("late", T(9), "accepted"));
    };
    const s = await reconcileMombongoOffers({ pageSize: 2 });
    expect(status("late")).toBe("accepted");
    expect(s.status).toBe("complete");
    expect(cp()).toBe(T(9));
  });
  it("a late-visible record with an OLDER timestamp than the cursor is caught next run by the overlap", async () => {
    seedAll(["a", "b", "late"]);
    remote = [offer("a", T(10), "accepted"), offer("b", T(20), "accepted")];
    onPage = (n) => {
      if (n === 1) remote.push(offer("late", T(15), "accepted"));
    }; // written after page 1 was read, ts inside the run's span
    await reconcileMombongoOffers({ pageSize: 10 });
    onPage = null;
    expect(cp()).toBe(T(20));
    // late (T15) was invisible to page 1; T15 > boundary − 1h so the next run fetches it.
    await reconcileMombongoOffers({ pageSize: 10 });
    expect(status("late")).toBe("accepted");
  });
  it("an invalid/expired cursor mid-run reports mombongo_unavailable; earlier pages' progress stays committed and the next run recovers", async () => {
    seedAll(["a", "b", "c", "d"]);
    remote = ["a", "b", "c", "d"].map((id, i) => offer(id, T(i + 1), "accepted"));
    badCursor = true;
    const s = await reconcileMombongoOffers({ pageSize: 2 });
    expect(s).toMatchObject({ status: "error", reason: "mombongo_unavailable" });
    expect(cp()).toBe(T(1)); // page 1 committed below its trailing tie group
    badCursor = false;
    const s2 = await reconcileMombongoOffers({ pageSize: 2 });
    expect(s2.status).toBe("complete");
    expect(cp()).toBe(T(4));
  });
  it("partial page failure: an item that throws pins the boundary below it; nothing past it is committed", async () => {
    seedAll(["a", "b", "c", "d"]);
    remote = ["a", "b", "c", "d"].map((id, i) => offer(id, T(i + 1), "accepted"));
    failWritePath = "harvestOffers/ext-c";
    const s = await reconcileMombongoOffers({ pageSize: 10 });
    expect(s).toMatchObject({ status: "partial", reason: "processing_failed" });
    expect(status("a")).toBe("accepted");
    expect(status("b")).toBe("accepted");
    expect(status("d")).toBe("pending"); // the run stopped at the failure
    expect(cp()).toBe(T(2)); // strictly below the failed record
    // Recovery: the failure clears; the next run finishes it all.
    failWritePath = null;
    const s2 = await reconcileMombongoOffers({ pageSize: 10 });
    expect(s2.status).toBe("complete");
    expect(status("d")).toBe("accepted");
    expect(cp()).toBe(T(4));
  });
  it("a successful HTTP page is not enough: with a failing first record nothing is committed at all", async () => {
    seedAll(["a", "b"]);
    remote = [offer("a", T(1), "accepted"), offer("b", T(2), "accepted")];
    failWritePath = "harvestOffers/ext-a";
    await reconcileMombongoOffers();
    expect(cp()).toBeUndefined();
  });
  it("backlog drains across multiple runs with a small per-run cap (no aging out)", async () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"];
    seedAll(ids);
    remote = ids.map((id, i) => offer(id, T(i + 1), "accepted"));
    const stages: (string | undefined)[] = [];
    let last;
    for (let run = 0; run < 6; run++) {
      last = await reconcileMombongoOffers({ pageSize: 2, maxPages: 2 });
      stages.push(cp() as string | undefined);
      if (last.status === "complete") break;
    }
    expect(last!.status).toBe("complete");
    ids.forEach((id) => expect(status(id)).toBe("accepted"));
    expect(cp()).toBe(T(7));
    // Boundary only ever moved forward.
    const defined = stages.filter(Boolean) as string[];
    expect([...defined].sort()).toEqual(defined);
    expect(new Set(defined).size).toBeGreaterThan(1);
  });
  it("process restart: no in-process state is needed — a fresh invocation resumes from the durable boundary alone", async () => {
    seedAll(["a", "b", "c"]);
    remote = ["a", "b", "c"].map((id, i) => offer(id, T(i + 1), "accepted"));
    await reconcileMombongoOffers({ pageSize: 2, maxPages: 1 });
    const boundary = cp();
    requests.length = 0;
    await reconcileMombongoOffers({ pageSize: 2 });
    expect(requests[0].updatedSince).toBe(minus(boundary as string, OVERLAP));
    expect(requests[0].cursor).toBeUndefined();
  });
});

describe("recovery: local vs remote records", () => {
  it("remote offer with a matching local doc is applied", async () => {
    seedAll(["a"]);
    remote = [offer("a", T(1), "accepted")];
    const s = await reconcileMombongoOffers();
    expect(s).toMatchObject({ updated: 1, imported: 0 });
    expect(status("a")).toBe("accepted");
  });
  it("remote offer missing locally but fully provable is imported (pending) then its outcome applied, with provenance and no invented actor/fields", async () => {
    remote = [offer("x", T(3), "accepted", { invoiceId: "inv-9" })];
    const s = await reconcileMombongoOffers();
    expect(s).toMatchObject({ imported: 1, updated: 1, blocked: 0, status: "complete" });
    const d = mockRegistry["harvestOffers/ext-x"].data!;
    expect(d).toMatchObject({
      id: "ext-x",
      status: "accepted",
      listingId: "l-x",
      mombongoOfferId: "mb-x",
      offerQuantityKg: 100,
      offerPricePerKgCdf: 500,
      createdAt: "2026-09-01T00:00:00.000Z",
      externalReference: "ext-x",
      importedFrom: "reconciliation",
      createdByUid: "system:mombongo-reconciliation",
      invoiceId: "inv-9",
    });
    expect(d.message).toBeNull();
    expect(cp()).toBe(T(3));
  });
  it("a missing-locally PENDING remote offer is imported as pending and does not pin the checkpoint", async () => {
    remote = [offer("p", T(2), "pending")];
    const s = await reconcileMombongoOffers();
    expect(s.imported).toBe(1);
    expect(status("p")).toBe("pending");
    expect(cp()).toBe(T(2));
  });
  it("without externalReference the local id is derived from the Mombongo offer id", async () => {
    remote = [offer("y", T(2), "pending", { externalReference: null })];
    await reconcileMombongoOffers();
    expect(mockRegistry["harvestOffers/mombongo-mb-y"].data).toMatchObject({
      mombongoOfferId: "mb-y",
    });
    expect(mockRegistry["harvestOffers/mombongo-mb-y"].data).not.toHaveProperty(
      "externalReference",
    );
  });
  const unusable: [string, Partial<Remote>][] = [
    ["listingId", { listingId: null }],
    ["createdAt", { createdAt: null }],
    ["quantity", { quantityKg: 0 }],
    ["price", { unitPriceCdf: -1 }],
    ["currency", { currency: "USD" }],
  ];
  for (const [name, patch] of unusable) {
    it(`a remote offer missing locally with unusable ${name} is BLOCKED, reported (not stored as a fake webhook), and never fabricated`, async () => {
      remote = [offer("z", T(3), "accepted", patch)];
      const s = await reconcileMombongoOffers();
      expect(s).toMatchObject({
        status: "partial",
        reason: "blocked_records",
        blocked: 1,
        imported: 0,
      });
      expect(mockRegistry["harvestOffers/ext-z"]).toBeUndefined();
      expect(Object.keys(mockRegistry).some((p) => p.startsWith("mombongoWebhookEvents/"))).toBe(
        false,
      );
      expect(s.issues).toHaveLength(1);
      expect(s.issues[0]).toMatchObject({
        kind: "blocked",
        offerId: "mb-z",
        remoteUpdatedAt: T(3),
      });
      expect(cp()).toBeUndefined();
    });
  }
  it("an unresolvable offer pins the checkpoint below it while later offers are still applied; repeat runs stay pinned and report one issue each", async () => {
    seedAll(["a", "c"]);
    remote = [
      offer("a", T(1), "accepted"),
      offer("b", T(2), "accepted", { listingId: null }),
      offer("c", T(3), "accepted"),
    ];
    const s = await reconcileMombongoOffers();
    expect(s.reason).toBe("blocked_records");
    expect(status("c")).toBe("accepted");
    expect(cp()).toBe(T(1));
    await reconcileMombongoOffers();
    expect(cp()).toBe(T(1)); // never advanced on a timer
    expect(
      Object.keys(mockRegistry).filter((p) => p.startsWith("mombongoWebhookEvents/")),
    ).toHaveLength(0);
    expect(s.issues).toHaveLength(1);
  });
  it("a record with an unusable updatedAt blocks all advancement in the run", async () => {
    seedAll(["a", "b"]);
    remote = [offer("a", T(1), "accepted"), offer("b", "not-a-date", "accepted")];
    const s = await reconcileMombongoOffers();
    expect(s.blocked).toBe(1);
    expect(cp()).toBeUndefined();
  });
  it("accepted/declined conflict never overwrites and PINS the boundary (no honest durable home exists), reported as an issue", async () => {
    seedLocal("a", { status: "accepted", mombongoOccurredAt: T(0) });
    remote = [offer("a", T(5), "declined")];
    const s = await reconcileMombongoOffers();
    expect(s.conflicts).toBe(1);
    expect(status("a")).toBe("accepted");
    expect(Object.keys(mockRegistry).some((p) => p.startsWith("mombongoWebhookEvents/"))).toBe(
      false,
    );
    expect(s).toMatchObject({ status: "partial", reason: "blocked_records" });
    expect(s.issues[0]).toMatchObject({
      kind: "conflict",
      code: "terminal_status_conflict",
      offerId: "mb-a",
    });
    expect(cp()).toBeUndefined();
  });
  it("legacy 'won' normalizes to 'accepted'", async () => {
    seedLocal("a", { status: "won" });
    remote = [offer("a", T(2), "accepted")];
    await reconcileMombongoOffers();
    expect(status("a")).toBe("accepted");
  });
  it("a local doc found by externalReference that carries a DIFFERENT Mombongo offer id is a conflict, never overwritten", async () => {
    seedLocal("a", { mombongoOfferId: "mb-someone-else" });
    remote = [offer("a", T(2), "accepted")];
    const s = await reconcileMombongoOffers();
    expect(s.conflicts).toBe(1);
    expect(status("a")).toBe("pending");
  });
  it("a stale remote 'pending' never downgrades a terminal local status", async () => {
    seedLocal("a", { status: "accepted" });
    remote = [offer("a", T(2), "pending")];
    await reconcileMombongoOffers();
    expect(status("a")).toBe("accepted");
  });
});

describe("security", () => {
  it("only reads/writes the single pinned checkpoint document, and only after signing in via the trusted config", async () => {
    seedAll(["a"]);
    remote = [offer("a", T(1), "accepted")];
    await reconcileMombongoOffers();
    expect(
      Object.keys(mockRegistry).filter((p) => p.startsWith("mombongoReconciliationState/")),
    ).toEqual([CP]);
    // getMombongoConfig (which performs signInAsMombongoSystem) ran before any checkpoint access.
    expect(vi.mocked(getMombongoConfig).mock.invocationCallOrder[0]).toBeDefined();
    expect(checkpointAccess.length).toBeGreaterThan(0);
  });
  it("readCheckpoint returns only a real boundary — a malformed stored value is treated as absent, never trusted", async () => {
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: "garbage", updatedAt: T(0) },
    };
    expect((await readCheckpoint()).completedThrough).toBeUndefined();
  });
  it("the summary and console output never contain credentials or raw error text", async () => {
    const logs: string[] = [];
    for (const m of ["error", "warn", "log"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
    vi.mocked(getMombongoConfig).mockRejectedValueOnce(
      new Error(`bad config ${SECRET} Bearer abc`),
    );
    const s1 = await reconcileMombongoOffers();
    expect(s1).toMatchObject({ status: "error", reason: "integration_unavailable" });
    seedAll(["a"]);
    remote = [offer("a", T(1), "accepted")];
    failWritePath = "harvestOffers/ext-a";
    const s2 = await reconcileMombongoOffers();
    for (const blob of [JSON.stringify(s1), JSON.stringify(s2), logs.join("\n")]) {
      expect(blob).not.toContain(SECRET);
      expect(blob).not.toContain("Bearer");
      expect(blob).not.toContain("partner-1");
      expect(blob).not.toContain("deadbeef");
    }
  });
  it("Mombongo being unreachable is a safe error code, not an exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET secret-host")));
    const s = await reconcileMombongoOffers();
    expect(s).toMatchObject({ status: "error", reason: "mombongo_unavailable" });
    expect(JSON.stringify(s)).not.toContain("secret-host");
  });
});

describe("two independent limits and cursor-cycle protection", () => {
  const seedDense = (n: number, base = 0) => {
    const ids = Array.from({ length: n }, (_, i) => `d${base + i}`);
    seedAll(ids);
    return ids;
  };

  it("dense overlap larger than the progress-page cap: replay pages are exempt, progress still happens, absolute limit is untouched", async () => {
    const ids = seedDense(54);
    remote = ids.map((id, i) => offer(id, T(i + 1), "accepted"));
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(50), updatedAt: T(50) },
    };
    const s = await reconcileMombongoOffers({ pageSize: 2, maxPages: 2, maxRequests: 100 });
    // records T1..T50 are pure replay (<= the boundary the run started from)
    expect(s.remoteRequests).toBeGreaterThan(2);
    expect(s).toMatchObject({ status: "partial", reason: "page_cap_reached" });
    expect(s.pagesProcessed).toBe(s.remoteRequests);
    expect((cp() as string) > T(50)).toBe(true); // real progress despite the dense overlap
  });

  it("absolute request limit is reached by replay-only pages and cannot be bypassed; boundary does not move", async () => {
    const ids = seedDense(60);
    remote = ids.map((id, i) => offer(id, T(i + 1), "accepted"));
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(59), updatedAt: T(59) },
    };
    const s = await reconcileMombongoOffers({ pageSize: 2, maxPages: 20, maxRequests: 10 });
    expect(s).toMatchObject({
      status: "partial",
      reason: "request_limit_reached",
      remoteRequests: 10,
    });
    expect(requests).toHaveLength(10);
    expect(cp()).toBe(T(59)); // never advanced past unprocessed work
  });

  it("repeated cursor (self-loop): stops with cursor_cycle after the second identical cursor, never keeps requesting", async () => {
    seedAll(["a"]);
    scripted = () => ({ offers: [offer("a", T(1), "accepted")], nextCursor: "C" });
    const s = await reconcileMombongoOffers({ maxRequests: 50 });
    expect(s).toMatchObject({ status: "partial", reason: "cursor_cycle" });
    expect(requests).toHaveLength(2);
    expect(cp()).toBeUndefined(); // last page treated as non-final: trailing group not committed
  });

  it("two-cursor cycle A -> B -> A stops at the first repeat", async () => {
    seedAll(["a", "b", "c"]);
    scripted = (b) => {
      if (!b.cursor) return { offers: [offer("a", T(1), "accepted")], nextCursor: "A" };
      if (b.cursor === "A") return { offers: [offer("b", T(2), "accepted")], nextCursor: "B" };
      return { offers: [offer("c", T(3), "accepted")], nextCursor: "A" };
    };
    const s = await reconcileMombongoOffers({ maxRequests: 50 });
    expect(s).toMatchObject({ status: "partial", reason: "cursor_cycle", remoteRequests: 3 });
    expect(status("c")).toBe("accepted"); // each page was fully processed before stopping
    expect(cp()).toBe(T(2)); // strictly below the last (non-final) page's timestamp
  });

  it("a remote that keeps returning the same page with FRESH cursors is stopped by the absolute limit, and never advances past unprocessed work", async () => {
    seedAll(["a"]);
    scripted = (_b, n) => ({ offers: [offer("a", T(1), "accepted")], nextCursor: `fresh-${n}` });
    const s = await reconcileMombongoOffers({ maxPages: 1000, maxRequests: 5 });
    expect(s).toMatchObject({
      status: "partial",
      reason: "request_limit_reached",
      remoteRequests: 5,
    });
    expect(cp()).toBeUndefined();
    expect(status("a")).toBe("accepted"); // replays are idempotent
  });

  it("safety limit reached mid-stream: partial response, boundary below the trailing group, and a later run continues safely", async () => {
    seedAll(["a", "b", "c", "d", "e"]);
    remote = ["a", "b", "c", "d", "e"].map((id, i) => offer(id, T(i + 1), "accepted"));
    const s1 = await reconcileMombongoOffers({ pageSize: 2, maxRequests: 2 });
    expect(s1).toMatchObject({ status: "partial", reason: "request_limit_reached" });
    expect(cp()).toBe(T(3));
    const s2 = await reconcileMombongoOffers({ pageSize: 2 });
    expect(s2.status).toBe("complete");
    expect(cp()).toBe(T(5));
    ["a", "b", "c", "d", "e"].forEach((id) => expect(status(id)).toBe("accepted"));
  });

  it("a later run after a cycle recovers once the remote is healthy again", async () => {
    seedAll(["a"]);
    scripted = () => ({ offers: [offer("a", T(1), "accepted")], nextCursor: "C" });
    await reconcileMombongoOffers();
    scripted = null;
    remote = [offer("a", T(1), "accepted")];
    const s = await reconcileMombongoOffers();
    expect(s.status).toBe("complete");
    expect(cp()).toBe(T(1));
  });

  it("limits are server constants: the function options are not reachable from the route, and defaults are bounded", async () => {
    const m = await import("./mombongoReconciliation");
    expect(m.DEFAULT_MAX_PROGRESS_PAGES).toBe(20);
    expect(m.DEFAULT_MAX_REMOTE_REQUESTS).toBe(100);
    expect(m.DEFAULT_MAX_REMOTE_REQUESTS).toBeGreaterThan(m.DEFAULT_MAX_PROGRESS_PAGES);
  });
});

describe("provenance of unresolved records", () => {
  const sha = async (input: string) => (await import("./mombongoSigning")).hashSha256Hex(input);

  it("never writes, reads or claims anything in mombongoWebhookEvents — no fabricated webhook, no invented Mombongo eventId", async () => {
    seedLocal("c", { status: "accepted", mombongoOccurredAt: T(0) });
    remote = [offer("z", T(1), "accepted", { listingId: null }), offer("c", T(2), "declined")];
    const s = await reconcileMombongoOffers();
    expect(s.blocked).toBe(1);
    expect(s.conflicts).toBe(1);
    expect(Object.keys(mockRegistry).filter((p) => p.startsWith("mombongoWebhookEvents/"))).toEqual(
      [],
    );
  });

  it("the same unresolved record found again (next run, or twice in one run) resolves to ONE deterministic issueId", async () => {
    remote = [offer("z", T(1), "accepted", { listingId: null })];
    const a = await reconcileMombongoOffers();
    const b = await reconcileMombongoOffers();
    expect(a.issues[0].issueId).toBe(b.issues[0].issueId);
    scripted = () => ({
      offers: [
        offer("z", T(1), "accepted", { listingId: null }),
        offer("z", T(1), "accepted", { listingId: null }),
      ],
      nextCursor: null,
    });
    const c = await reconcileMombongoOffers();
    expect(c.issues).toHaveLength(1);
    expect(c.blocked).toBe(1);
    expect(c.issues[0].issueId).toBe(a.issues[0].issueId);
  });

  it("issueId is domain-separated and cannot equal any real Mombongo eventId derivation (offer_status_changed / invoice_issued)", async () => {
    remote = [offer("z", T(1), "accepted", { listingId: null })];
    const { issues } = await reconcileMombongoOffers();
    const id = issues[0].issueId;
    // Mombongo: sha256([kind, ...parts].join(" ")) — computeEventId in mombongo-functions
    for (const real of [
      await sha("offer_status_changed mb-z accepted"),
      await sha("offer_status_changed mb-z declined"),
      await sha("invoice_issued mb-z"),
    ])
      expect(id).not.toBe(real);
    expect(id).toBe(await sha("reconciliation-issue-v1 blocked mb-z missing_listing_id"));
  });

  it("an issue exposes only safe, redacted fields: id, kind, machine code, offer id, remote timestamp", async () => {
    remote = [offer("z", T(1), "accepted", { listingId: null })];
    const { issues } = await reconcileMombongoOffers();
    expect(Object.keys(issues[0]).sort()).toEqual([
      "code",
      "issueId",
      "kind",
      "offerId",
      "remoteUpdatedAt",
    ]);
    expect(issues[0].code).toMatch(/^[a-z_]+$/);
  });

  it("issues are bounded in the response even when many records are unresolved (counts stay exact)", async () => {
    remote = Array.from({ length: 30 }, (_, i) =>
      offer(`u${i}`, T(i + 1), "accepted", { listingId: null }),
    );
    const s = await reconcileMombongoOffers();
    expect(s.blocked).toBe(30);
    expect(s.issues).toHaveLength(20);
  });

  it("a blocked record keeps the checkpoint pinned across runs", async () => {
    seedAll(["a"]);
    remote = [
      offer("a", T(1), "accepted"),
      offer("z", T(2), "accepted", { listingId: null }),
      offer("b", T(3), "accepted"),
    ];
    seedAll(["b"]);
    await reconcileMombongoOffers();
    await reconcileMombongoOffers();
    expect(cp()).toBe(T(1));
  });

  it("reconciliation-applied offers get a namespaced lastEventId that can never be mistaken for a real Mombongo eventId", async () => {
    seedAll(["a"]);
    remote = [offer("a", T(1), "accepted")];
    await reconcileMombongoOffers();
    const last = mockRegistry["harvestOffers/ext-a"].data?.lastEventId as string;
    expect(last).toMatch(/^reconciliation-v1:[0-9a-f]{64}$/);
    expect(last).not.toBe(await sha("offer_status_changed mb-a accepted"));
  });
});

describe("config and import audit", () => {
  it("'full-history' omits updatedSince from the request body entirely (no pseudo-timestamp)", async () => {
    await reconcileMombongoOffers();
    expect("updatedSince" in bodies[0]).toBe(false);
    expect(JSON.stringify(bodies[0])).not.toContain("full-history");
  });
  it("an explicit bootstrap timestamp is sent as-is; an existing boundary always wins over config", async () => {
    vi.mocked(getMombongoConfig).mockResolvedValue({
      ...BASE_CONFIG,
      reconciliationBootstrapSince: "2020-01-01T00:00:00.000Z",
    });
    mockRegistry[CP] = {
      exists: true,
      data: { streamId: "harvest-offers", completedThrough: T(200), updatedAt: T(200) },
    };
    await reconcileMombongoOffers();
    expect(bodies[0].updatedSince).toBe(minus(T(200), OVERLAP));
  });
  it("bootstrapSince is taken only from trusted config: reconcileMombongoOffers has no bootstrap option and loads config via getMombongoConfig", async () => {
    await reconcileMombongoOffers({
      ...({ reconciliationBootstrapSince: "2001-01-01T00:00:00.000Z" } as object),
    });
    expect(bodies[0]).not.toHaveProperty("updatedSince");
    expect(vi.mocked(getMombongoConfig)).toHaveBeenCalled();
  });
  it("imported offers carry the system marker plus explicit provenance, and the marker can never look like a Firebase uid", async () => {
    remote = [offer("x", T(1), "pending")];
    await reconcileMombongoOffers();
    const d = mockRegistry["harvestOffers/ext-x"].data!;
    expect(d.createdByUid).toBe("system:mombongo-reconciliation");
    expect(d.importedFrom).toBe("reconciliation");
    expect(d.createdByUid as string).toMatch(/:/);
    expect(d.createdByUid as string).not.toMatch(/^[A-Za-z0-9]{20,28}$/); // Firebase Auth generated uid shape
    // A user-scoped view (createdByUid === uid) can never match it.
    expect(d.createdByUid === "some-real-uid").toBe(false);
  });
});
