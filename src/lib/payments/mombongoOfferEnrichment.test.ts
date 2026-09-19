import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  externalHarvestOfferAcceptedEnrichedFixture,
  externalHarvestOfferDtoFixture,
  type ExternalHarvestOfferDto,
} from "./mombongoContract";
import { applyOfferEnrichment, sanitizeOfferEnrichment } from "./mombongoOfferEnrichment";

let mockRegistry: Record<string, { exists: boolean; data?: Record<string, unknown> }> = {};
let updates: { path: string; data: Record<string, unknown> }[] = [];

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, id })),
  runTransaction: vi.fn(async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      get: async (ref: { path: string; id: string }) => {
        const entry = mockRegistry[ref.path];
        return { exists: () => !!entry?.exists, data: () => entry?.data, id: ref.id };
      },
      update: (ref: { path: string }, data: Record<string, unknown>) => {
        updates.push({ path: ref.path, data });
        mockRegistry[ref.path] = {
          exists: true,
          data: { ...mockRegistry[ref.path]?.data, ...data },
        };
      },
      set: () => {
        throw new Error("enrichment must never create a document");
      },
    };
    return fn(tx);
  }),
}));

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const ENRICHED = externalHarvestOfferAcceptedEnrichedFixture;
const PATH = "harvestOffers/ext-1";

function dto(overrides: Partial<ExternalHarvestOfferDto> = {}): ExternalHarvestOfferDto {
  return { ...ENRICHED, ...overrides };
}
function seed(data: Record<string, unknown> = {}) {
  mockRegistry[PATH] = {
    exists: true,
    data: {
      id: "ext-1",
      status: "accepted",
      listingId: "listing_701",
      mombongoOfferId: "offer_8801",
      lastEventId: "evt-1",
      mombongoOccurredAt: "2026-09-19T11:00:00.000Z",
      invoiceId: "inv-1",
      updatedAt: "2026-09-19T11:00:05.000Z",
      ...data,
    },
  };
}
const stored = () => mockRegistry[PATH].data!;

beforeEach(() => {
  mockRegistry = {};
  updates = [];
});

describe("sanitizeOfferEnrichment", () => {
  it("copies a complete accepted enrichment into the closed snapshot shape", () => {
    expect(sanitizeOfferEnrichment(ENRICHED, NOW)).toEqual({
      sourceAt: "2026-09-19T12:00:00.000Z",
      seller: { id: "farmer_42", displayName: "Marie Kabuya" },
      listing: {
        commodity: "ananas",
        commodityCode: "ANA",
        province: "Kasaï",
        territory: "Demba",
        thumbnailUrl: ENRICHED.listing!.thumbnail!.url,
        thumbnailExpiresAt: "2026-09-19T13:00:00.000Z",
      },
    });
  });

  it("an older Mombongo response without seller/listing yields nothing (no error)", () => {
    const { seller: _s, listing: _l, ...old } = ENRICHED;
    expect(sanitizeOfferEnrichment(old as ExternalHarvestOfferDto, NOW)).toBeNull();
  });

  it("a pending or declined offer yields nothing, even if a response wrongly carried enrichment", () => {
    expect(
      sanitizeOfferEnrichment(dto({ status: "pending", seller: null, listing: null }), NOW),
    ).toBeNull();
    expect(sanitizeOfferEnrichment(dto({ status: "declined" }), NOW)).toBeNull();
    expect(sanitizeOfferEnrichment(externalHarvestOfferDtoFixture, NOW)).toBeNull();
  });

  it("an accepted offer with a seller id but no listing keeps only the seller (no invented product data)", () => {
    const snap = sanitizeOfferEnrichment(
      dto({ seller: { id: "farmer_42", displayName: null }, listing: null }),
      NOW,
    );
    expect(snap).toEqual({
      sourceAt: "2026-09-19T12:00:00.000Z",
      seller: { id: "farmer_42", displayName: null },
    });
  });

  it("never persists unknown or private keys, at any depth", () => {
    const hostile = {
      ...ENRICHED,
      email: "x@y.z",
      seller: {
        id: "farmer_42",
        displayName: "Marie",
        email: "m@k.cd",
        phone: "+243900000000",
        wallet: "w",
        token: "t",
      },
      listing: {
        ...ENRICHED.listing!,
        address: "1 rue X",
        sellerRole: "farmer",
        photoUrls: ["u"],
        thumbnail: { ...ENRICHED.listing!.thumbnail!, headers: { authorization: "Bearer x" } },
      },
      headers: { authorization: "Bearer y" },
    } as unknown as ExternalHarvestOfferDto;
    const snap = sanitizeOfferEnrichment(hostile, NOW)!;
    const json = JSON.stringify(snap);
    for (const leaked of [
      "m@k.cd",
      "243900000000",
      "wallet",
      "token",
      "1 rue X",
      "sellerRole",
      "photoUrls",
      "Bearer",
      "headers",
      "address",
    ]) {
      expect(json).not.toContain(leaked);
    }
    expect(Object.keys(snap.seller!).sort()).toEqual(["displayName", "id"]);
    expect(Object.keys(snap.listing!).sort()).toEqual([
      "commodity",
      "commodityCode",
      "province",
      "territory",
      "thumbnailExpiresAt",
      "thumbnailUrl",
    ]);
  });

  it("drops a display name that is an email or a phone number instead of cleaning it", () => {
    expect(
      sanitizeOfferEnrichment(dto({ seller: { id: "f", displayName: "marie@example.com" } }), NOW)!
        .seller!.displayName,
    ).toBeNull();
    expect(
      sanitizeOfferEnrichment(dto({ seller: { id: "f", displayName: "+243 900 000 000" } }), NOW)!
        .seller!.displayName,
    ).toBeNull();
    expect(
      sanitizeOfferEnrichment(dto({ seller: { id: "f", displayName: "   " } }), NOW)!.seller!
        .displayName,
    ).toBeNull();
  });

  it("ignores malformed optional enrichment safely instead of throwing", () => {
    const junk = [
      { seller: "farmer", listing: 12 },
      { seller: { id: 42, displayName: {} }, listing: [] },
      { seller: { id: "" }, listing: { commodity: 3, thumbnail: "url" } },
      {
        seller: { id: "x".repeat(129), displayName: "A" },
        listing: { commodity: "y".repeat(121), thumbnail: { url: 5, expiresAt: {} } },
      },
    ] as unknown as Partial<ExternalHarvestOfferDto>[];
    for (const j of junk) expect(() => sanitizeOfferEnrichment(dto(j), NOW)).not.toThrow();
    expect(sanitizeOfferEnrichment(dto(junk[0]), NOW)).toBeNull();
    expect(sanitizeOfferEnrichment(dto(junk[3]), NOW)).toBeNull();
    expect(() =>
      sanitizeOfferEnrichment(null as unknown as ExternalHarvestOfferDto, NOW),
    ).not.toThrow();
  });

  it("one bad part does not discard the good part", () => {
    const snap = sanitizeOfferEnrichment(
      dto({ seller: { id: 5 as unknown as string, displayName: "A" } }),
      NOW,
    )!;
    expect(snap.seller).toBeUndefined();
    expect(snap.listing!.commodity).toBe("ananas");
  });

  describe("thumbnail policy", () => {
    const thumb = (t: unknown) =>
      sanitizeOfferEnrichment(
        dto({ listing: { ...ENRICHED.listing!, thumbnail: t as never } }),
        NOW,
      )!.listing!;

    it("is stored only together with its expiry", () => {
      const l = thumb({
        url: "https://storage.googleapis.com/b/o.jpg?sig=1",
        expiresAt: "2026-09-19T12:30:00.000Z",
      });
      expect(l.thumbnailUrl).toContain("storage.googleapis.com");
      expect(l.thumbnailExpiresAt).toBe("2026-09-19T12:30:00.000Z");
    });
    it("an already-expired thumbnail is not stored at all (url and expiry both cleared)", () => {
      const l = thumb({
        url: "https://storage.googleapis.com/b/o.jpg?sig=1",
        expiresAt: "2026-09-19T11:59:59.000Z",
      });
      expect(l.thumbnailUrl).toBeNull();
      expect(l.thumbnailExpiresAt).toBeNull();
      expect(l.commodity).toBe("ananas");
    });
    it("a thumbnail with a malformed expiry, a foreign host or a non-https scheme is dropped", () => {
      for (const bad of [
        { url: "https://storage.googleapis.com/b/o.jpg", expiresAt: "soon" },
        { url: "https://evil.example/o.jpg", expiresAt: "2026-09-19T12:30:00.000Z" },
        { url: "http://storage.googleapis.com/o.jpg", expiresAt: "2026-09-19T12:30:00.000Z" },
        { url: "javascript:alert(1)", expiresAt: "2026-09-19T12:30:00.000Z" },
      ]) {
        const l = thumb(bad);
        expect(l.thumbnailUrl).toBeNull();
        expect(l.thumbnailExpiresAt).toBeNull();
      }
    });
    it("a null thumbnail leaves both fields null", () => {
      const l = thumb(null);
      expect([l.thumbnailUrl, l.thumbnailExpiresAt]).toEqual([null, null]);
    });
  });
});

describe("applyOfferEnrichment", () => {
  const snapshot = () => sanitizeOfferEnrichment(ENRICHED, NOW)!;
  const run = (snap = snapshot()) =>
    applyOfferEnrichment({ offerDocId: "ext-1", mombongoOfferId: "offer_8801", snapshot: snap });

  it("writes seller, listing and the source timestamp on an already-accepted offer — and nothing else", async () => {
    seed();
    const before = { ...stored() };
    expect(await run()).toEqual({ kind: "applied" });
    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0].data).sort()).toEqual([
      "mombongoEnrichmentSourceAt",
      "mombongoListing",
      "mombongoSeller",
    ]);
    for (const untouched of [
      "status",
      "invoiceId",
      "lastEventId",
      "mombongoOccurredAt",
      "updatedAt",
      "listingId",
      "mombongoOfferId",
    ]) {
      expect(stored()[untouched]).toEqual(before[untouched]);
    }
    expect(stored().mombongoSeller).toEqual({ id: "farmer_42", displayName: "Marie Kabuya" });
  });

  it("works on a legacy `won` offer without rewriting its status", async () => {
    seed({ status: "won" });
    expect(await run()).toEqual({ kind: "applied" });
    expect(stored().status).toBe("won");
  });

  it("never touches a pending or declined local offer", async () => {
    seed({ status: "pending" });
    expect(await run()).toEqual({ kind: "skipped", reason: "not_accepted" });
    seed({ status: "declined" });
    expect(await run()).toEqual({ kind: "skipped", reason: "not_accepted" });
    expect(updates).toHaveLength(0);
  });

  it("never creates a second offer: a missing local doc is skipped, not written", async () => {
    expect(await run()).toEqual({ kind: "skipped", reason: "not_found" });
    expect(updates).toHaveLength(0);
    expect(mockRegistry[PATH]).toBeUndefined();
  });

  it("re-checks exact offer identity inside the transaction", async () => {
    seed({ mombongoOfferId: "some-other-offer" });
    expect(await run()).toEqual({ kind: "skipped", reason: "offer_id_mismatch" });
    expect(updates).toHaveLength(0);
  });

  it("an identical replay is a no-op (nothing written)", async () => {
    seed();
    await run();
    updates = [];
    expect(await run()).toEqual({ kind: "unchanged" });
    expect(updates).toHaveLength(0);
  });

  it("a newer source timestamp refreshes the snapshot", async () => {
    seed();
    await run();
    const newer = sanitizeOfferEnrichment(
      dto({
        updatedAt: "2026-09-19T12:10:00.000Z",
        seller: { id: "farmer_42", displayName: "Marie K." },
      }),
      NOW,
    )!;
    expect(await run(newer)).toEqual({ kind: "applied" });
    expect(stored().mombongoSeller).toEqual({ id: "farmer_42", displayName: "Marie K." });
    expect(stored().mombongoEnrichmentSourceAt).toBe("2026-09-19T12:10:00.000Z");
  });

  it("a stale response (older source timestamp) cannot regress newer local metadata", async () => {
    seed();
    await run();
    updates = [];
    const older = sanitizeOfferEnrichment(
      dto({
        updatedAt: "2026-09-19T11:00:00.000Z",
        seller: { id: "farmer_42", displayName: "Old Name" },
        listing: { ...ENRICHED.listing!, commodity: "manioc" },
      }),
      NOW,
    )!;
    expect(await run(older)).toEqual({ kind: "stale" });
    expect(updates).toHaveLength(0);
    expect((stored().mombongoSeller as { displayName: string }).displayName).toBe("Marie Kabuya");
    expect((stored().mombongoListing as { commodity: string }).commodity).toBe("ananas");
  });

  it("a degraded response (Mombongo could not read the listing) never erases good stored data", async () => {
    seed();
    await run();
    const degraded = sanitizeOfferEnrichment(
      dto({
        updatedAt: "2026-09-19T12:20:00.000Z",
        seller: { id: "farmer_42", displayName: null },
        listing: null,
      }),
      NOW,
    )!;
    await run(degraded);
    expect((stored().mombongoSeller as { displayName: string }).displayName).toBe("Marie Kabuya");
    expect((stored().mombongoListing as { commodity: string }).commodity).toBe("ananas");
  });

  it("the seller id is frozen: a response naming a different seller is a conflict and writes nothing", async () => {
    seed();
    await run();
    updates = [];
    const other = sanitizeOfferEnrichment(
      dto({
        updatedAt: "2026-09-19T12:30:00.000Z",
        seller: { id: "someone-else", displayName: "X" },
      }),
      NOW,
    )!;
    expect(await run(other)).toEqual({ kind: "conflict", reason: "seller_id_changed" });
    expect(updates).toHaveLength(0);
    expect((stored().mombongoSeller as { id: string }).id).toBe("farmer_42");
  });

  it("keeps an expired stored thumbnail together with its expiry (the reader decides not to render it), and a fresher one replaces it", async () => {
    seed({
      mombongoEnrichmentSourceAt: "2026-09-19T10:00:00.000Z",
      mombongoSeller: { id: "farmer_42", displayName: "Marie Kabuya" },
      mombongoListing: {
        commodity: "ananas",
        commodityCode: null,
        province: null,
        territory: null,
        thumbnailUrl: "https://storage.googleapis.com/b/old.jpg",
        thumbnailExpiresAt: "2026-09-19T10:30:00.000Z",
      },
    });
    const noThumb = sanitizeOfferEnrichment(
      dto({
        updatedAt: "2026-09-19T12:00:00.000Z",
        listing: { ...ENRICHED.listing!, thumbnail: null },
      }),
      NOW,
    )!;
    await run(noThumb);
    expect(
      stored().mombongoListing as { thumbnailUrl: string; thumbnailExpiresAt: string },
    ).toMatchObject({
      thumbnailUrl: "https://storage.googleapis.com/b/old.jpg",
      thumbnailExpiresAt: "2026-09-19T10:30:00.000Z",
    });

    await run(snapshot());
    expect((stored().mombongoListing as { thumbnailExpiresAt: string }).thumbnailExpiresAt).toBe(
      "2026-09-19T13:00:00.000Z",
    );
  });
});
