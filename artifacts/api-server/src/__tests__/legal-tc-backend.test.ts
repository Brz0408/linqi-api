/**
 * Task #603 — T&C Backend
 * Tests: SA sections & gates management, portal acceptance routes,
 * and the public sections endpoint.
 *
 * Total: 24 tests
 * Pattern: mini express app + mocked DB/auth (same as buyer-dashboard.test.ts)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Hoisted fixtures ──────────────────────────────────────────────────────────

const {
  mockDbSelect, mockDbInsert, mockDbUpdate, mockDbDelete, mockDbTransaction,
  SA_ID, DOC_ID, COMPANY_A, USER_A,
} = vi.hoisted(() => ({
  mockDbSelect:      vi.fn(),
  mockDbInsert:      vi.fn(),
  mockDbUpdate:      vi.fn(),
  mockDbDelete:      vi.fn(),
  mockDbTransaction: vi.fn(),
  SA_ID:     "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa",
  DOC_ID:    "dddddddd-1111-1111-1111-dddddddddddd",
  COMPANY_A: "cccccccc-aaaa-aaaa-aaaa-cccccccccccc",
  USER_A:    "11111111-1111-1111-1111-111111111111",
}));

vi.mock("../lib/db.js", () => ({
  db: {
    select:      mockDbSelect,
    insert:      mockDbInsert,
    update:      mockDbUpdate,
    delete:      mockDbDelete,
    transaction: mockDbTransaction,
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/audit.js", () => ({
  writeAuditLog: vi.fn(() => Promise.resolve()),
}));

vi.mock("../middlewares/auth.middleware.js", () => ({
  requireCompanyUser: (req: any, res: any, next: any) => {
    if (!req.companyUser) { res.status(401).json({ error: "Unauthorized" }); return; }
    next();
  },
  requireSameCompany: (req: any, res: any, next: any) => {
    const param = String(req.params?.["companyId"] ?? "");
    if (req.companyUser?.companyId !== param) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  },
  requireSuperAdmin: (req: any, res: any, next: any) => {
    if (!req.superAdmin) { res.status(401).json({ error: "SA auth required" }); return; }
    next();
  },
  requireSAPermission: (_m: string, _a?: string) => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middlewares/company-status.middleware.js", () => ({
  requireCanPublish:    (_req: any, _res: any, next: any) => next(),
  getCompanyAccessState: vi.fn(),
  requireBuyerCapability: (_req: any, _res: any, next: any) => next(),
  requireSellerCapability: (_req: any, _res: any, next: any) => next(),
}));

// ── DB mock helpers ───────────────────────────────────────────────────────────

function makeSelectChain(rows: unknown[]) {
  const p = Promise.resolve(rows);
  const node: Record<string, unknown> = {};
  const self = () => node;
  node["from"]       = self;
  node["where"]      = self;
  node["innerJoin"]  = self;
  node["leftJoin"]   = self;
  node["orderBy"]    = self;
  node["groupBy"]    = self;
  node["limit"]      = self;
  node["offset"]     = self;
  node["for"]        = self;
  node["$dynamic"]   = self;
  node["then"]  = (f: ((v: unknown) => unknown) | null, r?: ((e: unknown) => unknown) | null) =>
    p.then(f, r ?? undefined);
  node["catch"] = (r: ((e: unknown) => unknown) | null) => p.catch(r ?? undefined);
  return node;
}

function setupSelectQueue(queue: unknown[][]) {
  let i = 0;
  mockDbSelect.mockImplementation(() => makeSelectChain(queue[i++] ?? []));
}

function makeInsertChain(returnRows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain["values"]              = () => chain;
  chain["onConflictDoNothing"] = () => chain;
  chain["onConflictDoUpdate"]  = () => chain;
  chain["returning"]           = () => Promise.resolve(returnRows);
  return chain;
}

function makeDeleteChain() {
  const chain: Record<string, unknown> = {};
  chain["where"] = () => Promise.resolve();
  return chain;
}

function makeMutationChain(returnRows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain["set"] = self;
  chain["where"] = self;
  chain["returning"] = () => Promise.resolve(returnRows);
  chain["then"] = (resolve: (value: unknown) => unknown) => Promise.resolve(returnRows).then(resolve);
  return chain;
}

// ── App factories ─────────────────────────────────────────────────────────────

async function makeSAApp() {
  const { default: saContentRouter } = await import("../routes/superadmin-content.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.superAdmin = { superAdminId: SA_ID };
    next();
  });
  app.use("/superadmin", saContentRouter);
  return app;
}

async function makePortalApp(companyId = COMPANY_A, userId = USER_A) {
  const { default: legalAcceptanceRouter } = await import("../routes/legal-acceptance.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.companyUser = { companyId, userId };
    next();
  });
  app.use("/companies/:companyId/legal", legalAcceptanceRouter);
  return app;
}

async function makePublicApp() {
  const { default: contentLegalRouter } = await import("../routes/content-legal.js");
  const app = express();
  app.use(express.json());
  app.use("/content", contentLegalRouter);
  return app;
}

// ── Helper section/gate fixtures ─────────────────────────────────────────────

const SAMPLE_SECTIONS = [
  {
    sectionKey: "ratification_of_agreement",
    displayOrder: 0,
    titleEn: "Ratification of the Agreement",
    titleAr: "المصادقة على الاتفاقية",
    titleKu: "پاڵپشتی ئەگەر",
    contentEn: "By using this platform you agree...",
    contentAr: "باستخدام هذه المنصة توافق...",
    contentKu: "بەکارهێنانی ئەم پلاتفۆرمە...",
  },
];

const SAMPLE_GATES = [
  { moduleKey: "marketplace", requiresAcceptance: true },
  { moduleKey: "orders",      requiresAcceptance: true },
];

// ── SA: Sections routes ───────────────────────────────────────────────────────

// ── SA: Notification Summary route ────────────────────────────────────────────

describe("SA GET /superadmin/content/documents/:id/notification-summary", () => {
  let app: ReturnType<typeof express>;
  beforeEach(async () => { app = await makeSAApp(); vi.clearAllMocks(); });

  it("NS-01: returns dispatched/errors/sentAt/accepted from the audit log and acceptances table", async () => {
    const sentAt = new Date("2026-08-23T10:00:00.000Z");
    setupSelectQueue([
      // (1) audit log query
      [{ createdAt: sentAt, metadata: { dispatched: 42, errors: 3, documentType: "terms_and_conditions" } }],
      // (2) gates query
      [{ id: "gate-1" }],
      // (3) acceptance count query
      [{ count: 18 }],
    ]);
    const res = await request(app)
      .get(`/superadmin/content/documents/${DOC_ID}/notification-summary`);
    expect(res.status).toBe(200);
    const { notificationSummary: ns } = res.body;
    expect(ns.dispatched).toBe(42);
    expect(ns.errors).toBe(3);
    expect(new Date(ns.sentAt).getTime()).toBe(sentAt.getTime());
    expect(ns.hasAcceptanceGates).toBe(true);
    expect(ns.accepted).toBe(18);
  });

  it("NS-02: returns hasAcceptanceGates=false when no gates exist", async () => {
    setupSelectQueue([
      [{ createdAt: new Date(), metadata: { dispatched: 10, errors: 0 } }],
      [], // no gates
      [{ count: 5 }],
    ]);
    const res = await request(app)
      .get(`/superadmin/content/documents/${DOC_ID}/notification-summary`);
    expect(res.status).toBe(200);
    expect(res.body.notificationSummary.hasAcceptanceGates).toBe(false);
    expect(res.body.notificationSummary.accepted).toBe(5);
  });

  it("NS-03: returns sentAt=null and dispatched=0 when no audit log entry exists", async () => {
    setupSelectQueue([
      [], // no audit log
      [{ id: "gate-1" }],
      [{ count: 0 }],
    ]);
    const res = await request(app)
      .get(`/superadmin/content/documents/${DOC_ID}/notification-summary`);
    expect(res.status).toBe(200);
    const { notificationSummary: ns } = res.body;
    expect(ns.dispatched).toBe(0);
    expect(ns.errors).toBe(0);
    expect(ns.sentAt).toBeNull();
    expect(ns.hasAcceptanceGates).toBe(true);
    expect(ns.accepted).toBe(0);
  });

  it("NS-04: returns 401 without SA auth", async () => {
    const { default: router } = await import("../routes/superadmin-content.js");
    const unauthApp = express();
    unauthApp.use(express.json());
    unauthApp.use("/superadmin", router);
    const res = await request(unauthApp)
      .get(`/superadmin/content/documents/${DOC_ID}/notification-summary`);
    expect(res.status).toBe(401);
  });

  it("NS-05: accepted defaults to 0 when count row is absent", async () => {
    setupSelectQueue([
      [{ createdAt: new Date(), metadata: { dispatched: 8, errors: 0 } }],
      [{ id: "gate-1" }],
      [], // DB returned no rows for count (unusual but must be handled)
    ]);
    const res = await request(app)
      .get(`/superadmin/content/documents/${DOC_ID}/notification-summary`);
    expect(res.status).toBe(200);
    expect(res.body.notificationSummary.accepted).toBe(0);
  });
});

describe("Legal lifecycle transaction serialization", () => {
  const draft = {
    id: DOC_ID,
    documentType: "terms_and_conditions",
    status: "draft",
    effectiveAt: null,
    titleEn: "Terms",
    titleAr: "الشروط",
    titleKu: "مەرجەکان",
    version: "2.0",
  };
  const published = { ...draft, status: "published" };

  function setupTransaction(selectRows: unknown[][], mutationRows: unknown[][]) {
    let selectIndex = 0;
    let mutationIndex = 0;
    let rolledBack = false;
    const events: string[] = [];
    const tx = {
      select: vi.fn(() => {
        events.push("select");
        return makeSelectChain(selectRows[selectIndex++] ?? []);
      }),
      execute: vi.fn(() => {
        events.push("execute");
        return Promise.resolve();
      }),
      update: vi.fn(() => {
        events.push("update");
        return makeMutationChain(mutationRows[mutationIndex++] ?? []);
      }),
    };
    mockDbTransaction.mockImplementation(async (callback: (value: typeof tx) => Promise<unknown>) => {
      try {
        return await callback(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    return { tx, events, wasRolledBack: () => rolledBack };
  }

  it("rolls back archival when the publish CAS loses a late race", async () => {
    const txState = setupTransaction([[draft], [draft]], [[], []]);
    const app = await makeSAApp();
    const response = await request(app).patch(`/superadmin/content/documents/${DOC_ID}/publish`);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("LEGAL_LIFECYCLE_CONFLICT");
    expect(txState.wasRolledBack()).toBe(true);
    expect(txState.tx.execute).toHaveBeenCalledTimes(2);
    expect(txState.tx.update).toHaveBeenCalledTimes(2);
    expect(txState.events).toEqual(["execute", "select", "execute", "select", "update", "update"]);
  });

  it("rolls back a stale published->archived transition instead of losing the official row", async () => {
    const txState = setupTransaction([[published], [published]], [[]]);
    const app = await makeSAApp();
    const response = await request(app).patch(`/superadmin/content/documents/${DOC_ID}/archive`);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("LEGAL_LIFECYCLE_CONFLICT");
    expect(txState.wasRolledBack()).toBe(true);
    expect(txState.tx.execute).toHaveBeenCalledTimes(2);
    expect(txState.tx.update).toHaveBeenCalledTimes(1);
    expect(txState.events).toEqual(["execute", "select", "execute", "select", "update"]);
  });

  it("retains archive compatibility for drafts and archived no-op requests", async () => {
    const draftState = setupTransaction([[draft], [draft]], [[{ id: DOC_ID }]]);
    const app = await makeSAApp();
    await request(app).patch(`/superadmin/content/documents/${DOC_ID}/archive`).expect(200);
    expect(draftState.tx.update).toHaveBeenCalledTimes(1);

    const archivedState = setupTransaction(
      [[{ ...draft, status: "archived" }], [{ ...draft, status: "archived" }]],
      [],
    );
    await request(app).patch(`/superadmin/content/documents/${DOC_ID}/archive`).expect(200);
    expect(archivedState.tx.update).not.toHaveBeenCalled();
  });
});

describe("SA GET /superadmin/content/documents/:id/sections", () => {
  let app: ReturnType<typeof express>;
  beforeEach(async () => { app = await makeSAApp(); vi.clearAllMocks(); });

  it("TC-SA-S01: returns sections list for a known document", async () => {
    const stored = [{ id: "sec-1", legalDocumentId: DOC_ID, ...SAMPLE_SECTIONS[0], createdAt: new Date(), updatedAt: new Date() }];
    setupSelectQueue([[{ id: DOC_ID }], stored]);

    const res = await request(app)
      .get(`/superadmin/content/documents/${DOC_ID}/sections`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sections)).toBe(true);
    expect(res.body.sections[0]?.sectionKey).toBe("ratification_of_agreement");
  });

  it("TC-SA-S02: returns 404 when document does not exist", async () => {
    setupSelectQueue([[]]);
    const res = await request(app)
      .get(`/superadmin/content/documents/${DOC_ID}/sections`);
    expect(res.status).toBe(404);
  });
});

describe("SA PUT /superadmin/content/documents/:id/sections", () => {
  let app: ReturnType<typeof express>;
  beforeEach(async () => { app = await makeSAApp(); vi.clearAllMocks(); });

  it("TC-SA-S03: atomically replaces sections", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([{ id: DOC_ID, status: "draft" }])),
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/sections`)
      .send({ sections: SAMPLE_SECTIONS });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sectionCount).toBe(1);
  });

  it("TC-SA-S04: clears all sections when empty array sent", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([{ id: DOC_ID, status: "draft" }])),
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/sections`)
      .send({ sections: [] });
    expect(res.status).toBe(200);
    expect(res.body.sectionCount).toBe(0);
  });

  it("TC-SA-S05: returns 404 when document does not exist", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([])),   // zero rows → doc not found
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/sections`)
      .send({ sections: SAMPLE_SECTIONS });
    expect(res.status).toBe(404);
  });

  it("TC-SA-S06: rejects invalid section key", async () => {
    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/sections`)
      .send({ sections: [{ sectionKey: "invalid_key", displayOrder: 0 }] });
    expect(res.status).toBe(400);
  });

  it("TC-SA-S07: returns 400 when body is missing sections array", async () => {
    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/sections`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("TC-SA-S08: returns 409 DOCUMENT_NOT_DRAFT when document is published", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([{ id: DOC_ID, status: "published" }])),
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/sections`)
      .send({ sections: SAMPLE_SECTIONS });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DOCUMENT_NOT_DRAFT");
  });

  it("TC-SA-S09: returns 409 DOCUMENT_NOT_DRAFT when document is archived", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([{ id: DOC_ID, status: "archived" }])),
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/sections`)
      .send({ sections: SAMPLE_SECTIONS });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DOCUMENT_NOT_DRAFT");
  });
});

// ── SA: Module Gates routes ───────────────────────────────────────────────────

describe("SA GET /superadmin/content/documents/:id/module-gates", () => {
  let app: ReturnType<typeof express>;
  beforeEach(async () => { app = await makeSAApp(); vi.clearAllMocks(); });

  it("TC-SA-G01: returns gate list for a known document", async () => {
    const stored = [
      { id: "gate-1", legalDocumentId: DOC_ID, moduleKey: "marketplace", requiresAcceptance: true, createdAt: new Date(), updatedAt: new Date() },
    ];
    setupSelectQueue([[{ id: DOC_ID }], stored]);

    const res = await request(app)
      .get(`/superadmin/content/documents/${DOC_ID}/module-gates`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.gates)).toBe(true);
    expect(res.body.gates[0]?.moduleKey).toBe("marketplace");
  });

  it("TC-SA-G02: returns 404 when document does not exist", async () => {
    setupSelectQueue([[]]);
    const res = await request(app)
      .get(`/superadmin/content/documents/${DOC_ID}/module-gates`);
    expect(res.status).toBe(404);
  });
});

describe("SA PUT /superadmin/content/documents/:id/module-gates", () => {
  let app: ReturnType<typeof express>;
  beforeEach(async () => { app = await makeSAApp(); vi.clearAllMocks(); });

  it("TC-SA-G03: atomically replaces module gates", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([{ id: DOC_ID, status: "draft" }])),
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/module-gates`)
      .send({ gates: SAMPLE_GATES });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.gateCount).toBe(2);
  });

  it("TC-SA-G04: clears gates when empty array sent", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([{ id: DOC_ID, status: "draft" }])),
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/module-gates`)
      .send({ gates: [] });
    expect(res.status).toBe(200);
    expect(res.body.gateCount).toBe(0);
  });

  it("TC-SA-G05: returns 404 when document does not exist", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([])),   // zero rows → doc not found
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/module-gates`)
      .send({ gates: SAMPLE_GATES });
    expect(res.status).toBe(404);
  });

  it("TC-SA-G06: rejects invalid module key", async () => {
    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/module-gates`)
      .send({ gates: [{ moduleKey: "invalid_module", requiresAcceptance: true }] });
    expect(res.status).toBe(400);
  });

  it("TC-SA-G07: returns 409 DOCUMENT_NOT_DRAFT when document is published", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([{ id: DOC_ID, status: "published" }])),
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/module-gates`)
      .send({ gates: SAMPLE_GATES });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DOCUMENT_NOT_DRAFT");
  });

  it("TC-SA-G08: returns 409 DOCUMENT_NOT_DRAFT when document is archived", async () => {
    mockDbTransaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        select: vi.fn(() => makeSelectChain([{ id: DOC_ID, status: "archived" }])),
        delete: vi.fn(() => makeDeleteChain()),
        insert: vi.fn(() => makeInsertChain([])),
      };
      return cb(tx);
    });

    const res = await request(app)
      .put(`/superadmin/content/documents/${DOC_ID}/module-gates`)
      .send({ gates: SAMPLE_GATES });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DOCUMENT_NOT_DRAFT");
  });
});

// ── Portal: Acceptance Status ─────────────────────────────────────────────────

describe("Portal GET /companies/:companyId/legal/acceptance-status", () => {
  let app: ReturnType<typeof express>;
  beforeEach(async () => { app = await makePortalApp(); vi.clearAllMocks(); });

  it("TC-PORT-A01: returns empty status when no modules requested", async () => {
    const res = await request(app)
      .get(`/companies/${COMPANY_A}/legal/acceptance-status`);
    expect(res.status).toBe(200);
    expect(res.body.status).toEqual([]);
  });

  it("TC-PORT-A02: returns accepted=false when gate exists but user hasn't accepted", async () => {
    // 1: gates join → 1 gate row; 2: acceptances → none
    setupSelectQueue([
      [{ moduleKey: "marketplace", requiresAcceptance: true, documentId: DOC_ID, documentType: "terms_and_conditions", version: "1.0" }],
      [],
    ]);

    // Use ?modules=marketplace (plain string) — qs parses a single value as a string,
    // route handles both string and array for req.query.modules
    const res = await request(app)
      .get(`/companies/${COMPANY_A}/legal/acceptance-status?modules=marketplace`);
    expect(res.status).toBe(200);
    expect(res.body.status[0].accepted).toBe(false);
    expect(res.body.status[0].module).toBe("marketplace");
  });

  it("TC-PORT-A03: returns accepted=true when user has accepted the document", async () => {
    const acceptedAt = new Date("2026-01-15T10:00:00Z");
    setupSelectQueue([
      [{ moduleKey: "marketplace", requiresAcceptance: true, documentId: DOC_ID, documentType: "terms_and_conditions", version: "1.0" }],
      [{ legalDocumentId: DOC_ID, acceptedAt }],
    ]);

    const res = await request(app)
      .get(`/companies/${COMPANY_A}/legal/acceptance-status?modules=marketplace`);
    expect(res.status).toBe(200);
    expect(res.body.status[0].accepted).toBe(true);
    expect(res.body.status[0].acceptedAt).toBeDefined();
  });

  it("TC-PORT-A04: modules with no gate are implicitly accepted", async () => {
    setupSelectQueue([[]]); // no gates for 'reviews'

    const res = await request(app)
      .get(`/companies/${COMPANY_A}/legal/acceptance-status?modules=reviews`);
    expect(res.status).toBe(200);
    expect(res.body.status[0].accepted).toBe(true);
    expect(res.body.status[0].requiresAcceptance).toBe(false);
  });

  it("TC-PORT-A07: gate with requiresAcceptance=false is always accepted without a record", async () => {
    // Gate exists but requiresAcceptance=false → no acceptances query needed
    setupSelectQueue([
      [{ moduleKey: "rfq", requiresAcceptance: false, documentId: DOC_ID, documentType: "terms_and_conditions", version: "1.0" }],
      // No second DB call — documentIdsNeedingCheck is empty
    ]);

    const res = await request(app)
      .get(`/companies/${COMPANY_A}/legal/acceptance-status?modules=rfq`);
    expect(res.status).toBe(200);
    expect(res.body.status[0].accepted).toBe(true);
    expect(res.body.status[0].requiresAcceptance).toBe(false);
  });

  it("TC-PORT-A05: 403 when companyId does not match token", async () => {
    const OTHER = "99999999-9999-9999-9999-999999999999";
    const res = await request(app)
      .get(`/companies/${OTHER}/legal/acceptance-status?modules[]=marketplace`);
    expect(res.status).toBe(403);
  });

  it("TC-PORT-A06: 401 when no auth", async () => {
    const { default: legalAcceptanceRouter } = await import("../routes/legal-acceptance.js");
    const unauthApp = express();
    unauthApp.use(express.json());
    unauthApp.use("/companies/:companyId/legal", legalAcceptanceRouter);
    const res = await request(unauthApp)
      .get(`/companies/${COMPANY_A}/legal/acceptance-status?modules[]=marketplace`);
    expect(res.status).toBe(401);
  });
});

// ── Portal: Accept document ───────────────────────────────────────────────────

describe("Portal POST /companies/:companyId/legal/accept", () => {
  let app: ReturnType<typeof express>;
  beforeEach(async () => { app = await makePortalApp(); vi.clearAllMocks(); });

  it("TC-PORT-B01: records acceptance and returns 201 for first acceptance", async () => {
    const acceptedAt = new Date("2026-08-23T09:00:00Z");
    // Flow: 1. find doc  2. INSERT ON CONFLICT DO NOTHING → returns [row] (success)
    setupSelectQueue([
      [{ id: DOC_ID, documentType: "terms_and_conditions", version: "1.0", status: "published" }],
    ]);
    mockDbInsert.mockReturnValue(makeInsertChain([{ id: "acc-uuid", acceptedAt }]));

    const res = await request(app)
      .post(`/companies/${COMPANY_A}/legal/accept`)
      .send({ documentId: DOC_ID });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.alreadyAccepted).toBe(false);
    expect(res.body.acceptedAt).toBeDefined();
  });

  it("TC-PORT-B02: idempotent — returns 200 with alreadyAccepted=true on second call", async () => {
    const acceptedAt = new Date("2026-07-01T08:00:00Z");
    // Flow: 1. find doc  2. INSERT ON CONFLICT DO NOTHING → [] (conflict, no rows)
    //       3. SELECT existing record to return acceptedAt
    setupSelectQueue([
      [{ id: DOC_ID, documentType: "terms_and_conditions", version: "1.0", status: "published" }],
      [{ id: "acc-uuid", acceptedAt }], // existing acceptance fetched after conflict
    ]);
    mockDbInsert.mockReturnValue(makeInsertChain([])); // conflict → nothing returned

    const res = await request(app)
      .post(`/companies/${COMPANY_A}/legal/accept`)
      .send({ documentId: DOC_ID });
    expect(res.status).toBe(200);
    expect(res.body.alreadyAccepted).toBe(true);
    expect(res.body.acceptedAt).toBeDefined();
    expect(mockDbInsert).toHaveBeenCalled(); // INSERT was attempted, just conflicted
  });

  it("TC-PORT-B03: returns 404 when document does not exist", async () => {
    setupSelectQueue([[]]);
    const res = await request(app)
      .post(`/companies/${COMPANY_A}/legal/accept`)
      .send({ documentId: DOC_ID });
    expect(res.status).toBe(404);
  });

  it("TC-PORT-B04: returns 409 when document is not published", async () => {
    setupSelectQueue([
      [{ id: DOC_ID, documentType: "terms_and_conditions", version: "1.0", status: "draft" }],
    ]);
    const res = await request(app)
      .post(`/companies/${COMPANY_A}/legal/accept`)
      .send({ documentId: DOC_ID });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DOCUMENT_NOT_PUBLISHED");
  });

  it("TC-PORT-B05: returns 400 when documentId is missing", async () => {
    const res = await request(app)
      .post(`/companies/${COMPANY_A}/legal/accept`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("TC-PORT-B06: returns 400 when documentId is not a UUID", async () => {
    const res = await request(app)
      .post(`/companies/${COMPANY_A}/legal/accept`)
      .send({ documentId: "not-a-uuid" });
    expect(res.status).toBe(400);
  });
});

// ── Public: GET /content/legal/:type/sections ─────────────────────────────────

describe("Public GET /content/legal/:type/sections", () => {
  let app: ReturnType<typeof express>;
  beforeEach(async () => { app = await makePublicApp(); vi.clearAllMocks(); });

  it("TC-PUB-S01: returns sections for published terms_and_conditions in English", async () => {
    const sectionRow = {
      id: "sec-1", legalDocumentId: DOC_ID,
      sectionKey: "ratification_of_agreement", displayOrder: 0,
      titleEn: "Ratification", titleAr: "المصادقة", titleKu: "پاڵپشتی",
      contentEn: "By using this...", contentAr: "باستخدام...", contentKu: "بەکارهێنانی...",
      createdAt: new Date(), updatedAt: new Date(),
    };
    setupSelectQueue([
      [{ id: DOC_ID, documentType: "terms_and_conditions", version: "1.0" }],
      [sectionRow],
    ]);

    const res = await request(app)
      .get("/content/legal/terms_and_conditions/sections?lang=en");
    expect(res.status).toBe(200);
    expect(res.body.sections[0].title).toBe("Ratification");
    expect(res.body.sections[0].content).toBe("By using this...");
  });

  it("TC-PUB-S02: returns Arabic title/content when lang=ar", async () => {
    const sectionRow = {
      id: "sec-1", legalDocumentId: DOC_ID,
      sectionKey: "ratification_of_agreement", displayOrder: 0,
      titleEn: "Ratification", titleAr: "المصادقة", titleKu: "پاڵپشتی",
      contentEn: "EN content", contentAr: "محتوى عربي", contentKu: "KU content",
      createdAt: new Date(), updatedAt: new Date(),
    };
    setupSelectQueue([
      [{ id: DOC_ID, documentType: "terms_and_conditions", version: "1.0" }],
      [sectionRow],
    ]);

    const res = await request(app)
      .get("/content/legal/terms_and_conditions/sections?lang=ar");
    expect(res.status).toBe(200);
    expect(res.body.sections[0].title).toBe("المصادقة");
    expect(res.body.sections[0].content).toBe("محتوى عربي");
  });

  it("TC-PUB-S03: returns 404 when no published document exists", async () => {
    setupSelectQueue([[]]);
    const res = await request(app)
      .get("/content/legal/terms_and_conditions/sections");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("LEGAL_CONTENT_NOT_PUBLISHED");
  });

  it("TC-PUB-S04: returns 404 for unknown document type", async () => {
    const res = await request(app)
      .get("/content/legal/invalid_type/sections");
    expect(res.status).toBe(404);
  });

  it("TC-PUB-S05: returns empty sections array when document has no sections yet", async () => {
    setupSelectQueue([
      [{ id: DOC_ID, documentType: "terms_and_conditions", version: "1.0" }],
      [],
    ]);
    const res = await request(app)
      .get("/content/legal/terms_and_conditions/sections");
    expect(res.status).toBe(200);
    expect(res.body.sections).toEqual([]);
  });

  it("TC-PUB-S06: rejects unsupported language instead of defaulting to English", async () => {
    const res = await request(app)
      .get("/content/legal/terms_and_conditions/sections?lang=fr");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("UNSUPPORTED_LANGUAGE");
  });
});
