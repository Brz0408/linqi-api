/**
 * superadmin-perm-denial.test.ts — SA Permission Denial Coverage
 *
 * Verifies that requireSAPermission returns 403 with the correct body
 * for EVERY SA permission module when the authenticated SA lacks the
 * required permission.
 *
 * Pattern per test:
 *   1. SA JWT is valid (requireSuperAdmin passes — no DB call)
 *   2. db.select() for the perm check returns [] (no matching permission row)
 *   3. Route responds 403 with { error: "Insufficient permissions",
 *                                code:  "INSUFFICIENT_SA_PERMISSIONS" }
 *
 * Modules covered (18):
 *   orders · sellers · buyers · rfqs · reviews · team · finance · content ·
 *   advertising · promotions · settings · reports · companies ·
 *   companies/verification-queue · audit · users · products ·
 *   sellers (marketplace-actors path — needs products grant first) ·
 *   returns (superadmin-returns.ts — dedicated mount /superadmin/returns)
 *
 * Why this matters: The happy-path tests use a mocked db.select that
 * returns a perm row, so they cannot catch a misconfigured route that
 * skips requireSAPermission entirely.  These tests verify the DENIAL
 * branch — the path a low-privilege SA would hit.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { signSuperAdminTokens } from "../../lib/auth.js";

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockDbSelect } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
}));

vi.mock("../../lib/audit.js", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/workspace-initializer.js", () => ({
  initializeWorkspaceConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../lib/notifications.js", () => ({
  sendLifecycleEmail:    vi.fn().mockResolvedValue({ sent: false }),
  sendEmailOtp:          vi.fn().mockResolvedValue({ sent: false }),
  sendSmsOtp:            vi.fn().mockResolvedValue({ sent: false }),
  sendOtp:               vi.fn().mockResolvedValue({ sent: false }),
  sendRoleFallbackAlert: vi.fn().mockResolvedValue({ sent: false }),
}));
vi.mock("../../lib/db.js", () => ({
  db: {
    select:      mockDbSelect,
    insert:      vi.fn(),
    update:      vi.fn(),
    delete:      vi.fn(),
    transaction: vi.fn(),
  },
}));
vi.mock("../../lib/fileStorage.js", () => ({
  uploadFile:     vi.fn().mockResolvedValue("https://example.com/file"),
  deleteFile:     vi.fn().mockResolvedValue(undefined),
  getSignedUrl:   vi.fn().mockResolvedValue("https://example.com/signed"),
  getPublicUrl:   vi.fn().mockResolvedValue("https://example.com/public"),
}));
vi.mock("../../lib/marketplace-visibility.js", () => ({
  isProductMarketplaceVisible:       vi.fn().mockResolvedValue(true),
  companyJoinCondition:              vi.fn().mockReturnValue({}),
  sellerProfileJoinCondition:        vi.fn().mockReturnValue({}),
  categoryJoinCondition:             vi.fn().mockReturnValue({}),
  productTypeJoinCondition:          vi.fn().mockReturnValue({}),
  productVisibilityWhereConditions:  vi.fn().mockReturnValue({}),
  MARKETPLACE_ELIGIBLE_COMPANY_STATUSES: ["active", "verified"],
}));

import app from "../../app.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const SA_ID = "sa-perm-test-0000-0000-000000000001";

function saToken(): string {
  return signSuperAdminTokens({ superAdminId: SA_ID }).access;
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${saToken()}` };
}

/**
 * A self-referencing mock chain that resolves to `rows`.
 * Supports all Drizzle query builder methods so the perm middleware's
 * .from().innerJoin().where().limit() chain never throws.
 */
function permChain(rows: unknown[]) {
  const p = Promise.resolve(rows);
  const node: Record<string, unknown> = {};
  const self = () => node;
  ["from", "where", "limit", "offset", "innerJoin", "leftJoin",
   "orderBy", "groupBy", "$dynamic"].forEach((k) => { node[k] = self; });
  node["then"]  = (f: ((v: unknown) => unknown) | null, r?: ((e: unknown) => unknown) | null) =>
    p.then(f, r ?? undefined);
  node["catch"] = (r: ((e: unknown) => unknown) | null) => p.catch(r ?? undefined);
  return node;
}

/** Convenience: queue one perm check that returns empty (denied). */
function denyPerm() {
  mockDbSelect.mockReturnValueOnce(permChain([]));
}

/** Convenience: queue one perm check that returns a row (granted). */
function grantPerm() {
  mockDbSelect.mockReturnValueOnce(permChain([{ id: "perm-granted" }]));
}

const EXPECTED_403 = {
  error: "Insufficient permissions",
  code:  "INSUFFICIENT_SA_PERMISSIONS",
} as const;

// ── Reset before each test ─────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
});

// requireSuperAdmin now queries the DB on every request (status + session_version).
// Queue a "healthy" response before each test; tests that send no/invalid token
// will not consume it (JWT check fails first), and vi.resetAllMocks() clears
// any unconsumed queue entry on the next cycle.
beforeEach(() => {
  mockDbSelect.mockReturnValueOnce(permChain([{ status: "active", sessionVersion: 0 }]));
});

// ══════════════════════════════════════════════════════════════════════════
// Module: orders
// Router: superadmin-orders.ts  — path-specific: router.use('/orders', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: orders", () => {
  it("GET /superadmin/orders → 403 when orders permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/orders")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("GET /superadmin/orders/:id → 403 when orders permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/orders/ord-00000000-0000-0000-0000-000000000001")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: sellers
// Router: superadmin-sellers.ts — path-specific: router.use('/sellers', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: sellers", () => {
  it("GET /superadmin/sellers → 403 when sellers permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/sellers")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("GET /superadmin/sellers/:companyId → 403 when sellers permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/sellers/co-00000000-0000-0000-0000-000000000001")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: buyers
// Router: superadmin-buyers.ts — path-specific: router.use('/buyers', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: buyers", () => {
  it("GET /superadmin/buyers → 403 when buyers permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/buyers")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: rfqs
// Router: superadmin-rfqs.ts — path-specific: router.use('/rfqs', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: rfqs", () => {
  it("GET /superadmin/rfqs → 403 when rfqs permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/rfqs")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: reviews
// Router: superadmin-reviews.ts — path-specific: router.use('/reviews', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: reviews", () => {
  it("GET /superadmin/reviews → 403 when reviews permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/reviews")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: team
// Router: superadmin-team.ts — path-specific: router.use('/team', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: team", () => {
  it("GET /superadmin/team → 403 when team permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/team")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: finance
// Router: superadmin-finance.ts — path-specific: router.use('/finance', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: finance", () => {
  it("GET /superadmin/finance/summary → 403 when finance permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/finance/summary")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("GET /superadmin/finance/commissions → 403 when finance permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/finance/commissions")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("GET /superadmin/finance/export → 403 when finance permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/finance/export?report=ledger")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: content
// Router: superadmin-content.ts — path-specific: router.use('/content', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: content", () => {
  it("GET /superadmin/content/documents → 403 when content permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/content/documents")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("GET /superadmin/content/help/articles → 403 when content permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/content/help/articles")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: advertising
// Router: superadmin-campaigns.ts — path-specific: router.use('/campaigns', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: advertising", () => {
  it("GET /superadmin/campaigns → 403 when advertising permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/campaigns")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: promotions
// Router: saPromotionsRouter — dedicated mount at /superadmin/promotions
//         global router.use(requireSAPermission('promotions'))
// ══════════════════════════════════════════════════════════════════════════

describe("module: promotions", () => {
  it("GET /superadmin/promotions → 403 when promotions permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/promotions")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: settings
// Router: superadmin-settings.ts — path-specific: router.use('/settings', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: settings", () => {
  it("GET /superadmin/settings → 403 when settings permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/settings")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: reports
// Router: superadmin-reports.ts — path-specific: router.use('/reports', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: reports", () => {
  it("GET /superadmin/reports/overview → 403 when reports permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/reports/overview")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: companies
// Router A: superadmin.ts — regex /^\/companies(\/|$)/ perm
// Router B: superadmin-lifecycle.ts — path-specific /companies AND
//           /verification-queue perms
//
// superadmin.ts is mounted first (line 103), lifecycle second (line 109).
// For /companies: superadmin.ts perm fires and denies before lifecycle.
// For /verification-queue: superadmin.ts has no perm for that path, so
//   the request reaches lifecycle's /verification-queue perm.
// ══════════════════════════════════════════════════════════════════════════

describe("module: companies", () => {
  it("GET /superadmin/companies → 403 when companies permission is missing (superadmin.ts path)", async () => {
    denyPerm(); // superadmin.ts /companies perm fires first
    const res = await request(app)
      .get("/api/superadmin/companies")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("GET /superadmin/verification-queue → 403 when companies permission is missing (lifecycle path)", async () => {
    denyPerm(); // superadmin-lifecycle.ts /verification-queue perm
    const res = await request(app)
      .get("/api/superadmin/verification-queue")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: users
// Router: superadmin.ts — regex /^\/users(\/|$)/ perm (action: 'view')
// Only write routes exist under /users; use PATCH /users/:id/suspend.
// ══════════════════════════════════════════════════════════════════════════

describe("module: users", () => {
  // The only write route under /users is PATCH /users/:userId/suspend.
  // To avoid mock conflicts with db.update inside the route handler, we use
  // GET on a /users/* path (no GET handler exists, but router.use() fires
  // the perm check regardless of HTTP method BEFORE any route is matched).
  it("GET /superadmin/users/:userId → 403 when users permission is missing", async () => {
    denyPerm(); // superadmin.ts regex /^\/users(\/|$)/ perm fires first
    const res = await request(app)
      .get("/api/superadmin/users/u-00000000-0000-0000-0000-000000000001")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: audit
// Router: superadmin.ts — path-specific: router.use('/audit-logs', ...)
// ══════════════════════════════════════════════════════════════════════════

describe("module: audit", () => {
  it("GET /superadmin/audit-logs → 403 when audit permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/audit-logs")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: products
// Router: superadmin-marketplace.ts — global requireSAPermission('products')
//         mounted at /superadmin/marketplace
//
// For any /marketplace/* route, superadmin-marketplace.ts enters first.
// Its global perm fires immediately.
// ══════════════════════════════════════════════════════════════════════════

describe("module: products (marketplace)", () => {
  it("GET /superadmin/marketplace/categories → 403 when products permission is missing", async () => {
    denyPerm(); // superadmin-marketplace.ts global perm fires first
    const res = await request(app)
      .get("/api/superadmin/marketplace/categories")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("GET /superadmin/marketplace/attributes → 403 when products permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/marketplace/attributes")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: sellers (marketplace-actors path)
// Router: superadmin-marketplace-actors.ts — global requireSAPermission('sellers')
//         mounted at /superadmin/marketplace (same prefix as marketplace.ts)
//
// Request order:
//   1. superadmin-marketplace.ts enters → requireSAPermission('products') fires
//      → must be GRANTED (return a row) for the request to reach actors router
//   2. No route in marketplace.ts matches /profiles → next()
//   3. superadmin-marketplace-actors.ts enters → requireSAPermission('sellers') fires
//      → return [] → 403
//
// This test verifies that the actors router's perm guard is independently
// enforced even when the products perm is satisfied.
// ══════════════════════════════════════════════════════════════════════════

describe("module: sellers (marketplace-actors path)", () => {
  it("GET /superadmin/marketplace/profiles → 403 when sellers permission is missing (products granted)", async () => {
    grantPerm(); // superadmin-marketplace.ts 'products' perm → granted
    denyPerm();  // superadmin-marketplace-actors.ts 'sellers' perm → denied
    const res = await request(app)
      .get("/api/superadmin/marketplace/profiles")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("GET /superadmin/marketplace/profiles/:id → 403 when sellers permission is missing (products granted)", async () => {
    grantPerm(); // 'products' → granted
    denyPerm();  // 'sellers' → denied
    const res = await request(app)
      .get("/api/superadmin/marketplace/profiles/co-00000000-0000-0000-0000-000000000001")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Module: returns
// Router: superadmin-returns.ts — dedicated mount at /superadmin/returns
//         global router.use(requireSAPermission('returns'))
// Routes: GET / · GET /:id · PATCH /:id/status · POST /:id/messages · etc.
// ══════════════════════════════════════════════════════════════════════════

describe("module: returns", () => {
  it("GET /superadmin/returns → 403 when returns permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/returns")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("GET /superadmin/returns/:id → 403 when returns permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .get("/api/superadmin/returns/ret-00000000-0000-0000-0000-000000000001")
      .set(authHeader());
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });

  it("PATCH /superadmin/returns/:id/status → 403 when returns permission is missing", async () => {
    denyPerm();
    const res = await request(app)
      .patch("/api/superadmin/returns/ret-00000000-0000-0000-0000-000000000001/status")
      .set(authHeader())
      .send({ status: "under_review" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject(EXPECTED_403);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Cross-cutting: SA token required in all cases
// A denied SA perm is distinct from a missing/invalid token (401).
// ══════════════════════════════════════════════════════════════════════════

describe("cross-cutting: 401 vs 403 distinction", () => {
  it("returns 401 (not 403) when no token is provided to a perm-guarded route", async () => {
    // No mockDbSelect setup — the request must short-circuit at requireSuperAdmin
    const res = await request(app).get("/api/superadmin/orders");
    expect(res.status).toBe(401);
    // db.select should never have been called (JWT check happens before perm check)
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("returns 401 (not 403) when an invalid token is provided", async () => {
    const res = await request(app)
      .get("/api/superadmin/orders")
      .set("Authorization", "Bearer not-a-valid-jwt");
    expect(res.status).toBe(401);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
