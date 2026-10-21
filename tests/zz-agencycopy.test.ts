// Phase 6 — agency workspace: tenant isolation, roles, client CRUD, website
// assignment and the invitation flow.
//
// The Convex handlers are invoked directly through their runtime `_handler`
// property with a fake ctx (same approach as tests/convexAuthz.test.ts);
// getAuthUserId is module-mocked so the signed-in identity is controlled per
// test. The fake db implements indexed queries with eq filters, order/take/
// first/collect/unique plus insert/patch/delete, so every authorization path
// in src/convex/agency.ts is exercised end to end.

import { describe, expect, test, mock } from "bun:test";

// Keep the real module's other exports (src/convex/auth.ts loads through it).
const realAuthServer = await import("@convex-dev/auth/server");
let signedInAs: string | null = null;
mock.module("@convex-dev/auth/server", () => ({
  ...realAuthServer,
  getAuthUserId: async () => signedInAs,
}));

const agency = await import("../src/convex/agency");
const {
  MAX_CLIENTS_PER_AGENCY,
  MAX_MEMBERS_PER_AGENCY,
  MAX_PENDING_INVITES,
  MAX_WEBSITES_PER_CLIENT,
} = await import("../src/lib/agency");

type Row = Record<string, unknown> & { _id: string };

/** Minimal in-memory Convex ctx with indexed queries and writes. */
function makeCtx(tables: Record<string, Row[]> = {}) {
  const reads: { table: string; range: Array<[string, unknown]> }[] = [];
  let idSeq = 1;
  const db = {
    async get(id: string) {
      for (const rows of Object.values(tables)) {
        const doc = rows.find((r) => r._id === id);
        if (doc) return doc;
      }
      return null;
    },
    async insert(table: string, doc: Record<string, unknown>) {
      const row = { ...doc, _id: `${table}|i${idSeq}`, _creationTime: idSeq } as Row;
      (tables[table] ??= []).push(row);
      idSeq += 1;
      return row._id as string;
    },
    async patch(id: string, patch: Record<string, unknown>) {
      for (const rows of Object.values(tables)) {
        const doc = rows.find((r) => r._id === id);
        if (doc) {
          for (const [k, v] of Object.entries(patch)) {
            if (v === undefined) delete doc[k];
            else doc[k] = v;
          }
          return;
        }
      }
      throw new Error(`patch: no document ${id}`);
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const idx = rows.findIndex((r) => r._id === id);
        if (idx >= 0) {
          rows.splice(idx, 1);
          return;
        }
      }
      throw new Error(`delete: no document ${id}`);
    },
    query(table: string) {
      const filters: Array<[string, unknown]> = [];
      let dir: "asc" | "desc" = "asc";
      const apply = () => {
        let out = [...(tables[table] ?? [])];
        for (const [field, value] of filters) out = out.filter((d) => d[field] === value);
        if (dir === "desc") out.reverse(); // insertion order approximates createdAt asc
        return out;
      };
      const state: Record<string, unknown> = {};
      state.withIndex = (_name: string, cb?: (q: unknown) => unknown) => {
        if (cb) {
          const recorder: Record<string, unknown> = {};
          for (const op of ["eq", "gt", "gte", "lt", "lte"]) {
            recorder[op] = (field: string, value: unknown) => {
              if (op === "eq") filters.push([field, value]);
              return recorder;
            };
          }
          cb(recorder);
        }
        reads.push({ table, range: [...filters] });
        return state;
      };
      state.order = (d: string) => {
        dir = d === "desc" ? "desc" : "asc";
        return state;
      };
      state.take = async (n: number) => apply().slice(0, n);
      state.first = async () => apply()[0] ?? null;
      state.collect = async () => apply();
      state.unique = async () => {
        const rows = apply();
        if (rows.length > 1) {
          throw new Error(`unique(): ${rows.length} rows in ${table} (index mismatch)`);
        }
        return rows[0] ?? null;
      };
      return state;
    },
  };
  return { ctx: { db }, tables, reads };
}

function handler(fn: unknown) {
  return fn as {
    _handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown>;
  };
}

async function expectAgencyError(
  promise: Promise<unknown>,
  code: string,
  messageContains?: string,
) {
  try {
    await promise;
  } catch (err) {
    const data = (err as { data?: { code?: string; message?: string } }).data;
    expect(data?.code).toBe(code);
    if (messageContains) expect(data?.message).toContain(messageContains);
    return;
  }
  throw new Error(`expected rejection with code "${code}"`);
}

const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Two agencies: Northwind (owner + member) and Other Co (outsider). */
async function seed() {
  const w = makeCtx();
  const db = w.ctx.db;
  const ownerId = await db.insert("users", { email: "owner@northwind.test", name: "Nina" });
  const memberId = await db.insert("users", { email: "member@northwind.test", name: "Mo" });
  const outsiderId = await db.insert("users", { email: "ceo@other.test", name: "Otto" });
  const strangerId = await db.insert("users", { email: "stranger@example.com" });

  const agencyA = await db.insert("agencies", {
    ownerId,
    name: "Northwind Digital",
    createdAt: 1,
  });
  const agencyB = await db.insert("agencies", {
    ownerId: outsiderId,
    name: "Other Co",
    createdAt: 1,
  });
  await db.insert("agencyMembers", { agencyId: agencyA, userId: ownerId, role: "owner", createdAt: 1 });
  await db.insert("agencyMembers", { agencyId: agencyA, userId: memberId, role: "member", createdAt: 2 });
  await db.insert("agencyMembers", { agencyId: agencyB, userId: outsiderId, role: "owner", createdAt: 1 });

  const ownerMonitor = await db.insert("monitors", {
    ownerId,
    name: "acme.com",
    url: "https://acme.com/",
    host: "acme.com",
    status: "active",
    state: "up",
    lastCheckedAt: 1000,
    lastResult: "ok",
  });
  const memberMonitor = await db.insert("monitors", {
    ownerId: memberId,
    name: "member-site.test",
    url: "https://member-site.test/",
    host: "member-site.test",
    status: "active",
    state: "up",
  });
  const strangerMonitor = await db.insert("monitors", {
    ownerId: strangerId,
    name: "not-yours.com",
    url: "https://not-yours.com/",
    host: "not-yours.com",
    status: "active",
    state: "up",
  });
  const outsiderMonitor = await db.insert("monitors", {
    ownerId: outsiderId,
    name: "other.co",
    url: "https://other.co/",
    host: "other.co",
    status: "active",
    state: "down",
  });

  const clientA = await db.insert("clients", {
    agencyId: agencyA,
    name: "Acme Corp",
    archived: false,
    createdAt: 10,
    updatedAt: 10,
  });
  const clientB = await db.insert("clients", {
    agencyId: agencyB,
    name: "Globex",
    archived: false,
    createdAt: 11,
    updatedAt: 11,
  });
  await db.insert("scans", {
    url: "https://acme.com/",
    score: 87,
    grade: "B+",
    scannedAt: 500,
  });

  return {
    w,
    ownerId,
    memberId,
    outsiderId,
    strangerId,
    agencyA,
    agencyB,
    ownerMonitor,
    memberMonitor,
    strangerMonitor,
    outsiderMonitor,
    clientA,
    clientB,
  };
}

function asId(id: string) {
  return id as never;
}

/* ── Tenant isolation ──────────────────────────────────────────────────────── */

describe("agency — tenant isolation", () => {
  test("signed-out callers are rejected by every workspace function", async () => {
    const s = await seed();
    signedInAs = null;
    const ctx = s.w.ctx;
    await expectAgencyError(
      handler(agency.getDashboard)._handler(ctx, { agencyId: asId(s.agencyA) }),
      "unauthenticated",
    );
    await expectAgencyError(
      handler(agency.listClients)._handler(ctx, { agencyId: asId(s.agencyA) }),
      "unauthenticated",
    );
    await expectAgencyError(
      handler(agency.createClient)._handler(ctx, { agencyId: asId(s.agencyA), name: "X" }),
      "unauthenticated",
    );
    // getMyAgency must simply return null when signed out (no throw).
    expect(await handler(agency.getMyAgency)._handler(ctx, {})).toBeNull();
  });

  test("a member of another agency cannot read the dashboard or clients", async () => {
    const s = await seed();
    signedInAs = s.outsiderId;
    const ctx = s.w.ctx;
    await expectAgencyError(
      handler(agency.getDashboard)._handler(ctx, { agencyId: asId(s.agencyA) }),
      "forbidden",
      "not a member",
    );
    await expectAgencyError(
      handler(agency.listClients)._handler(ctx, { agencyId: asId(s.agencyA) }),
      "forbidden",
      "not a member",
    );
    await expectAgencyError(
      handler(agency.listMembers)._handler(ctx, { agencyId: asId(s.agencyA) }),
      "forbidden",
      "not a member",
    );
  });

  test("a stranger cannot create a client in another workspace (no rows written)", async () => {
    const s = await seed();
    signedInAs = s.outsiderId;
    const before = (s.w.tables.clients ?? []).length;
    await expectAgencyError(
      handler(agency.createClient)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        name: "Planted Client",
      }),
      "forbidden",
    );
    expect((s.w.tables.clients ?? []).length).toBe(before);
  });

  test("the dashboard never returns another agency's clients or websites", async () => {
    const s = await seed();
    // Assign Other Co's own monitor to its client so B has a website row.
    signedInAs = s.outsiderId;
    await handler(agency.assignWebsite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyB),
      clientId: asId(s.clientB),
      monitorId: asId(s.outsiderMonitor),
    });

    signedInAs = s.memberId;
    const dash = (await handler(agency.getDashboard)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
    })) as { clients: { name: string; websites: { url: string }[] }[] };
    const names = dash.clients.map((c) => c.name);
    expect(names).toContain("Acme Corp");
    expect(names).not.toContain("Globex");
    expect(dash.clients.flatMap((c) => c.websites).map((w) => w.url)).not.toContain(
      "https://other.co/",
    );
  });

  test("a client id from another agency resolves to not_found, never data", async () => {
    const s = await seed();
    signedInAs = s.memberId;
    await expectAgencyError(
      handler(agency.getClient)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientB),
      }),
      "not_found",
    );
    await expectAgencyError(
      handler(agency.updateClient)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientB),
        name: "Hijacked",
      }),
      "not_found",
    );
    await expectAgencyError(
      handler(agency.setClientArchived)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientB),
        archived: true,
      }),
      "not_found",
    );
    // The other agency's client is untouched.
    const untouched = (s.w.tables.clients ?? []).find((c) => c._id === s.clientB);
    expect(untouched?.name).toBe("Globex");
    expect(untouched?.archived).toBe(false);
  });

  test("assignment rows are scoped to their own agency on removal", async () => {
    const s = await seed();
    signedInAs = s.outsiderId;
    await handler(agency.assignWebsite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyB),
      clientId: asId(s.clientB),
      monitorId: asId(s.outsiderMonitor),
    });
    const row = (s.w.tables.clientWebsites ?? [])[0];

    // A member of A naming A's workspace but B's assignment row: the row
    // must be resolved INSIDE the named agency, so this is not_found.
    signedInAs = s.memberId;
    await expectAgencyError(
      handler(agency.unassignWebsite)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        websiteId: row._id as never,
      }),
      "not_found",
    );
    // Naming B's agency directly fails the membership gate instead — the
    // member of A was never a member of B.
    await expectAgencyError(
      handler(agency.unassignWebsite)._handler(ctxOf(s), {
        agencyId: asId(s.agencyB),
        websiteId: row._id as never,
      }),
      "forbidden",
    );
    expect((s.w.tables.clientWebsites ?? []).length).toBe(1);
  });
});

function ctxOf(s: Awaited<ReturnType<typeof seed>>) {
  return s.w.ctx;
}

/* ── Roles: owner vs member ────────────────────────────────────────────────── */

describe("agency — roles", () => {
  test("members cannot manage the team or branding; owners can", async () => {
    const s = await seed();
    signedInAs = s.memberId;
    const ownerOnly = "Only the agency owner can manage the team and workspace settings.";
    await expectAgencyError(
      handler(agency.inviteMember)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        email: "new@northwind.test",
      }),
      "forbidden",
      ownerOnly,
    );
    await expectAgencyError(
      handler(agency.listInvites)._handler(ctxOf(s), { agencyId: asId(s.agencyA) }),
      "forbidden",
      ownerOnly,
    );
    await expectAgencyError(
      handler(agency.updateAgency)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        name: "Renamed By Member",
      }),
      "forbidden",
      ownerOnly,
    );
    // Nothing was written by the denied calls.
    expect((s.w.tables.agencyInvites ?? []).length).toBe(0);
    const row = (s.w.tables.agencies ?? []).find((a) => a._id === s.agencyA);
    expect(row?.name).toBe("Northwind Digital");
  });

  test("members may still run clients and assignments (by design)", async () => {
    const s = await seed();
    signedInAs = s.memberId;
    const clientId = (await handler(agency.createClient)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      name: "Member Client",
    })) as string;
    expect(typeof clientId).toBe("string");
    // The member assigns a monitor from their OWN account (the owner's
    // monitor stays off limits — verified in the assignment tests).
    await handler(agency.assignWebsite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId,
      monitorId: asId(s.memberMonitor),
    });
    expect((s.w.tables.clientWebsites ?? []).length).toBe(1);
  });

  test("inviting returns the token exactly once and listInvites never exposes it", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    const result = (await handler(agency.inviteMember)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      email: "New.Hire@Northwind.TEST",
    })) as { token: string; email: string };
    expect(result.token).toMatch(TOKEN_RE);
    expect(result.email).toBe("new.hire@northwind.test"); // normalized

    const listed = (await handler(agency.listInvites)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
    })) as Record<string, unknown>[];
    expect(listed.length).toBe(1);
    expect(listed[0].status).toBe("pending");
    expect(JSON.stringify(listed)).not.toContain(result.token);
  });

  test("the owner cannot leave; a member can", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    await expectAgencyError(handler(agency.leaveAgency)._handler(ctxOf(s), {}), "owner");
    signedInAs = s.memberId;
    await handler(agency.leaveAgency)._handler(ctxOf(s), {});
    expect(
      (s.w.tables.agencyMembers ?? []).filter((m) => m.agencyId === s.agencyA).length,
    ).toBe(1);
  });

  test("one workspace per user: a second createAgency is rejected", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    await expectAgencyError(
      handler(agency.createAgency)._handler(ctxOf(s), { name: "Second Workspace" }),
      "already_member",
    );
  });

  test("createAgency validates the name and rejects non-http(s) logos", async () => {
    const s = await seed();
    signedInAs = s.strangerId;
    await expectAgencyError(
      handler(agency.createAgency)._handler(ctxOf(s), { name: "   " }),
      "invalid_name",
    );
    await expectAgencyError(
      handler(agency.createAgency)._handler(ctxOf(s), {
        name: "XSS Agency",
        logoUrl: "javascript:alert(1)",
      }),
      "invalid_logo",
    );
    const ok = (await handler(agency.createAgency)._handler(ctxOf(s), {
      name: "  Straight   Line  ",
      logoUrl: "https://cdn.example.com/logo.png",
    })) as string;
    const created = (s.w.tables.agencies ?? []).find((a) => a._id === ok);
    expect(created?.name).toBe("Straight Line");
    expect(created?.logoUrl).toBe("https://cdn.example.com/logo.png");
    signedInAs = s.strangerId;
    const mine = (await handler(agency.getMyAgency)._handler(ctxOf(s), {})) as {
      role: string;
    };
    expect(mine.role).toBe("owner");
  });
});

/* ── Client CRUD ───────────────────────────────────────────────────────────── */

describe("agency — client CRUD", () => {
  test("createClient normalizes the name and contact", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    const id = (await handler(agency.createClient)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      name: "  Beta    Industries  ",
      contact: "  Dana @ Acme  ",
    })) as string;
    const row = (s.w.tables.clients ?? []).find((c) => c._id === id);
    expect(row?.name).toBe("Beta Industries");
    expect(row?.contact).toBe("Dana @ Acme");
    expect(row?.archived).toBe(false);
  });

  test("createClient rejects empty and overlong names", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    await expectAgencyError(
      handler(agency.createClient)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        name: "    ",
      }),
      "invalid_name",
    );
    await expectAgencyError(
      handler(agency.createClient)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        name: "x".repeat(121),
      }),
      "invalid_name",
    );
  });

  test("createClient enforces the per-workspace active client limit", async () => {
    const s = await seed();
    // Fill the workspace to the cap with active clients.
    for (let i = 0; i < MAX_CLIENTS_PER_AGENCY - 1; i += 1) {
      await s.w.ctx.db.insert("clients", {
        agencyId: s.agencyA,
        name: `Filler ${i}`,
        archived: false,
        createdAt: 20 + i,
        updatedAt: 20 + i,
      });
    }
    signedInAs = s.ownerId;
    // At the cap now (seeded Acme + fillers): one more active client fails.
    await expectAgencyError(
      handler(agency.createClient)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        name: "One Too Many",
      }),
      "limit",
    );
  });

  test("updateClient renames and validates; archived clients can be renamed too", async () => {
    const s = await seed();
    signedInAs = s.memberId;
    await handler(agency.updateClient)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId: asId(s.clientA),
      name: "  Acme   Corporation  ",
      contact: "billing@acme.test",
    });
    const row = (s.w.tables.clients ?? []).find((c) => c._id === s.clientA);
    expect(row?.name).toBe("Acme Corporation");
    expect(row?.contact).toBe("billing@acme.test");

    await expectAgencyError(
      handler(agency.updateClient)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientA),
        name: " ",
      }),
      "invalid_name",
    );
  });

  test("archiving hides a client from the default list; restore respects the cap", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    await handler(agency.setClientArchived)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId: asId(s.clientA),
      archived: true,
    });
    const visible = (await handler(agency.listClients)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
    })) as { name: string }[];
    expect(visible.map((c) => c.name)).not.toContain("Acme Corp");

    const withArchived = (await handler(agency.listClients)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      includeArchived: true,
    })) as { name: string; archived: boolean }[];
    expect(withArchived.find((c) => c.name === "Acme Corp")?.archived).toBe(true);

    // Fill to the cap, then restoring the archived client must fail.
    for (let i = 0; i < MAX_CLIENTS_PER_AGENCY; i += 1) {
      await s.w.ctx.db.insert("clients", {
        agencyId: s.agencyA,
        name: `Filler ${i}`,
        archived: false,
        createdAt: 30 + i,
        updatedAt: 30 + i,
      });
    }
    await expectAgencyError(
      handler(agency.setClientArchived)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientA),
        archived: false,
      }),
      "limit",
    );
    // But archiving further still works (freeing a slot).
    await handler(agency.setClientArchived)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId: asId(s.clientA),
      archived: true,
    });
  });
});

/* ── Website assignment ────────────────────────────────────────────────────── */

describe("agency — website assignment", () => {
  test("assigning your own monitor works and is idempotent", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    const first = (await handler(agency.assignWebsite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId: asId(s.clientA),
      monitorId: asId(s.ownerMonitor),
    })) as { alreadyAssigned: boolean };
    expect(first.alreadyAssigned).toBe(false);
    const second = (await handler(agency.assignWebsite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId: asId(s.clientA),
      monitorId: asId(s.ownerMonitor),
    })) as { alreadyAssigned: boolean };
    expect(second.alreadyAssigned).toBe(true);
    expect((s.w.tables.clientWebsites ?? []).length).toBe(1);
  });

  test("a monitor owned by someone else can never be assigned (ownership check)", async () => {
    const s = await seed();
    signedInAs = s.memberId; // member of A, but the monitor belongs to a stranger
    await expectAgencyError(
      handler(agency.assignWebsite)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientA),
        monitorId: asId(s.strangerMonitor),
      }),
      "forbidden",
      "not one of your monitors",
    );
    // Another agency's monitor is no different.
    await expectAgencyError(
      handler(agency.assignWebsite)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientA),
        monitorId: asId(s.outsiderMonitor),
      }),
      "forbidden",
    );
    expect((s.w.tables.clientWebsites ?? []).length).toBe(0);
  });

  test("a monitor can live on only one client at a time", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    const other = await s.w.ctx.db.insert("clients", {
      agencyId: s.agencyA,
      name: "Second Client",
      archived: false,
      createdAt: 99,
      updatedAt: 99,
    });
    await handler(agency.assignWebsite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId: asId(s.clientA),
      monitorId: asId(s.ownerMonitor),
    });
    await expectAgencyError(
      handler(agency.assignWebsite)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(other),
        monitorId: asId(s.ownerMonitor),
      }),
      "already_assigned",
    );

    // Removing it from the first client frees it for the second.
    const row = (s.w.tables.clientWebsites ?? [])[0];
    await handler(agency.unassignWebsite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      websiteId: row._id as never,
    });
    const moved = (await handler(agency.assignWebsite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId: asId(other),
      monitorId: asId(s.ownerMonitor),
    })) as { alreadyAssigned: boolean };
    expect(moved.alreadyAssigned).toBe(false);
  });

  test("archived clients cannot receive websites", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    await handler(agency.setClientArchived)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId: asId(s.clientA),
      archived: true,
    });
    await expectAgencyError(
      handler(agency.assignWebsite)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientA),
        monitorId: asId(s.ownerMonitor),
      }),
      "archived",
    );
  });

  test("per-client website limit is enforced server-side", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    for (let i = 0; i < MAX_WEBSITES_PER_CLIENT; i += 1) {
      const m = await s.w.ctx.db.insert("monitors", {
        ownerId: s.ownerId,
        name: `site-${i}.test`,
        url: `https://site-${i}.test/`,
        status: "active",
        state: "up",
      });
      await handler(agency.assignWebsite)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientA),
        monitorId: asId(m),
      });
    }
    const overflow = await s.w.ctx.db.insert("monitors", {
      ownerId: s.ownerId,
      name: "overflow.test",
      url: "https://overflow.test/",
      status: "active",
      state: "up",
    });
    await expectAgencyError(
      handler(agency.assignWebsite)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        clientId: asId(s.clientA),
        monitorId: asId(overflow),
      }),
      "limit",
    );
  });

  test("the dashboard surfaces uptime state and the latest saved report", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    await handler(agency.assignWebsite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      clientId: asId(s.clientA),
      monitorId: asId(s.ownerMonitor),
    });
    const dash = (await handler(agency.getDashboard)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
    })) as {
      role: string;
      stats: { activeClients: number; websites: number; up: number };
      clients: {
        name: string;
        down: number;
        websiteCount: number;
        latestReportAt: number | null;
        websites: { state: string; latestReport: { score: number; grade: string } | null }[];
      }[];
    };
    expect(dash.role).toBe("owner");
    expect(dash.stats).toMatchObject({ activeClients: 1, websites: 1, up: 1 });
    const client = dash.clients.find((c) => c.name === "Acme Corp");
    expect(client?.websiteCount).toBe(1);
    expect(client?.latestReportAt).toBe(500);
    expect(client?.websites[0]?.state).toBe("up");
    expect(client?.websites[0]?.latestReport).toMatchObject({ score: 87, grade: "B+" });
  });
});

/* ── Invitations: an email alone grants nothing ────────────────────────────── */

describe("agency — invitation flow", () => {
  async function invite(s: Awaited<ReturnType<typeof seed>>) {
    signedInAs = s.ownerId;
    return (await handler(agency.inviteMember)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      email: "new.hire@northwind.test",
    })) as { token: string; inviteId: string };
  }

  test("accepting requires a signed-in account whose OWN email matches", async () => {
    const s = await seed();
    const { token } = await invite(s);

    // Right token, wrong account: rejected, and nothing changes.
    signedInAs = s.strangerId;
    await expectAgencyError(
      handler(agency.acceptInvite)._handler(ctxOf(s), { token }),
      "wrong_account",
      "new.hire@northwind.test",
    );
    expect(
      (s.w.tables.agencyMembers ?? []).filter((m) => m.userId === s.strangerId).length,
    ).toBe(0);
    const inviteRow = (s.w.tables.agencyInvites ?? [])[0];
    expect(inviteRow.acceptedAt).toBeUndefined();

    // Signed out entirely: rejected.
    signedInAs = null;
    await expectAgencyError(
      handler(agency.acceptInvite)._handler(ctxOf(s), { token }),
      "unauthenticated",
    );
  });

  test("a matching signed-in account may accept exactly once", async () => {
    const s = await seed();
    const { token } = await invite(s);
    const hireId = await s.w.ctx.db.insert("users", { email: "new.hire@northwind.test" });

    signedInAs = hireId;
    await handler(agency.acceptInvite)._handler(ctxOf(s), { token });
    const memberships = (s.w.tables.agencyMembers ?? []).filter((m) => m.userId === hireId);
    expect(memberships.length).toBe(1);
    expect(memberships[0].role).toBe("member");

    // The token is single-use.
    await expectAgencyError(
      handler(agency.acceptInvite)._handler(ctxOf(s), { token }),
      "invalid_invite",
    );
  });

  test("malformed, expired and revoked tokens are all rejected", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    await expectAgencyError(
      handler(agency.acceptInvite)._handler(ctxOf(s), { token: "not-a-token" }),
      "invalid_invite",
    );

    const hireId = await s.w.ctx.db.insert("users", { email: "new.hire@northwind.test" });
    const expired = await s.w.ctx.db.insert("agencyInvites", {
      agencyId: s.agencyA,
      email: "new.hire@northwind.test",
      token: "a".repeat(64),
      invitedBy: s.ownerId,
      createdAt: 1,
      expiresAt: 1, // long in the past
    });
    signedInAs = hireId;
    await expectAgencyError(
      handler(agency.acceptInvite)._handler(ctxOf(s), { token: "a".repeat(64) }),
      "invalid_invite",
    );

    const revoked = await s.w.ctx.db.insert("agencyInvites", {
      agencyId: s.agencyA,
      email: "new.hire@northwind.test",
      token: "b".repeat(64),
      invitedBy: s.ownerId,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      revokedAt: 2,
    });
    expect(revoked).toBeTruthy();
    await expectAgencyError(
      handler(agency.acceptInvite)._handler(ctxOf(s), { token: "b".repeat(64) }),
      "invalid_invite",
    );
    expect(
      (s.w.tables.agencyMembers ?? []).filter((m) => m.userId === hireId).length,
    ).toBe(0);
  });

  test("previewInvite is safe for signed-out visitors and leaks no token", async () => {
    const s = await seed();
    const { token } = await invite(s);
    signedInAs = null;
    const preview = (await handler(agency.previewInvite)._handler(ctxOf(s), {
      token,
    })) as Record<string, unknown>;
    expect(preview.status).toBe("pending");
    expect(preview.email).toBe("new.hire@northwind.test");
    expect(preview.agencyName).toBe("Northwind Digital");
    expect(JSON.stringify(preview)).not.toContain(token);

    const invalid = (await handler(agency.previewInvite)._handler(ctxOf(s), {
      token: "zz",
    })) as { status: string };
    expect(invalid.status).toBe("invalid");
  });

  test("inviteMember validates input and enforces member/pending caps", async () => {
    const s = await seed();
    signedInAs = s.ownerId;
    await expectAgencyError(
      handler(agency.inviteMember)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        email: "not-an-email",
      }),
      "invalid_email",
    );
    // Inviting an existing member's address is rejected.
    await expectAgencyError(
      handler(agency.inviteMember)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        email: "member@northwind.test",
      }),
      "already_member",
    );

    // Member cap.
    for (let i = 0; i < MAX_MEMBERS_PER_AGENCY - 2; i += 1) {
      await s.w.ctx.db.insert("agencyMembers", {
        agencyId: s.agencyA,
        userId: await s.w.ctx.db.insert("users", { email: `m${i}@northwind.test` }),
        role: "member",
        createdAt: 100 + i,
      });
    }
    await expectAgencyError(
      handler(agency.inviteMember)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        email: "one.too.many@northwind.test",
      }),
      "limit",
    );

    // Pending invite cap (workspace currently has 0 pending after the failures).
    for (let i = 0; i < MAX_PENDING_INVITES; i += 1) {
      await s.w.ctx.db.insert("agencyInvites", {
        agencyId: s.agencyA,
        email: `pending${i}@northwind.test`,
        token: `${i}`.padStart(64, "0"),
        invitedBy: s.ownerId,
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      });
    }
    await expectAgencyError(
      handler(agency.inviteMember)._handler(ctxOf(s), {
        agencyId: asId(s.agencyA),
        email: "another@northwind.test",
      }),
      "limit",
    );
  });

  test("revoking an invitation kills the link before acceptance", async () => {
    const s = await seed();
    const { token, inviteId } = await invite(s);
    signedInAs = s.ownerId;
    await handler(agency.revokeInvite)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
      inviteId: asId(inviteId),
    });
    const hireId = await s.w.ctx.db.insert("users", { email: "new.hire@northwind.test" });
    signedInAs = hireId;
    await expectAgencyError(
      handler(agency.acceptInvite)._handler(ctxOf(s), { token }),
      "invalid_invite",
    );
    // A revoked invite can't be revoked twice into confusion either.
    signedInAs = s.ownerId;
    const listed = (await handler(agency.listInvites)._handler(ctxOf(s), {
      agencyId: asId(s.agencyA),
    })) as { status: string }[];
    expect(listed[0]?.status).toBe("revoked");
  });
});
