import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { mockDbSelect, mockDbInsert, mockDbUpdate, mockDbDelete, whereArgs } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbDelete: vi.fn(),
  whereArgs: [] as unknown[],
}));

vi.mock("../lib/db.js", () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
    delete: mockDbDelete,
    transaction: vi.fn(),
  },
}));
vi.mock("../middlewares/auth.middleware.js", () => ({
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
  requireSAPermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../lib/logger.js", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock("../lib/audit.js", () => ({ writeAuditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/notifications.js", () => ({ dispatchLegalAcceptanceNotifications: vi.fn() }));

function chain<T>(result: T) {
  const node: Record<string, any> = {};
  const self = () => node;
  for (const method of ["from", "orderBy", "limit", "values", "set", "returning"]) node[method] = self;
  node.where = (value: unknown) => {
    whereArgs.push(value);
    return node;
  };
  node.then = (resolve: (value: T) => unknown) => Promise.resolve(result).then(resolve);
  return node;
}

function containsToken(value: unknown, token: string, seen = new Set<object>()): boolean {
  if (typeof value === "string") return value.includes(token);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => containsToken(child, token, seen));
}

const ARTICLE = {
  id: "11111111-1111-1111-1111-111111111111",
  category: "account",
  titleEn: "Question",
  titleAr: "سؤال",
  titleKu: "پرسیار",
  contentEn: "Answer",
  contentAr: "وەڵام",
  contentKu: "وەڵام",
  actorScope: "shared",
  status: "published",
  sortOrder: 1,
  publishedAt: new Date("2026-01-01T00:00:00Z"),
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

async function apps() {
  const [{ default: saRouter }, { default: publicRouter }] = await Promise.all([
    import("../routes/superadmin-content.js"),
    import("../routes/content-legal.js"),
  ]);
  const sa = express();
  sa.use(express.json());
  sa.use("/superadmin", saRouter);
  const pub = express();
  pub.use(express.json());
  pub.use("/content", publicRouter);
  return { sa, pub };
}

describe("centralized FAQ content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    whereArgs.length = 0;
    mockDbSelect.mockReturnValue(chain([ARTICLE]));
    mockDbInsert.mockReturnValue(chain([ARTICLE]));
    mockDbUpdate.mockReturnValue(chain([ARTICLE]));
    mockDbDelete.mockReturnValue(chain([{ id: ARTICLE.id }]));
  });

  it("returns only the localized published FAQ shape and falls back explicitly", async () => {
    const { pub } = await apps();
    const response = await request(pub).get("/content/faqs?lang=ar");
    expect(response.status).toBe(200);
    expect(response.body.faqs[0]).toMatchObject({
      title: "سؤال",
      content: "وەڵام",
      language: "ar",
      requestedLanguage: "ar",
      fallbackLanguage: null,
    });
    expect(response.body.faqs[0].actorScope).toBeUndefined();
  });

  it("uses English when the requested translation is unavailable", async () => {
    mockDbSelect.mockReturnValue(chain([{ ...ARTICLE, titleAr: "", contentAr: "" }]));
    const { pub } = await apps();
    const response = await request(pub).get("/content/faqs?lang=ar");
    expect(response.status).toBe(200);
    expect(response.body.faqs[0]).toMatchObject({
      title: "Question",
      content: "Answer",
      language: "en",
      fallbackLanguage: "en",
    });
  });

  it("rejects unsupported public languages instead of silently defaulting", async () => {
    const { pub } = await apps();
    await request(pub).get("/content/faqs?lang=fr").expect(400);
  });

  it("qualifies every SA FAQ read and mutation with the shared scope", async () => {
    const { sa } = await apps();
    await request(sa).get("/superadmin/content/help/articles").expect(200);
    await request(sa).get(`/superadmin/content/help/articles/${ARTICLE.id}`).expect(200);
    await request(sa).patch(`/superadmin/content/help/articles/${ARTICLE.id}`).send({ sortOrder: 2 }).expect(200);
    await request(sa).patch(`/superadmin/content/help/articles/${ARTICLE.id}/publish`).expect(200);
    await request(sa).patch(`/superadmin/content/help/articles/${ARTICLE.id}/unpublish`).expect(200);
    await request(sa).delete(`/superadmin/content/help/articles/${ARTICLE.id}`).expect(200);
    expect(whereArgs.length).toBeGreaterThanOrEqual(6);
    expect(whereArgs.slice(-6).every((where) => containsToken(where, "actor_scope"))).toBe(true);
  });

  it("uses one scope/status-qualified update and does not pre-read stale articles", async () => {
    mockDbUpdate.mockReturnValue(chain([]));
    const { sa } = await apps();
    const response = await request(sa)
      .patch(`/superadmin/content/help/articles/${ARTICLE.id}`)
      .send({ sortOrder: 2 });
    expect(response.status).toBe(409);
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbUpdate).toHaveBeenCalledTimes(1);
  });

  it("publishes, unpublishes, and deletes through mutation returning", async () => {
    const { sa } = await apps();
    await request(sa).patch(`/superadmin/content/help/articles/${ARTICLE.id}/publish`).expect(200);
    await request(sa).patch(`/superadmin/content/help/articles/${ARTICLE.id}/unpublish`).expect(200);
    await request(sa).delete(`/superadmin/content/help/articles/${ARTICLE.id}`).expect(200);
    expect(mockDbUpdate).toHaveBeenCalledTimes(2);
    expect(mockDbDelete).toHaveBeenCalledTimes(1);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});