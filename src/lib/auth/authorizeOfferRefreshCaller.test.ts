import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeOfferRefreshCaller } from "./authorizeOfferRefreshCaller";
import { verifyFirebaseIdToken } from "./verifyFirebaseIdToken";
import { signInAsMombongoSystem } from "@/lib/payments/mombongoSystemAuth";

let users: Record<string, Record<string, unknown> | undefined> = {};

vi.mock("@/lib/firebase/serverDb", () => ({ serverDb: {} }));
vi.mock("./verifyFirebaseIdToken", () => ({ verifyFirebaseIdToken: vi.fn() }));
vi.mock("@/lib/payments/mombongoSystemAuth", () => ({
  signInAsMombongoSystem: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("firebase/firestore/lite", () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}`, id })),
  getDoc: vi.fn(async (ref: { id: string }) => ({
    exists: () => !!users[ref.id],
    data: () => users[ref.id],
  })),
}));

const HEADER = "Bearer valid-token";
const asUser = (profile: Record<string, unknown> | undefined) => {
  users = { u1: profile };
  vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "u1" } as never);
};

beforeEach(() => {
  users = {};
  vi.mocked(verifyFirebaseIdToken).mockReset();
  vi.mocked(signInAsMombongoSystem).mockClear();
});

describe("authorizeOfferRefreshCaller — allowed", () => {
  it("an active Agent de collecte", async () => {
    asUser({ role: "staff", poste: "Agent de collecte", active: true });
    expect(await authorizeOfferRefreshCaller(HEADER)).toEqual({
      ok: true,
      uid: "u1",
      role: "agent_de_collecte",
    });
  });

  it("an active ADMIN (including one using collection mode — the account itself is the admin)", async () => {
    asUser({ role: "admin", active: true });
    expect(await authorizeOfferRefreshCaller(HEADER)).toEqual({
      ok: true,
      uid: "u1",
      role: "admin",
    });
  });
});

describe("authorizeOfferRefreshCaller — denied (403)", () => {
  const denied: [string, Record<string, unknown>][] = [
    ["Directeur de Production", { role: "staff", poste: "Directeur de Production", active: true }],
    [
      "Chargée de Commercialisation",
      { role: "staff", poste: "Chargée de Commercialisation", active: true },
    ],
    ["Personnalisé staff", { role: "staff", poste: "Personnalisé", active: true }],
    ["staff with no poste", { role: "staff", active: true }],
    [
      "staff with an unrecognized poste",
      { role: "staff", poste: "Agent de collecte ", active: true },
    ],
    ["a partner", { role: "partner", active: true }],
    ["an unknown role", { role: "superuser", active: true }],
    ["an inactive Agent de collecte", { role: "staff", poste: "Agent de collecte", active: false }],
    ["an inactive admin", { role: "admin", active: false }],
    ["an account whose `active` flag is missing", { role: "admin" }],
    [
      "a poste on a non-staff role (admin-looking poste field)",
      { role: "partner", poste: "Agent de collecte", active: true },
    ],
  ];
  for (const [name, profile] of denied) {
    it(name, async () => {
      asUser(profile);
      expect(await authorizeOfferRefreshCaller(HEADER)).toEqual({ ok: false, status: 403 });
    });
  }

  it("a valid token whose user document does not exist", async () => {
    asUser(undefined);
    expect(await authorizeOfferRefreshCaller(HEADER)).toEqual({ ok: false, status: 403 });
  });
});

describe("authorizeOfferRefreshCaller — unauthenticated (401)", () => {
  it("no Authorization header", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue(null);
    expect(await authorizeOfferRefreshCaller(null)).toEqual({ ok: false, status: 401 });
    expect(verifyFirebaseIdToken).toHaveBeenCalledWith(null);
  });

  it("a non-Bearer header", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue(null);
    expect(await authorizeOfferRefreshCaller("Basic abc")).toEqual({ ok: false, status: 401 });
    expect(verifyFirebaseIdToken).toHaveBeenCalledWith(null);
  });

  it("an invalid or expired token never reaches the profile read", async () => {
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue(null);
    expect(await authorizeOfferRefreshCaller(HEADER)).toEqual({ ok: false, status: 401 });
    expect(signInAsMombongoSystem).not.toHaveBeenCalled();
  });
});

describe("authorizeOfferRefreshCaller — only the authenticated account decides", () => {
  it("takes nothing but the Authorization header: no body/query input exists to choose a role or partner", () => {
    expect(authorizeOfferRefreshCaller.length).toBe(1);
  });

  it("reads exactly the token holder's own profile", async () => {
    users = {
      u1: { role: "staff", poste: "Directeur de Production", active: true },
      u2: { role: "admin", active: true },
    };
    vi.mocked(verifyFirebaseIdToken).mockResolvedValue({ uid: "u1" } as never);
    // u2 being an admin does not matter: the token says u1.
    expect(await authorizeOfferRefreshCaller(HEADER)).toEqual({ ok: false, status: 403 });
  });
});
