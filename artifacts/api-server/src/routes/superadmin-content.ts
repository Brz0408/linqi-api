/**
 * Super Admin Content Management
 *
 * Routes (all require requireSuperAdmin):
 *
 * Legal Documents:
 *   GET    /superadmin/content/documents          — list
 *   POST   /superadmin/content/documents          — create
 *   GET    /superadmin/content/documents/:id      — get one
 *   PATCH  /superadmin/content/documents/:id      — update
 *   PATCH  /superadmin/content/documents/:id/publish — publish (sets status=published)
 *   PATCH  /superadmin/content/documents/:id/archive — archive
 *
 * Promotional Banners:
 *   GET    /superadmin/content/banners            — list
 *   POST   /superadmin/content/banners            — create
 *   PATCH  /superadmin/content/banners/:id        — update
 *   DELETE /superadmin/content/banners/:id        — delete (only draft)
 *
 * Featured Listings:
 *   GET    /superadmin/content/featured           — list
 *   POST   /superadmin/content/featured           — create
 *   PATCH  /superadmin/content/featured/:id       — update status/priority
 *   DELETE /superadmin/content/featured/:id       — remove
 */

import { Router } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import {
  legalDocumentsTable, promotionalBannersTable, featuredListingsTable,
  companiesTable, productsTable, companyMarketplaceProfilesTable,
  legalDocSectionsTable, legalDocModuleGatesTable, auditLogsTable,
  legalDocumentAcceptancesTable, helpArticlesTable,
} from "@workspace/db";
import { requireSuperAdmin, requireSAPermission } from "../middlewares/auth.middleware.js";
import { writeAuditLog } from "../lib/audit.js";
import { dispatchLegalAcceptanceNotifications } from "../lib/notifications.js";
import { logger } from "../lib/logger.js";
import { eq, desc, ilike, or, asc, and, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  platformPopularProductsTable, platformNewArrivalsTable,
  platformDealBannersTable, platformDealProductsTable, platformDealCouponsTable,
  productMediaTable, productPricesTable,
} from "@workspace/db";

const router = Router();
router.use(requireSuperAdmin);
router.use('/content', requireSAPermission('content'));

function hasDatabaseErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === code) return true;
    current = candidate.cause;
  }
  return false;
}

function lifecycleError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * All legal lifecycle mutations use the same global lock order:
 *   1. target document advisory lock (stable even while its type changes);
 *   2. read the current type without a row lock;
 *   3. affected type advisory lock(s), in lexical order;
 *   4. target row FOR UPDATE, verify the pre-lock snapshot, then CAS.
 *
 * In particular, no operation takes a target row lock before its type lock.
 * That prevents publish(D)/type(T) from waiting on archive(P)'s row while
 * archive(P) waits on T.
 */
async function lockLegalDocumentId(tx: any, documentId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('legal_doc_id:' || ${documentId}))`,
  );
}

async function lockLegalDocumentTypes(tx: any, documentTypes: string[]): Promise<void> {
  const uniqueTypes = [...new Set(documentTypes)].sort((a, b) => a.localeCompare(b));
  for (const documentType of uniqueTypes) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('legal_doc_type:' || ${documentType}))`,
    );
  }
}

// ── Legal Documents ───────────────────────────────────────────────────────────

router.get("/content/documents", async (req, res) => {
  try {
    const typeFilter   = req.query["type"]   as string | undefined;
    const statusFilter = req.query["status"] as string | undefined;
    let rows = await db
      .select()
      .from(legalDocumentsTable)
      .orderBy(desc(legalDocumentsTable.createdAt));
    if (typeFilter)   rows = rows.filter((r) => r.documentType === typeFilter);
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    return res.json({ documents: rows });
  } catch (err) {
    logger.error({ err }, "SA list documents failed");
    return res.status(500).json({ error: "Failed to list documents" });
  }
});

const documentSchema = z.object({
  documentType: z.enum([
    "terms_and_conditions","privacy_policy","seller_agreement","buyer_terms",
    "marketplace_terms","commission_agreement","advertising_agreement",
    "return_policy","payment_terms","about_linqi","other",
  ]),
  titleEn:   z.string().min(1).max(500),
  titleAr:   z.string().min(1).max(500),
  titleKu:   z.string().min(1).max(500),
  version:   z.string().min(1).max(50),
  contentEn: z.string().default(""),
  contentAr: z.string().default(""),
  contentKu: z.string().default(""),
  effectiveAt: z.string().datetime().optional(),
});

router.post("/content/documents", async (req, res) => {
  const parsed = documentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    const [doc] = await db.insert(legalDocumentsTable).values({
      ...parsed.data,
      effectiveAt:     parsed.data.effectiveAt ? new Date(parsed.data.effectiveAt) : null,
      status:          "draft",
      createdBySaId:   sa.superAdminId,
      updatedBySaId:   sa.superAdminId,
    }).returning();
    return res.status(201).json({ document: doc });
  } catch (err) {
    logger.error({ err }, "SA create document failed");
    return res.status(500).json({ error: "Failed to create document" });
  }
});

router.get("/content/documents/:id", async (req, res) => {
  try {
    const [doc] = await db.select().from(legalDocumentsTable).where(eq(legalDocumentsTable.id, String(req.params["id"]))).limit(1);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    return res.json({ document: doc });
  } catch (err) {
    logger.error({ err }, "SA get document failed");
    return res.status(500).json({ error: "Failed to get document" });
  }
});

// Notification summary for a legal document.
// Queries in parallel:
//   (1) most recent acceptance-notification dispatch audit log entry
//   (2) module-gates table to detect whether acceptance is required at all
//   (3) live count of users who have accepted this document version
// Returns { notificationSummary: { dispatched, errors, sentAt, hasAcceptanceGates, accepted } }.
router.get("/content/documents/:id/notification-summary", async (req, res) => {
  try {
    const id = String(req.params["id"]);

    const [notifRows, gateRows, acceptanceRows] = await Promise.all([
      db
        .select({ createdAt: auditLogsTable.createdAt, metadata: auditLogsTable.metadata })
        .from(auditLogsTable)
        .where(
          and(
            eq(auditLogsTable.action, "superadmin.legal_document_acceptance_notifications_sent"),
            eq(auditLogsTable.targetId, id),
          ),
        )
        .orderBy(desc(auditLogsTable.createdAt))
        .limit(1),
      db
        .select({ id: legalDocModuleGatesTable.id })
        .from(legalDocModuleGatesTable)
        .where(
          and(
            eq(legalDocModuleGatesTable.legalDocumentId, id),
            eq(legalDocModuleGatesTable.requiresAcceptance, true),
          ),
        )
        .limit(1),
      // Live acceptance count — this is version-specific so it reflects the exact
      // document ID and stays accurate if the SA publishes a corrected version.
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(legalDocumentAcceptancesTable)
        .where(eq(legalDocumentAcceptancesTable.legalDocumentId, id)),
    ]);

    const notifLog           = notifRows[0];
    const hasAcceptanceGates = gateRows.length > 0;
    const meta               = notifLog?.metadata as { dispatched?: number; errors?: number } | undefined;
    const accepted           = acceptanceRows[0]?.count ?? 0;

    return res.json({
      notificationSummary: {
        dispatched:          meta?.dispatched ?? 0,
        errors:              meta?.errors     ?? 0,
        sentAt:              notifLog?.createdAt ?? null,
        hasAcceptanceGates,
        accepted,
      },
    });
  } catch (err) {
    logger.error({ err }, "SA get document notification summary failed");
    return res.status(500).json({ error: "Failed to get notification summary" });
  }
});

router.patch("/content/documents/:id", async (req, res) => {
  const id     = String(req.params["id"]);
  const parsed = documentSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    const doc = await db.transaction(async (tx) => {
      await lockLegalDocumentId(tx, id);
      const [snapshot] = await tx
        .select({ id: legalDocumentsTable.id, documentType: legalDocumentsTable.documentType, status: legalDocumentsTable.status })
        .from(legalDocumentsTable)
        .where(eq(legalDocumentsTable.id, id))
        .limit(1);
      if (!snapshot) throw lifecycleError("DOCUMENT_NOT_FOUND", "Document not found");

      const nextType = parsed.data.documentType ?? snapshot.documentType;
      await lockLegalDocumentTypes(tx, [snapshot.documentType, nextType]);

      const [authoritative] = await tx
        .select({ id: legalDocumentsTable.id, documentType: legalDocumentsTable.documentType, status: legalDocumentsTable.status })
        .from(legalDocumentsTable)
        .where(eq(legalDocumentsTable.id, id))
        .limit(1)
        .for("update");
      if (
        !authoritative ||
        authoritative.documentType !== snapshot.documentType ||
        authoritative.status !== snapshot.status
      ) {
        throw lifecycleError("LEGAL_LIFECYCLE_CONFLICT", "Document changed while it was being edited");
      }
      if (authoritative.status !== "draft") {
        throw lifecycleError("DOCUMENT_NOT_DRAFT", "Only draft documents may be edited");
      }

      const [updated] = await tx.update(legalDocumentsTable)
        .set({
          ...parsed.data,
          effectiveAt: parsed.data.effectiveAt ? new Date(parsed.data.effectiveAt) : undefined,
          updatedBySaId: sa.superAdminId,
          updatedAt: new Date(),
        })
        .where(and(
          eq(legalDocumentsTable.id, id),
          eq(legalDocumentsTable.documentType, snapshot.documentType),
          eq(legalDocumentsTable.status, "draft"),
        ))
        .returning();
      if (!updated) throw lifecycleError("LEGAL_LIFECYCLE_CONFLICT", "Document changed while it was being edited");
      return updated;
    });
    return res.json({ document: doc });
  } catch (err) {
    if (err instanceof Error && (err as any).code === "DOCUMENT_NOT_FOUND") {
      return res.status(404).json({ error: "Document not found" });
    }
    if (err instanceof Error && (err as any).code === "DOCUMENT_NOT_DRAFT") {
      return res.status(409).json({ error: "Only draft documents may be edited", code: "DOCUMENT_NOT_DRAFT" });
    }
    if (err instanceof Error && (err as any).code === "LEGAL_LIFECYCLE_CONFLICT") {
      return res.status(409).json({ error: err.message, code: "LEGAL_LIFECYCLE_CONFLICT" });
    }
    logger.error({ err }, "SA update document failed");
    return res.status(500).json({ error: "Failed to update document" });
  }
});

router.patch("/content/documents/:id/publish", async (req, res) => {
  const id = String(req.params["id"]);
  const sa = (req as any).superAdmin!;
  try {
    const now = new Date();
    const publishedDoc = await db.transaction(async (tx) => {
      // Serialize this document before reading its mutable type.
      await lockLegalDocumentId(tx, id);
      const [snapshot] = await tx
        .select({ id: legalDocumentsTable.id, documentType: legalDocumentsTable.documentType, status: legalDocumentsTable.status })
        .from(legalDocumentsTable)
        .where(eq(legalDocumentsTable.id, id))
        .limit(1);
      if (!snapshot) throw lifecycleError("DOCUMENT_NOT_FOUND", "Document not found");
      await lockLegalDocumentTypes(tx, [snapshot.documentType]);

      const [target] = await tx
        .select()
        .from(legalDocumentsTable)
        .where(eq(legalDocumentsTable.id, id))
        .limit(1)
        .for("update");
      if (!target) throw lifecycleError("DOCUMENT_NOT_FOUND", "Document not found");
      if (target.documentType !== snapshot.documentType || target.status !== snapshot.status) {
        throw lifecycleError("LEGAL_LIFECYCLE_CONFLICT", "Document type changed while it was being published");
      }
      if (target.status !== "draft") throw lifecycleError("DOCUMENT_NOT_DRAFT", "Only draft documents may be published");
       // Scheduled revisions need a dedicated activation workflow. Publishing
       // them now would archive the current effective version and leave the
       // public/legal registration paths without any usable document.
       if (target.effectiveAt && target.effectiveAt > now) {
          throw lifecycleError("DOCUMENT_EFFECTIVE_IN_FUTURE", "A document cannot be published before its effective date");
       }

      // Archive any currently published row of the same type (excluding self)
      await tx
        .update(legalDocumentsTable)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            eq(legalDocumentsTable.documentType, target.documentType),
            eq(legalDocumentsTable.status, "published"),
            ne(legalDocumentsTable.id, id),
          ),
        )
        .returning({ id: legalDocumentsTable.id });

      // Publish the target document
      const [published] = await tx
        .update(legalDocumentsTable)
        .set({ status: "published", publishedAt: now, updatedBySaId: sa.superAdminId, updatedAt: now })
        .where(and(eq(legalDocumentsTable.id, id), eq(legalDocumentsTable.status, "draft")))
        .returning({ id: legalDocumentsTable.id, status: legalDocumentsTable.status, documentType: legalDocumentsTable.documentType });

      return published
        ? {
            outcome:  "published" as const,
            document: published,
            // Carry title/version/effectiveAt out of the transaction for email dispatch
            docInfo: {
              documentId:   target.id,
              documentType: target.documentType,
              titleEn:      target.titleEn,
              titleAr:      target.titleAr,
              titleKu:      target.titleKu,
              version:      target.version,
              effectiveAt:  target.effectiveAt,
            },
          }
        : (() => {
            throw lifecycleError("LEGAL_LIFECYCLE_CONFLICT", "Document changed while it was being published");
          })();
    });

    // Audit after commit
    await writeAuditLog(
      { actorType: "super_admin", actorId: sa.superAdminId, actorDisplayName: "Super Admin" },
      "superadmin.legal_document_published",
      { type: "legal_document", id },
      { documentType: publishedDoc.document.documentType },
      req,
    );

    // Fire-and-forget: notify all users who need to accept this document.
    // The SA response is already sent; failures here never affect the publish outcome.
    const { docInfo } = publishedDoc;
    dispatchLegalAcceptanceNotifications(docInfo)
      .then(async ({ dispatched, errors, skipped }) => {
        if (skipped) return;
        await writeAuditLog(
          { actorType: "super_admin", actorId: sa.superAdminId, actorDisplayName: "Super Admin" },
          "superadmin.legal_document_acceptance_notifications_sent",
          { type: "legal_document", id },
          { documentType: docInfo.documentType, dispatched, errors },
          req,
        );
      })
      .catch((err) => {
        logger.error({ err, documentId: id }, "Legal acceptance notification dispatch failed");
      });

    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && (err as any).code === "DOCUMENT_NOT_FOUND") {
      return res.status(404).json({ error: "Document not found" });
    }
    if (err instanceof Error && (err as any).code === "DOCUMENT_NOT_DRAFT") {
      return res.status(409).json({ error: "Only draft documents may be published", code: "DOCUMENT_NOT_DRAFT" });
    }
    if (err instanceof Error && (err as any).code === "DOCUMENT_EFFECTIVE_IN_FUTURE") {
      return res.status(409).json({ error: err.message, code: "DOCUMENT_EFFECTIVE_IN_FUTURE" });
    }
    if (err instanceof Error && (err as any).code === "LEGAL_LIFECYCLE_CONFLICT") {
      return res.status(409).json({ error: err.message, code: "LEGAL_LIFECYCLE_CONFLICT" });
    }
    logger.error({ err }, "SA publish document failed");
    return res.status(500).json({ error: "Failed to publish document" });
  }
});

router.patch("/content/documents/:id/archive", async (req, res) => {
  const id = String(req.params["id"]);
  const sa = (req as any).superAdmin!;
  try {
    await db.transaction(async (tx) => {
      await lockLegalDocumentId(tx, id);
      const [snapshot] = await tx
        .select({ id: legalDocumentsTable.id, documentType: legalDocumentsTable.documentType, status: legalDocumentsTable.status })
        .from(legalDocumentsTable)
        .where(eq(legalDocumentsTable.id, id))
        .limit(1);
      if (!snapshot) throw lifecycleError("DOCUMENT_NOT_FOUND", "Document not found");
      await lockLegalDocumentTypes(tx, [snapshot.documentType]);

      const [target] = await tx
        .select({ id: legalDocumentsTable.id, documentType: legalDocumentsTable.documentType, status: legalDocumentsTable.status })
        .from(legalDocumentsTable)
        .where(eq(legalDocumentsTable.id, id))
        .limit(1)
        .for("update");
      if (!target) throw lifecycleError("DOCUMENT_NOT_FOUND", "Document not found");
      if (target.documentType !== snapshot.documentType || target.status !== snapshot.status) {
        throw lifecycleError("LEGAL_LIFECYCLE_CONFLICT", "Document type changed while it was being archived");
      }
      if (target.status === "archived") {
        return;
      }

      const [archived] = await tx.update(legalDocumentsTable)
        .set({ status: "archived", updatedBySaId: sa.superAdminId, updatedAt: new Date() })
        .where(and(
          eq(legalDocumentsTable.id, id),
          eq(legalDocumentsTable.documentType, target.documentType),
          inArray(legalDocumentsTable.status, ["draft", "published"]),
        ))
        .returning({ id: legalDocumentsTable.id });
      if (!archived) {
        throw lifecycleError("LEGAL_LIFECYCLE_CONFLICT", "Document changed while it was being archived");
      }
    });
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && (err as any).code === "DOCUMENT_NOT_FOUND") {
      return res.status(404).json({ error: "Document not found" });
    }
    if (err instanceof Error && (err as any).code === "LEGAL_LIFECYCLE_CONFLICT") {
      return res.status(409).json({ error: err.message, code: "LEGAL_LIFECYCLE_CONFLICT" });
    }
    logger.error({ err }, "SA archive document failed");
    return res.status(500).json({ error: "Failed to archive document" });
  }
});

// ── Legal Document Sections ───────────────────────────────────────────────────

const VALID_SECTION_KEYS = [
  "ratification_of_agreement", "description_of_services", "how_to_make_order",
  "order_cancellation", "membership_system", "responsibilities_of_user",
  "visitor_material_and_conduct", "prohibited_activities", "authority_of_linqi",
  "guidelines_for_reviews", "termination_of_agreement", "restrictions_non_personal",
  "product_delivery", "product_return", "payment_methods", "refund_policy",
  "price_and_payment", "validity_of_linqi_records", "governing_law", "linqi_pro",
  "rewards_program", "enforcement", "license", "intellectual_property_rights",
  "contribution_license", "links_to_other_websites", "limitation_of_liability",
  "indemnity", "disclaimer",
] as const;

const sectionItemSchema = z.object({
  sectionKey:   z.enum(VALID_SECTION_KEYS),
  displayOrder: z.number().int().min(0).default(0),
  titleEn:      z.string().max(500).default(""),
  titleAr:      z.string().max(500).default(""),
  titleKu:      z.string().max(500).default(""),
  contentEn:    z.string().default(""),
  contentAr:    z.string().default(""),
  contentKu:    z.string().default(""),
});

const sectionsBodySchema = z.object({
  sections: z.array(sectionItemSchema),
});

router.get("/content/documents/:id/sections", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    const [doc] = await db.select({ id: legalDocumentsTable.id })
      .from(legalDocumentsTable).where(eq(legalDocumentsTable.id, id)).limit(1);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const sections = await db.select().from(legalDocSectionsTable)
      .where(eq(legalDocSectionsTable.legalDocumentId, id))
      .orderBy(legalDocSectionsTable.displayOrder);
    return res.json({ sections });
  } catch (err) {
    logger.error({ err }, "SA get document sections failed");
    return res.status(500).json({ error: "Failed to get sections" });
  }
});

router.put("/content/documents/:id/sections", async (req, res) => {
  const id  = String(req.params["id"]);
  const sa  = (req as any).superAdmin!;
  const parsed = sectionsBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  try {
    await db.transaction(async (tx) => {
      // Verify document exists and is still a draft
      const [doc] = await tx.select({ id: legalDocumentsTable.id, status: legalDocumentsTable.status })
        .from(legalDocumentsTable).where(eq(legalDocumentsTable.id, id)).limit(1);
      if (!doc) throw Object.assign(new Error("not_found"), { code: "NOT_FOUND" });
      if (doc.status !== "draft") throw Object.assign(new Error("not_draft"), { code: "NOT_DRAFT" });

      // Atomic replace: delete all existing sections then insert new set
      await tx.delete(legalDocSectionsTable).where(eq(legalDocSectionsTable.legalDocumentId, id));

      if (parsed.data.sections.length > 0) {
        await tx.insert(legalDocSectionsTable).values(
          parsed.data.sections.map((s) => ({
            ...s,
            legalDocumentId: id,
          })),
        );
      }
    });

    await writeAuditLog(
      { actorType: "super_admin", actorId: sa.superAdminId, actorDisplayName: "Super Admin" },
      "superadmin.legal_document_sections_updated",
      { type: "legal_document", id },
      { sectionCount: parsed.data.sections.length },
      req,
    );
    return res.json({ ok: true, sectionCount: parsed.data.sections.length });
  } catch (err: unknown) {
    if (err instanceof Error && (err as any).code === "NOT_FOUND") {
      return res.status(404).json({ error: "Document not found" });
    }
    if (err instanceof Error && (err as any).code === "NOT_DRAFT") {
      return res.status(409).json({ error: "Sections can only be edited on draft documents", code: "DOCUMENT_NOT_DRAFT" });
    }
    logger.error({ err }, "SA put document sections failed");
    return res.status(500).json({ error: "Failed to update sections" });
  }
});

// ── Legal Document Module Gates ───────────────────────────────────────────────

const VALID_MODULE_KEYS = [
  "marketplace", "orders", "payments", "subscriptions", "seller-tools",
  "procurement", "inventory", "rfq", "returns", "reviews", "academy",
] as const;

const gateItemSchema = z.object({
  moduleKey:          z.enum(VALID_MODULE_KEYS),
  requiresAcceptance: z.boolean().default(true),
});

const gatesBodySchema = z.object({
  gates: z.array(gateItemSchema),
});

router.get("/content/documents/:id/module-gates", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    const [doc] = await db.select({ id: legalDocumentsTable.id })
      .from(legalDocumentsTable).where(eq(legalDocumentsTable.id, id)).limit(1);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const gates = await db.select().from(legalDocModuleGatesTable)
      .where(eq(legalDocModuleGatesTable.legalDocumentId, id));
    return res.json({ gates });
  } catch (err) {
    logger.error({ err }, "SA get document module gates failed");
    return res.status(500).json({ error: "Failed to get module gates" });
  }
});

router.put("/content/documents/:id/module-gates", async (req, res) => {
  const id  = String(req.params["id"]);
  const sa  = (req as any).superAdmin!;
  const parsed = gatesBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });

  try {
    await db.transaction(async (tx) => {
      const [doc] = await tx.select({ id: legalDocumentsTable.id, status: legalDocumentsTable.status })
        .from(legalDocumentsTable).where(eq(legalDocumentsTable.id, id)).limit(1);
      if (!doc) throw Object.assign(new Error("not_found"), { code: "NOT_FOUND" });
      if (doc.status !== "draft") throw Object.assign(new Error("not_draft"), { code: "NOT_DRAFT" });

      await tx.delete(legalDocModuleGatesTable).where(eq(legalDocModuleGatesTable.legalDocumentId, id));

      if (parsed.data.gates.length > 0) {
        await tx.insert(legalDocModuleGatesTable).values(
          parsed.data.gates.map((g) => ({
            ...g,
            legalDocumentId: id,
          })),
        );
      }
    });

    await writeAuditLog(
      { actorType: "super_admin", actorId: sa.superAdminId, actorDisplayName: "Super Admin" },
      "superadmin.legal_document_module_gates_updated",
      { type: "legal_document", id },
      { gateCount: parsed.data.gates.length },
      req,
    );
    return res.json({ ok: true, gateCount: parsed.data.gates.length });
  } catch (err: unknown) {
    if (err instanceof Error && (err as any).code === "NOT_FOUND") {
      return res.status(404).json({ error: "Document not found" });
    }
    if (err instanceof Error && (err as any).code === "NOT_DRAFT") {
      return res.status(409).json({ error: "Module gates can only be edited on draft documents", code: "DOCUMENT_NOT_DRAFT" });
    }
    logger.error({ err }, "SA put document module gates failed");
    return res.status(500).json({ error: "Failed to update module gates" });
  }
});

// ── Help / FAQ Articles ────────────────────────────────────────────────────────
// FAQ management intentionally uses help_articles rather than introducing a
// second content table. Public FAQ readers only expose actorScope=shared.

const faqArticleSchema = z.object({
  category: z.string().trim().min(1).max(100),
  titleEn: z.string().trim().min(1).max(500),
  titleAr: z.string().trim().min(1).max(500),
  titleKu: z.string().trim().min(1).max(500),
  contentEn: z.string().trim().min(1),
  contentAr: z.string().trim().min(1),
  contentKu: z.string().trim().min(1),
  sortOrder: z.number().int().min(0).max(2_147_483_647).default(0),
});
const faqArticleUpdateSchema = faqArticleSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one FAQ field is required" },
);
const faqPublicColumns = {
  id: helpArticlesTable.id,
  category: helpArticlesTable.category,
  titleEn: helpArticlesTable.titleEn,
  titleAr: helpArticlesTable.titleAr,
  titleKu: helpArticlesTable.titleKu,
  contentEn: helpArticlesTable.contentEn,
  contentAr: helpArticlesTable.contentAr,
  contentKu: helpArticlesTable.contentKu,
  status: helpArticlesTable.status,
  sortOrder: helpArticlesTable.sortOrder,
  publishedAt: helpArticlesTable.publishedAt,
  createdAt: helpArticlesTable.createdAt,
  updatedAt: helpArticlesTable.updatedAt,
};

const sharedFaq = eq(helpArticlesTable.actorScope, "shared");

router.get("/content/help/articles", async (req, res) => {
  try {
    const status = req.query["status"];
    const conditions = status === "draft" || status === "published"
      ? [sharedFaq, eq(helpArticlesTable.status, status)]
      : [sharedFaq];
    const articles = await db.select(faqPublicColumns).from(helpArticlesTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(helpArticlesTable.sortOrder), desc(helpArticlesTable.createdAt), asc(helpArticlesTable.id));
    return res.json({ articles });
  } catch (err) {
    logger.error({ err }, "SA list help articles failed");
    return res.status(500).json({ error: "Failed to list FAQ articles" });
  }
});

router.post("/content/help/articles", async (req, res) => {
  const parsed = faqArticleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const [article] = await db.insert(helpArticlesTable).values({
      ...parsed.data, actorScope: "shared", status: "draft", publishedAt: null,
    }).returning(faqPublicColumns);
    return res.status(201).json({ article });
  } catch (err) {
    logger.error({ err }, "SA create help article failed");
    return res.status(500).json({ error: "Failed to create FAQ article" });
  }
});

router.get("/content/help/articles/:id", async (req, res) => {
  try {
    const [article] = await db.select(faqPublicColumns).from(helpArticlesTable)
      .where(and(eq(helpArticlesTable.id, String(req.params["id"])), sharedFaq)).limit(1);
    if (!article) return res.status(404).json({ error: "FAQ article not found" });
    return res.json({ article });
  } catch (err) {
    logger.error({ err }, "SA get help article failed");
    return res.status(500).json({ error: "Failed to get FAQ article" });
  }
});

router.patch("/content/help/articles/:id", async (req, res) => {
  const parsed = faqArticleUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const id = String(req.params["id"]);
  try {
    const [article] = await db.update(helpArticlesTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(helpArticlesTable.id, id), sharedFaq, eq(helpArticlesTable.status, "draft")))
      .returning(faqPublicColumns);
    if (!article) return res.status(409).json({
      error: "FAQ article is missing, not shared, or not a draft",
      code: "FAQ_NOT_DRAFT",
    });
    return res.json({ article });
  } catch (err) {
    logger.error({ err }, "SA update help article failed");
    return res.status(500).json({ error: "Failed to update FAQ article" });
  }
});

router.patch("/content/help/articles/:id/publish", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    const [article] = await db.update(helpArticlesTable)
      .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(helpArticlesTable.id, id), sharedFaq, eq(helpArticlesTable.status, "draft")))
      .returning(faqPublicColumns);
    if (!article) {
      return res.status(409).json({
        error: "FAQ article is missing, not shared, or not a draft",
        code: "FAQ_NOT_DRAFT",
      });
    }
    return res.json({ article });
  } catch (err) {
    logger.error({ err }, "SA publish help article failed");
    return res.status(500).json({ error: "Failed to publish FAQ article" });
  }
});

router.patch("/content/help/articles/:id/unpublish", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    const [article] = await db.update(helpArticlesTable)
      .set({ status: "draft", publishedAt: null, updatedAt: new Date() })
      .where(and(eq(helpArticlesTable.id, id), sharedFaq, eq(helpArticlesTable.status, "published")))
      .returning(faqPublicColumns);
    if (!article) {
      return res.status(409).json({
        error: "FAQ article is missing, not shared, or not published",
        code: "FAQ_NOT_PUBLISHED",
      });
    }
    return res.json({ article });
  } catch (err) {
    logger.error({ err }, "SA unpublish help article failed");
    return res.status(500).json({ error: "Failed to unpublish FAQ article" });
  }
});

router.delete("/content/help/articles/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    const [deleted] = await db.delete(helpArticlesTable)
      .where(and(eq(helpArticlesTable.id, id), sharedFaq, eq(helpArticlesTable.status, "draft")))
      .returning({ id: helpArticlesTable.id });
    if (!deleted) {
      return res.status(409).json({
        error: "FAQ article is missing, not shared, or not a draft",
        code: "FAQ_NOT_DRAFT",
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete help article failed");
    return res.status(500).json({ error: "Failed to delete FAQ article" });
  }
});

// ── Promotional Banners ───────────────────────────────────────────────────────

router.get("/content/banners", async (_req, res) => {
  try {
    const banners = await db.select().from(promotionalBannersTable).orderBy(promotionalBannersTable.priority, desc(promotionalBannersTable.createdAt));
    return res.json({ banners });
  } catch (err) {
    logger.error({ err }, "SA list banners failed");
    return res.status(500).json({ error: "Failed to list banners" });
  }
});

const bannerSchema = z.object({
  titleEn:     z.string().min(1).max(500),
  titleAr:     z.string().min(1).max(500),
  titleKu:     z.string().min(1).max(500),
  subtitleEn:  z.string().max(500).optional(),
  subtitleAr:  z.string().max(500).optional(),
  subtitleKu:  z.string().max(500).optional(),
  ctaTextEn:   z.string().max(200).optional(),
  ctaTextAr:   z.string().max(200).optional(),
  ctaTextKu:   z.string().max(200).optional(),
  imageUrl:    z.string().url().optional(),
  placement:   z.enum(["home_hero","home_secondary","category_header","search_top"]),
  targetType:  z.enum(["product","seller","category","promotion","url","none"]).default("none"),
  targetId:    z.string().uuid().optional(),
  targetUrl:   z.string().url().optional(),
  status:      z.enum(["draft","active","inactive","expired"]).optional(),
  platform:    z.enum(["mobile","web","all"]).default("mobile"),
  priority:    z.number().int().min(0).default(0),
  startAt:     z.string().datetime().optional(),
  endAt:       z.string().datetime().optional(),
});

router.post("/content/banners", async (req, res) => {
  const parsed = bannerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    const [banner] = await db.insert(promotionalBannersTable).values({
      ...parsed.data,
      startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : null,
      endAt:   parsed.data.endAt   ? new Date(parsed.data.endAt)   : null,
      status:  parsed.data.status ?? "draft",
      createdBySaId: sa.superAdminId,
      updatedBySaId: sa.superAdminId,
    }).returning();
    return res.status(201).json({ banner });
  } catch (err) {
    logger.error({ err }, "SA create banner failed");
    return res.status(500).json({ error: "Failed to create banner" });
  }
});

router.patch("/content/banners/:id", async (req, res) => {
  const id     = String(req.params["id"]);
  const parsed = bannerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    const [banner] = await db.update(promotionalBannersTable)
      .set({
        ...parsed.data,
        startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : undefined,
        endAt:   parsed.data.endAt   ? new Date(parsed.data.endAt)   : undefined,
        updatedBySaId: sa.superAdminId,
        updatedAt: new Date(),
      })
      .where(eq(promotionalBannersTable.id, id)).returning();
    if (!banner) return res.status(404).json({ error: "Banner not found" });
    return res.json({ banner });
  } catch (err) {
    logger.error({ err }, "SA update banner failed");
    return res.status(500).json({ error: "Failed to update banner" });
  }
});

router.delete("/content/banners/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    const [banner] = await db.select({ status: promotionalBannersTable.status }).from(promotionalBannersTable).where(eq(promotionalBannersTable.id, id)).limit(1);
    if (!banner) return res.status(404).json({ error: "Banner not found" });
    if (banner.status !== "draft") return res.status(400).json({ error: "Only draft banners can be deleted" });
    await db.delete(promotionalBannersTable).where(eq(promotionalBannersTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete banner failed");
    return res.status(500).json({ error: "Failed to delete banner" });
  }
});

// ── Featured Listings ─────────────────────────────────────────────────────────

router.get("/content/featured", async (_req, res) => {
  try {
    const rows = await db
      .select({
        id:              featuredListingsTable.id,
        listingType:     featuredListingsTable.listingType,
        targetCompanyId: featuredListingsTable.targetCompanyId,
        targetProductId: featuredListingsTable.targetProductId,
        placement:       featuredListingsTable.placement,
        priority:        featuredListingsTable.priority,
        status:          featuredListingsTable.status,
        isOrganic:       featuredListingsTable.isOrganic,
        startAt:         featuredListingsTable.startAt,
        endAt:           featuredListingsTable.endAt,
        createdAt:       featuredListingsTable.createdAt,
        companyNameEn:   companiesTable.nameEn,
        companyNameAr:   companiesTable.nameAr,
        companyNameKu:   companiesTable.nameKu,
        productNameEn:   productsTable.nameEn,
        productNameAr:   productsTable.nameAr,
        productNameKu:   productsTable.nameKu,
      })
      .from(featuredListingsTable)
      .leftJoin(companiesTable, eq(featuredListingsTable.targetCompanyId, companiesTable.id))
      .leftJoin(productsTable,  eq(featuredListingsTable.targetProductId,  productsTable.id))
      .where(ne(featuredListingsTable.listingType, "featured_seller"))
      .orderBy(featuredListingsTable.priority, desc(featuredListingsTable.createdAt));
    return res.json({ listings: rows });
  } catch (err) {
    logger.error({ err }, "SA list featured failed");
    return res.status(500).json({ error: "Failed to list featured listings" });
  }
});

// ── Seller / Company search (for Featured Listing dialog) ─────────────────────
router.get("/content/sellers/search", async (req, res) => {
  try {
    const q = String(req.query["q"] ?? "").trim();
    let rows;
    if (q.length >= 2) {
      rows = await db
        .select({ id: companiesTable.id, nameEn: companiesTable.nameEn, nameAr: companiesTable.nameAr, nameKu: companiesTable.nameKu, verificationStatus: companiesTable.verificationStatus })
        .from(companiesTable)
        .where(or(
          ilike(companiesTable.nameEn, `%${q}%`),
          ilike(companiesTable.nameAr, `%${q}%`),
          ilike(companiesTable.nameKu, `%${q}%`),
          ilike(companiesTable.tradeName, `%${q}%`),
        ))
        .limit(20);
    } else {
      rows = await db
        .select({ id: companiesTable.id, nameEn: companiesTable.nameEn, nameAr: companiesTable.nameAr, nameKu: companiesTable.nameKu, verificationStatus: companiesTable.verificationStatus })
        .from(companiesTable)
        .orderBy(desc(companiesTable.createdAt))
        .limit(30);
    }
    return res.json({ companies: rows });
  } catch (err) {
    logger.error({ err }, "SA seller search failed");
    return res.status(500).json({ error: "Failed to search sellers" });
  }
});

const featuredSchema = z.object({
  listingType:      z.enum(["featured_product","sponsored_product","sponsored_seller"]),
  targetCompanyId:  z.string().uuid().optional(),
  targetProductId:  z.string().uuid().optional(),
  placement:        z.enum(["homepage","category","search","all"]).default("homepage"),
  priority:         z.number().int().min(0).default(0),
  status:           z.enum(["active","inactive","expired"]).default("active"),
  startAt:          z.string().datetime().optional(),
  endAt:            z.string().datetime().optional(),
  campaignId:       z.string().uuid().optional(),
  isOrganic:        z.boolean().default(true),
});

router.post("/content/featured", async (req, res) => {
  const parsed = featuredSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    const [listing] = await db.insert(featuredListingsTable).values({
      ...parsed.data,
      startAt:        parsed.data.startAt ? new Date(parsed.data.startAt) : null,
      endAt:          parsed.data.endAt   ? new Date(parsed.data.endAt)   : null,
      targetCompanyId: parsed.data.targetCompanyId ?? null,
      targetProductId: parsed.data.targetProductId ?? null,
      campaignId:      parsed.data.campaignId ?? null,
      createdBySaId:  sa.superAdminId,
      updatedBySaId:  sa.superAdminId,
    }).returning();
    await writeAuditLog(
      { actorType: "super_admin", actorId: sa.superAdminId, actorDisplayName: "Super Admin" },
      "superadmin.featured_listing_created", { type: "featured_listing", id: listing.id },
      { listingType: listing.listingType, targetProductId: listing.targetProductId, targetCompanyId: listing.targetCompanyId },
      req,
    );
    return res.status(201).json({ listing });
  } catch (err) {
    logger.error({ err }, "SA create featured listing failed");
    return res.status(500).json({ error: "Failed to create featured listing" });
  }
});

router.patch("/content/featured/:id", async (req, res) => {
  const id     = String(req.params["id"]);
  const parsed = featuredSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    const [listing] = await db.update(featuredListingsTable)
      .set({
        ...parsed.data,
        startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : undefined,
        endAt:   parsed.data.endAt   ? new Date(parsed.data.endAt)   : undefined,
        updatedBySaId: sa.superAdminId,
        updatedAt: new Date(),
      })
      .where(and(
        eq(featuredListingsTable.id, id),
        ne(featuredListingsTable.listingType, "featured_seller"),
      )).returning();
    if (!listing) return res.status(404).json({ error: "Listing not found" });
    return res.json({ listing });
  } catch (err) {
    logger.error({ err }, "SA update featured listing failed");
    return res.status(500).json({ error: "Failed to update featured listing" });
  }
});

router.delete("/content/featured/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    const [deleted] = await db.delete(featuredListingsTable)
      .where(and(
        eq(featuredListingsTable.id, id),
        ne(featuredListingsTable.listingType, "featured_seller"),
      ))
      .returning({ id: featuredListingsTable.id });
    if (!deleted) return res.status(404).json({ error: "Listing not found" });
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete featured listing failed");
    return res.status(500).json({ error: "Failed to delete featured listing" });
  }
});

// ── VIP Sellers ───────────────────────────────────────────────────────────────
// Dedicated management routes for featured_seller/homepage VIP entries.
// All routes are protected by requireSuperAdmin + requireSAPermission('content')
// which is applied via the router-level middleware above.

// GET /superadmin/content/vip-sellers — list all VIP seller entries enriched with company names
router.get("/content/vip-sellers", async (req, res): Promise<void> => {
  try {
    const rows = await db
      .select({
        id:              featuredListingsTable.id,
        listingType:     featuredListingsTable.listingType,
        placement:       featuredListingsTable.placement,
        targetCompanyId: featuredListingsTable.targetCompanyId,
        priority:        featuredListingsTable.priority,
        status:          featuredListingsTable.status,
        isOrganic:       featuredListingsTable.isOrganic,
        startAt:         featuredListingsTable.startAt,
        endAt:           featuredListingsTable.endAt,
        createdAt:       featuredListingsTable.createdAt,
        updatedAt:       featuredListingsTable.updatedAt,
        companyNameEn:   companiesTable.nameEn,
        companyNameAr:   companiesTable.nameAr,
        companyNameKu:   companiesTable.nameKu,
        canSell:         companyMarketplaceProfilesTable.canSell,
        isSellerSearchable: companyMarketplaceProfilesTable.isSellerSearchable,
        verificationStatus: companiesTable.verificationStatus,
      })
      .from(featuredListingsTable)
      .leftJoin(companiesTable, eq(featuredListingsTable.targetCompanyId, companiesTable.id))
      .leftJoin(companyMarketplaceProfilesTable, eq(featuredListingsTable.targetCompanyId, companyMarketplaceProfilesTable.companyId))
      .where(
        and(
          eq(featuredListingsTable.listingType, "featured_seller"),
          eq(featuredListingsTable.placement, "homepage"),
          isNotNull(featuredListingsTable.targetCompanyId),
          isNull(featuredListingsTable.targetProductId),
          isNull(featuredListingsTable.campaignId),
          eq(featuredListingsTable.isOrganic, true),
        ),
      )
      .orderBy(asc(featuredListingsTable.priority), desc(featuredListingsTable.createdAt));

    // Enrich with eligibility indicator
    const sellers = rows.map((r) => ({
      ...r,
      canSell: r.canSell ?? false,
      isEligible:
        (r.canSell === true) &&
        (r.isSellerSearchable === true) &&
        (r.verificationStatus === "active" || r.verificationStatus === "verified"),
    }));

    res.json({ sellers });
  } catch (err) {
    req.log.error({ err }, "SA list VIP sellers failed");
    res.status(500).json({ error: "Failed to list VIP sellers" });
  }
});

// GET /superadmin/content/vip-sellers/search?q= — search eligible companies not already pinned
router.get("/content/vip-sellers/search", async (req, res): Promise<void> => {
  const q = String(req.query["q"] ?? "").trim();
  try {
    // Get already-pinned company IDs
    const pinned = await db
      .select({ targetCompanyId: featuredListingsTable.targetCompanyId })
      .from(featuredListingsTable)
      .where(
        and(
          eq(featuredListingsTable.listingType, "featured_seller"),
          eq(featuredListingsTable.placement, "homepage"),
          isNotNull(featuredListingsTable.targetCompanyId),
          isNull(featuredListingsTable.targetProductId),
          isNull(featuredListingsTable.campaignId),
          eq(featuredListingsTable.isOrganic, true),
        ),
      );
    const pinnedIds = pinned
      .map((r) => r.targetCompanyId)
      .filter((id): id is string => id !== null);

    // Build name search condition
    const nameCondition = q.length >= 2
      ? or(
          ilike(companiesTable.nameEn, `%${q}%`),
          ilike(companiesTable.nameAr, `%${q}%`),
          ilike(companiesTable.nameKu, `%${q}%`),
          ilike(companiesTable.tradeName, `%${q}%`),
        )
      : undefined;

    const eligibilityCondition = and(
      eq(companyMarketplaceProfilesTable.canSell, true),
      eq(companyMarketplaceProfilesTable.isSellerSearchable, true),
      or(
        eq(companiesTable.verificationStatus, "active" as const),
        eq(companiesTable.verificationStatus, "verified" as const),
      ),
    );

    const whereCondition = nameCondition
      ? and(eligibilityCondition, nameCondition)
      : eligibilityCondition;

    const results = await db
      .select({
        id:                 companiesTable.id,
        nameEn:             companiesTable.nameEn,
        nameAr:             companiesTable.nameAr,
        nameKu:             companiesTable.nameKu,
        tradeName:          companiesTable.tradeName,
        verificationStatus: companiesTable.verificationStatus,
        canSell:            companyMarketplaceProfilesTable.canSell,
        isSellerSearchable: companyMarketplaceProfilesTable.isSellerSearchable,
      })
      .from(companiesTable)
      .innerJoin(companyMarketplaceProfilesTable, eq(companiesTable.id, companyMarketplaceProfilesTable.companyId))
      .where(whereCondition)
      .orderBy(asc(companiesTable.nameEn))
      .limit(30);

    const pinnedSet = new Set(pinnedIds);
    res.json({ companies: results.filter((r) => !pinnedSet.has(r.id)) });
  } catch (err) {
    req.log.error({ err }, "SA VIP seller search failed");
    res.status(500).json({ error: "Failed to search sellers" });
  }
});

const vipSellerCreateSchema = z.object({
  targetCompanyId: z.string().uuid(),
  priority:        z.number().int().min(0).default(0),
  status:          z.enum(["active", "inactive"]).default("active"),
});

const vipSellerPatchSchema = z.object({
  priority: z.number().int().min(0).optional(),
  status:   z.enum(["active", "inactive"]).optional(),
}).refine((d) => d.priority !== undefined || d.status !== undefined, {
  message: "At least one of priority or status must be provided",
});

// POST /superadmin/content/vip-sellers — create a VIP seller entry
router.post("/content/vip-sellers", async (req, res): Promise<void> => {
  const parsed = vipSellerCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const sa = (req as any).superAdmin!;
  const { targetCompanyId, priority, status } = parsed.data;

  try {
    // Re-check seller eligibility
    const [profile] = await db
      .select({
        canSell:            companyMarketplaceProfilesTable.canSell,
        isSellerSearchable: companyMarketplaceProfilesTable.isSellerSearchable,
        verificationStatus: companiesTable.verificationStatus,
      })
      .from(companyMarketplaceProfilesTable)
      .innerJoin(companiesTable, eq(companyMarketplaceProfilesTable.companyId, companiesTable.id))
      .where(eq(companyMarketplaceProfilesTable.companyId, targetCompanyId));

    const isEligible =
      profile &&
      profile.canSell === true &&
      profile.isSellerSearchable === true &&
      (profile.verificationStatus === "active" || profile.verificationStatus === "verified");

    if (!isEligible) {
      res.status(422).json({ error: "Seller is not eligible for VIP listing", code: "SELLER_NOT_ELIGIBLE" });
      return;
    }

    // Check for duplicate
    const [existing] = await db
      .select({ id: featuredListingsTable.id })
      .from(featuredListingsTable)
      .where(
        and(
          eq(featuredListingsTable.listingType, "featured_seller"),
          eq(featuredListingsTable.placement, "homepage"),
          eq(featuredListingsTable.targetCompanyId, targetCompanyId),
          isNull(featuredListingsTable.targetProductId),
          isNull(featuredListingsTable.campaignId),
          eq(featuredListingsTable.isOrganic, true),
        ),
      );

    if (existing) {
      res.status(409).json({ error: "Company is already a VIP seller", code: "VIP_SELLER_EXISTS" });
      return;
    }

    const [listing] = await db.insert(featuredListingsTable).values({
      listingType:     "featured_seller",
      placement:       "homepage",
      targetCompanyId,
      targetProductId: null,
      campaignId:      null,
      isOrganic:       true,
      priority,
      status,
      createdBySaId:   sa.superAdminId,
      updatedBySaId:   sa.superAdminId,
    }).returning();

    await writeAuditLog(
      { actorType: "super_admin", actorId: sa.superAdminId, actorDisplayName: "Super Admin" },
      "superadmin.vip_seller_created",
      { type: "featured_listing", id: listing.id },
      { targetCompanyId, priority, status },
      req,
    );

    res.status(201).json({ seller: listing });
  } catch (err: any) {
    if (hasDatabaseErrorCode(err, "23505")) {
      res.status(409).json({ error: "Company is already a VIP seller", code: "VIP_SELLER_EXISTS" });
      return;
    }
    req.log.error({ err }, "SA create VIP seller failed");
    res.status(500).json({ error: "Failed to create VIP seller" });
  }
});

// PATCH /superadmin/content/vip-sellers/:id — update priority and/or status
router.patch("/content/vip-sellers/:id", async (req, res): Promise<void> => {
  const id = String(req.params["id"]);
  const parsed = vipSellerPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const sa = (req as any).superAdmin!;

  try {
    // Verify the record belongs to featured_seller/homepage
    const [existing] = await db
      .select({ id: featuredListingsTable.id, targetCompanyId: featuredListingsTable.targetCompanyId })
      .from(featuredListingsTable)
      .where(
        and(
          eq(featuredListingsTable.id, id),
          eq(featuredListingsTable.listingType, "featured_seller"),
          eq(featuredListingsTable.placement, "homepage"),
          isNotNull(featuredListingsTable.targetCompanyId),
          isNull(featuredListingsTable.targetProductId),
          isNull(featuredListingsTable.campaignId),
          eq(featuredListingsTable.isOrganic, true),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "VIP seller listing not found" });
      return;
    }

    const [listing] = await db.update(featuredListingsTable)
      .set({
        ...parsed.data,
        updatedBySaId: sa.superAdminId,
        updatedAt:     new Date(),
      })
      .where(eq(featuredListingsTable.id, id))
      .returning();

    await writeAuditLog(
      { actorType: "super_admin", actorId: sa.superAdminId, actorDisplayName: "Super Admin" },
      "superadmin.vip_seller_updated",
      { type: "featured_listing", id: listing.id },
      { ...parsed.data, targetCompanyId: existing.targetCompanyId },
      req,
    );

    res.json({ seller: listing });
  } catch (err) {
    req.log.error({ err }, "SA update VIP seller failed");
    res.status(500).json({ error: "Failed to update VIP seller" });
  }
});

// DELETE /superadmin/content/vip-sellers/:id — remove a VIP seller entry
router.delete("/content/vip-sellers/:id", async (req, res): Promise<void> => {
  const id = String(req.params["id"]);
  const sa = (req as any).superAdmin!;

  try {
    // Verify ownership
    const [existing] = await db
      .select({ id: featuredListingsTable.id, targetCompanyId: featuredListingsTable.targetCompanyId })
      .from(featuredListingsTable)
      .where(
        and(
          eq(featuredListingsTable.id, id),
          eq(featuredListingsTable.listingType, "featured_seller"),
          eq(featuredListingsTable.placement, "homepage"),
          isNotNull(featuredListingsTable.targetCompanyId),
          isNull(featuredListingsTable.targetProductId),
          isNull(featuredListingsTable.campaignId),
          eq(featuredListingsTable.isOrganic, true),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "VIP seller listing not found" });
      return;
    }

    await db.delete(featuredListingsTable).where(eq(featuredListingsTable.id, id));

    await writeAuditLog(
      { actorType: "super_admin", actorId: sa.superAdminId, actorDisplayName: "Super Admin" },
      "superadmin.vip_seller_removed",
      { type: "featured_listing", id },
      { targetCompanyId: existing.targetCompanyId },
      req,
    );

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "SA delete VIP seller failed");
    res.status(500).json({ error: "Failed to delete VIP seller" });
  }
});

// ── Popular Products ───────────────────────────────────────────────────────────
// SA-curated list shown in the buyer mobile app's "Popular Products" screen.

/**
 * Helper: enrich a list of popular product rows with product name, primary
 * media id, min active price, and marketplace category id.
 */
async function enrichPopular(rows: (typeof platformPopularProductsTable.$inferSelect)[]) {
  if (!rows.length) return [];
  const productIds = rows.map((r) => r.productId);

  const [products, media, prices] = await Promise.all([
    db.select({
      id:         productsTable.id,
      nameEn:     productsTable.nameEn,
      nameAr:     productsTable.nameAr,
      nameKu:     productsTable.nameKu,
      brand:      productsTable.brand,
      categoryId: productsTable.marketplaceCategoryId,
    }).from(productsTable).where(inArray(productsTable.id, productIds)),

    db.select({
      id:        productMediaTable.id,
      productId: productMediaTable.productId,
    }).from(productMediaTable).where(
      and(
        inArray(productMediaTable.productId, productIds),
        eq(productMediaTable.isActive, true),
        eq(productMediaTable.mediaType, "image"),
      ),
    ).orderBy(desc(productMediaTable.isPrimary), asc(productMediaTable.displayOrder)),

    db.select({
      productId: productPricesTable.productId,
      basePrice: productPricesTable.basePrice,
      currency:  productPricesTable.currency,
    }).from(productPricesTable).where(
      and(
        inArray(productPricesTable.productId, productIds),
        eq(productPricesTable.isActive, true),
        isNotNull(productPricesTable.productId),
      ),
    ),
  ]);

  const productMap = new Map(products.map((p) => [p.id, p]));
  const mediaMap   = new Map<string, string>();
  for (const m of media) { if (!mediaMap.has(m.productId)) mediaMap.set(m.productId, m.id); }
  const priceMap   = new Map<string, { basePrice: string | null; currency: string | null }>();
  for (const p of prices) { if (!priceMap.has(p.productId)) priceMap.set(p.productId, p); }

  return rows.map((row) => {
    const prod  = productMap.get(row.productId);
    const price = priceMap.get(row.productId);
    return {
      ...row,
      nameEn:     prod?.nameEn     ?? "(unknown)",
      nameAr:     prod?.nameAr     ?? null,
      nameKu:     prod?.nameKu     ?? null,
      brand:      prod?.brand      ?? null,
      categoryId: prod?.categoryId ?? null,
      mediaId:    mediaMap.get(row.productId) ?? null,
      price:      price?.basePrice ?? null,
      currency:   price?.currency  ?? null,
    };
  });
}

// GET /superadmin/content/popular-products
router.get("/content/popular-products", async (_req, res) => {
  try {
    const rows = await db
      .select().from(platformPopularProductsTable)
      .orderBy(asc(platformPopularProductsTable.displayOrder));
    const enriched = await enrichPopular(rows);
    return res.json({ products: enriched });
  } catch (err) {
    logger.error({ err }, "SA list popular products failed");
    return res.status(500).json({ error: "Failed to list popular products" });
  }
});

// GET /superadmin/content/popular-products/search?q=...
// Returns published (active + publishedAt not null) products not yet pinned.
router.get("/content/popular-products/search", async (req, res) => {
  const q = req.query["q"] as string | undefined;
  try {
    const [allPinned, results] = await Promise.all([
      db.select({ productId: platformPopularProductsTable.productId })
        .from(platformPopularProductsTable),
      db.select({
        id:     productsTable.id,
        nameEn: productsTable.nameEn,
        nameAr: productsTable.nameAr,
        nameKu: productsTable.nameKu,
        brand:  productsTable.brand,
      }).from(productsTable).where(
        and(
          eq(productsTable.status, "active"),
          isNotNull(productsTable.publishedAt),
          q ? or(
            ilike(productsTable.nameEn, `%${q}%`),
            ilike(productsTable.nameAr, `%${q}%`),
            ilike(productsTable.nameKu, `%${q}%`),
            ilike(productsTable.brand,  `%${q}%`),
          ) : undefined,
        ),
      ).limit(20),
    ]);

    const pinnedSet = new Set(allPinned.map((r) => r.productId));
    return res.json({ products: results.filter((r) => !pinnedSet.has(r.id)) });
  } catch (err) {
    logger.error({ err }, "SA popular products search failed");
    return res.status(500).json({ error: "Failed to search products" });
  }
});

const popularSchema = z.object({
  productId:    z.string().uuid(),
  badgeType:    z.enum(["new", "discount"]).nullable().optional(),
  badgeValue:   z.string().max(20).nullable().optional(),
  displayOrder: z.number().int().min(0).optional(),
});

// POST /superadmin/content/popular-products
router.post("/content/popular-products", async (req, res) => {
  const parsed = popularSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    // Prevent duplicates
    const existing = await db
      .select({ id: platformPopularProductsTable.id })
      .from(platformPopularProductsTable)
      .where(eq(platformPopularProductsTable.productId, parsed.data.productId));
    if (existing.length > 0) return res.status(409).json({ error: "Product already pinned" });

    const [row] = await db.insert(platformPopularProductsTable).values({
      productId:    parsed.data.productId,
      badgeType:    parsed.data.badgeType ?? null,
      badgeValue:   parsed.data.badgeValue ?? null,
      displayOrder: parsed.data.displayOrder ?? 0,
      createdBySaId: sa.superAdminId,
    }).returning();
    return res.status(201).json({ product: row });
  } catch (err) {
    logger.error({ err }, "SA pin popular product failed");
    return res.status(500).json({ error: "Failed to pin product" });
  }
});

// PATCH /superadmin/content/popular-products/:id
router.patch("/content/popular-products/:id", async (req, res) => {
  const id     = String(req.params["id"]);
  const parsed = popularSchema.omit({ productId: true }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const [row] = await db
      .update(platformPopularProductsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(platformPopularProductsTable.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ product: row });
  } catch (err) {
    logger.error({ err }, "SA update popular product failed");
    return res.status(500).json({ error: "Failed to update" });
  }
});

// DELETE /superadmin/content/popular-products/:id
router.delete("/content/popular-products/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    await db.delete(platformPopularProductsTable).where(eq(platformPopularProductsTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete popular product failed");
    return res.status(500).json({ error: "Failed to remove" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// New Arrivals — SA-curated list (mirrors popular-products pattern)
// ══════════════════════════════════════════════════════════════════════════════

async function enrichNewArrivals(rows: (typeof platformNewArrivalsTable.$inferSelect)[]) {
  if (!rows.length) return [];
  const productIds = rows.map((r) => r.productId);

  const [products, media, prices] = await Promise.all([
    db.select({
      id:         productsTable.id,
      nameEn:     productsTable.nameEn,
      nameAr:     productsTable.nameAr,
      nameKu:     productsTable.nameKu,
      brand:      productsTable.brand,
      categoryId: productsTable.marketplaceCategoryId,
    }).from(productsTable).where(inArray(productsTable.id, productIds)),

    db.select({
      id:        productMediaTable.id,
      productId: productMediaTable.productId,
    }).from(productMediaTable).where(
      and(
        inArray(productMediaTable.productId, productIds),
        eq(productMediaTable.isActive, true),
        eq(productMediaTable.mediaType, "image"),
      ),
    ).orderBy(desc(productMediaTable.isPrimary), asc(productMediaTable.displayOrder)),

    db.select({
      productId: productPricesTable.productId,
      basePrice: productPricesTable.basePrice,
      currency:  productPricesTable.currency,
    }).from(productPricesTable).where(
      and(
        inArray(productPricesTable.productId, productIds),
        eq(productPricesTable.isActive, true),
        isNotNull(productPricesTable.productId),
      ),
    ),
  ]);

  const productMap = new Map(products.map((p) => [p.id, p]));
  const mediaMap   = new Map<string, string>();
  for (const m of media) { if (!mediaMap.has(m.productId)) mediaMap.set(m.productId, m.id); }
  const priceMap   = new Map<string, { basePrice: string | null; currency: string | null }>();
  for (const p of prices) { if (!priceMap.has(p.productId)) priceMap.set(p.productId, p); }

  return rows.map((row) => {
    const prod  = productMap.get(row.productId);
    const price = priceMap.get(row.productId);
    return {
      ...row,
      nameEn:     prod?.nameEn     ?? "(unknown)",
      nameAr:     prod?.nameAr     ?? null,
      nameKu:     prod?.nameKu     ?? null,
      brand:      prod?.brand      ?? null,
      categoryId: prod?.categoryId ?? null,
      mediaId:    mediaMap.get(row.productId) ?? null,
      price:      price?.basePrice ?? null,
      currency:   price?.currency  ?? null,
    };
  });
}

// GET /superadmin/content/new-arrivals
router.get("/content/new-arrivals", async (_req, res) => {
  try {
    const rows = await db
      .select().from(platformNewArrivalsTable)
      .orderBy(asc(platformNewArrivalsTable.displayOrder));
    const enriched = await enrichNewArrivals(rows);
    return res.json({ products: enriched });
  } catch (err) {
    logger.error({ err }, "SA list new arrivals failed");
    return res.status(500).json({ error: "Failed to list new arrivals" });
  }
});

// GET /superadmin/content/new-arrivals/search?q=...
router.get("/content/new-arrivals/search", async (req, res) => {
  const q = req.query["q"] as string | undefined;
  try {
    const [allPinned, results] = await Promise.all([
      db.select({ productId: platformNewArrivalsTable.productId })
        .from(platformNewArrivalsTable),
      db.select({
        id:     productsTable.id,
        nameEn: productsTable.nameEn,
        nameAr: productsTable.nameAr,
        nameKu: productsTable.nameKu,
        brand:  productsTable.brand,
      }).from(productsTable).where(
        and(
          eq(productsTable.status, "active"),
          isNotNull(productsTable.publishedAt),
          q ? or(
            ilike(productsTable.nameEn, `%${q}%`),
            ilike(productsTable.nameAr, `%${q}%`),
            ilike(productsTable.nameKu, `%${q}%`),
            ilike(productsTable.brand,  `%${q}%`),
          ) : undefined,
        ),
      ).limit(20),
    ]);

    const pinnedSet = new Set(allPinned.map((r) => r.productId));
    return res.json({ products: results.filter((r) => !pinnedSet.has(r.id)) });
  } catch (err) {
    logger.error({ err }, "SA new arrivals search failed");
    return res.status(500).json({ error: "Failed to search products" });
  }
});

const newArrivalSchema = z.object({
  productId:    z.string().uuid(),
  badgeType:    z.enum(["new", "discount"]).nullable().optional(),
  badgeValue:   z.string().max(20).nullable().optional(),
  displayOrder: z.number().int().min(0).optional(),
});

// POST /superadmin/content/new-arrivals
router.post("/content/new-arrivals", async (req, res) => {
  const parsed = newArrivalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    // Optimistic check — race condition handled by the unique constraint below
    const existing = await db
      .select({ id: platformNewArrivalsTable.id })
      .from(platformNewArrivalsTable)
      .where(eq(platformNewArrivalsTable.productId, parsed.data.productId));
    if (existing.length > 0) return res.status(409).json({ error: "Product already in new arrivals" });

    const [row] = await db.insert(platformNewArrivalsTable).values({
      productId:     parsed.data.productId,
      badgeType:     parsed.data.badgeType ?? "new",
      badgeValue:    parsed.data.badgeValue ?? "New",
      displayOrder:  parsed.data.displayOrder ?? 0,
      createdBySaId: sa.superAdminId,
    }).returning();
    return res.status(201).json({ product: row });
  } catch (err: any) {
    // PostgreSQL unique-constraint violation (race condition or direct duplicate)
    if (err?.code === "23505") {
      return res.status(409).json({ error: "Product already in new arrivals" });
    }
    logger.error({ err }, "SA add new arrival failed");
    return res.status(500).json({ error: "Failed to add product" });
  }
});

// PATCH /superadmin/content/new-arrivals/:id
router.patch("/content/new-arrivals/:id", async (req, res) => {
  const id     = String(req.params["id"]);
  const parsed = newArrivalSchema.omit({ productId: true }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const [row] = await db
      .update(platformNewArrivalsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(platformNewArrivalsTable.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ product: row });
  } catch (err) {
    logger.error({ err }, "SA update new arrival failed");
    return res.status(500).json({ error: "Failed to update" });
  }
});

// DELETE /superadmin/content/new-arrivals/:id
router.delete("/content/new-arrivals/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    await db.delete(platformNewArrivalsTable).where(eq(platformNewArrivalsTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete new arrival failed");
    return res.status(500).json({ error: "Failed to remove" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Deals & Offers — SA-managed flash banners, deal products, and coupons
// ══════════════════════════════════════════════════════════════════════════════

// ── Helpers ───────────────────────────────────────────────────────────────────

async function enrichDealProducts(rows: (typeof platformDealProductsTable.$inferSelect)[]) {
  if (!rows.length) return [];
  const productIds = rows.map((r) => r.productId);
  const [products, media, prices] = await Promise.all([
    db.select({
      id:     productsTable.id,
      nameEn: productsTable.nameEn,
      nameAr: productsTable.nameAr,
      nameKu: productsTable.nameKu,
      brand:  productsTable.brand,
    }).from(productsTable).where(inArray(productsTable.id, productIds)),
    db.select({
      id:        productMediaTable.id,
      productId: productMediaTable.productId,
    }).from(productMediaTable).where(
      and(
        inArray(productMediaTable.productId, productIds),
        eq(productMediaTable.isActive, true),
        eq(productMediaTable.mediaType, "image"),
      ),
    ).orderBy(desc(productMediaTable.isPrimary), asc(productMediaTable.displayOrder)),
    db.select({
      productId: productPricesTable.productId,
      basePrice: productPricesTable.basePrice,
      currency:  productPricesTable.currency,
    }).from(productPricesTable).where(
      and(
        inArray(productPricesTable.productId, productIds),
        eq(productPricesTable.isActive, true),
      ),
    ),
  ]);

  const productMap = new Map(products.map((p) => [p.id, p]));
  const mediaMap   = new Map<string, string>();
  for (const m of media) { if (!mediaMap.has(m.productId)) mediaMap.set(m.productId, m.id); }
  const priceMap = new Map<string, string>();
  for (const p of prices) { if (!priceMap.has(p.productId) && p.basePrice) priceMap.set(p.productId, p.basePrice); }

  return rows.map((row) => {
    const prod = productMap.get(row.productId);
    return {
      ...row,
      nameEn:  prod?.nameEn ?? null,
      nameAr:  prod?.nameAr ?? null,
      nameKu:  prod?.nameKu ?? null,
      brand:   prod?.brand  ?? null,
      mediaId: mediaMap.get(row.productId) ?? null,
      price:   priceMap.get(row.productId) ?? null,
    };
  });
}

// ── Deal Banners (flash-sale carousel) ────────────────────────────────────────

router.get("/content/deal-banners", async (_req, res) => {
  try {
    const rows = await db.select().from(platformDealBannersTable)
      .orderBy(asc(platformDealBannersTable.displayOrder));
    return res.json({ banners: rows });
  } catch (err) {
    logger.error({ err }, "SA list deal banners failed");
    return res.status(500).json({ error: "Failed to list deal banners" });
  }
});

const dealBannerSchema = z.object({
  titleEn:      z.string().min(1).max(200).optional(),
  titleAr:      z.string().min(1).max(200).optional(),
  titleKu:      z.string().min(1).max(200).optional(),
  subtitleEn:   z.string().max(300).nullable().optional(),
  subtitleAr:   z.string().max(300).nullable().optional(),
  subtitleKu:   z.string().max(300).nullable().optional(),
  discountText: z.string().min(1).max(100).optional(),
  ctaLabel:     z.string().min(1).max(80).optional(),
  imageKey:     z.string().nullable().optional(),
  endsAt:       z.string().datetime().nullable().optional(),
  isActive:     z.boolean().optional(),
  displayOrder: z.number().int().min(0).optional(),
});

router.post("/content/deal-banners", async (req, res) => {
  const parsed = dealBannerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    const [row] = await db.insert(platformDealBannersTable).values({
      titleEn:      parsed.data.titleEn      ?? "Flash Sale",
      titleAr:      parsed.data.titleAr      ?? "تخفيضات",
      titleKu:      parsed.data.titleKu      ?? "فرۆشتنی خێرا",
      subtitleEn:   parsed.data.subtitleEn   ?? null,
      subtitleAr:   parsed.data.subtitleAr   ?? null,
      subtitleKu:   parsed.data.subtitleKu   ?? null,
      discountText: parsed.data.discountText ?? "Up to 60% OFF",
      ctaLabel:     parsed.data.ctaLabel     ?? "Shop Now",
      imageKey:     parsed.data.imageKey     ?? null,
      endsAt:       parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
      isActive:     parsed.data.isActive     ?? true,
      displayOrder: parsed.data.displayOrder ?? 0,
      createdBySaId: sa.superAdminId,
    }).returning();
    return res.status(201).json({ banner: row });
  } catch (err) {
    logger.error({ err }, "SA create deal banner failed");
    return res.status(500).json({ error: "Failed to create deal banner" });
  }
});

router.patch("/content/deal-banners/:id", async (req, res) => {
  const id     = String(req.params["id"]);
  const parsed = dealBannerSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const patch: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
    if (parsed.data.endsAt !== undefined) patch["endsAt"] = parsed.data.endsAt ? new Date(parsed.data.endsAt) : null;
    const [row] = await db.update(platformDealBannersTable).set(patch as any)
      .where(eq(platformDealBannersTable.id, id)).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ banner: row });
  } catch (err) {
    logger.error({ err }, "SA update deal banner failed");
    return res.status(500).json({ error: "Failed to update deal banner" });
  }
});

router.delete("/content/deal-banners/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    await db.delete(platformDealBannersTable).where(eq(platformDealBannersTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete deal banner failed");
    return res.status(500).json({ error: "Failed to remove deal banner" });
  }
});

// ── Deal Products ─────────────────────────────────────────────────────────────

router.get("/content/deal-products", async (_req, res) => {
  try {
    const rows = await db.select().from(platformDealProductsTable)
      .orderBy(asc(platformDealProductsTable.displayOrder));
    const enriched = await enrichDealProducts(rows);
    return res.json({ products: enriched });
  } catch (err) {
    logger.error({ err }, "SA list deal products failed");
    return res.status(500).json({ error: "Failed to list deal products" });
  }
});

// Reuse popular-products search for picking products to add to deals
router.get("/content/deal-products/search", async (req, res) => {
  const q = req.query["q"] as string | undefined;
  try {
    const [allPinned, results] = await Promise.all([
      db.select({ productId: platformDealProductsTable.productId }).from(platformDealProductsTable),
      db.select({
        id:     productsTable.id,
        nameEn: productsTable.nameEn,
        nameAr: productsTable.nameAr,
        nameKu: productsTable.nameKu,
        brand:  productsTable.brand,
      }).from(productsTable).where(
        and(
          eq(productsTable.status, "active"),
          isNotNull(productsTable.publishedAt),
          q ? or(
            ilike(productsTable.nameEn, `%${q}%`),
            ilike(productsTable.nameAr, `%${q}%`),
            ilike(productsTable.nameKu, `%${q}%`),
            ilike(productsTable.brand,  `%${q}%`),
          ) : undefined,
        ),
      ).limit(20),
    ]);
    const pinnedSet = new Set(allPinned.map((r) => r.productId));
    return res.json({ products: results.filter((r) => !pinnedSet.has(r.id)) });
  } catch (err) {
    logger.error({ err }, "SA deal products search failed");
    return res.status(500).json({ error: "Failed to search" });
  }
});

const dealProductSchema = z.object({
  productId:       z.string().uuid(),
  dealCategory:    z.enum(["hot", "limited_time", "bundle", "clearance"]).optional(),
  discountPercent: z.number().int().min(1).max(99).nullable().optional(),
  dealPrice:       z.string().nullable().optional(),
  endsAt:          z.string().datetime().nullable().optional(),
  displayOrder:    z.number().int().min(0).optional(),
});

router.post("/content/deal-products", async (req, res) => {
  const parsed = dealProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    const existing = await db.select({ id: platformDealProductsTable.id })
      .from(platformDealProductsTable)
      .where(eq(platformDealProductsTable.productId, parsed.data.productId));
    if (existing.length) return res.status(409).json({ error: "Product already in deals" });

    const [row] = await db.insert(platformDealProductsTable).values({
      productId:       parsed.data.productId,
      dealCategory:    parsed.data.dealCategory    ?? "hot",
      discountPercent: parsed.data.discountPercent ?? null,
      dealPrice:       parsed.data.dealPrice       ?? null,
      endsAt:          parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
      displayOrder:    parsed.data.displayOrder    ?? 0,
      createdBySaId:   sa.superAdminId,
    }).returning();
    return res.status(201).json({ product: row });
  } catch (err) {
    logger.error({ err }, "SA pin deal product failed");
    return res.status(500).json({ error: "Failed to add deal product" });
  }
});

router.patch("/content/deal-products/:id", async (req, res) => {
  const id     = String(req.params["id"]);
  const parsed = dealProductSchema.omit({ productId: true }).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const patch: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
    if (parsed.data.endsAt !== undefined) patch["endsAt"] = parsed.data.endsAt ? new Date(parsed.data.endsAt) : null;
    const [row] = await db.update(platformDealProductsTable).set(patch as any)
      .where(eq(platformDealProductsTable.id, id)).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ product: row });
  } catch (err) {
    logger.error({ err }, "SA update deal product failed");
    return res.status(500).json({ error: "Failed to update" });
  }
});

router.delete("/content/deal-products/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    await db.delete(platformDealProductsTable).where(eq(platformDealProductsTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete deal product failed");
    return res.status(500).json({ error: "Failed to remove deal product" });
  }
});

// ── Deal Coupons ──────────────────────────────────────────────────────────────

router.get("/content/deal-coupons", async (_req, res) => {
  try {
    const rows = await db.select().from(platformDealCouponsTable)
      .orderBy(asc(platformDealCouponsTable.displayOrder));
    return res.json({ coupons: rows });
  } catch (err) {
    logger.error({ err }, "SA list deal coupons failed");
    return res.status(500).json({ error: "Failed to list coupons" });
  }
});

const dealCouponSchema = z.object({
  titleEn:       z.string().min(1).max(200).optional(),
  titleAr:       z.string().min(1).max(200).optional(),
  titleKu:       z.string().min(1).max(200).optional(),
  code:          z.string().min(1).max(50),
  discountText:  z.string().min(1).max(200),
  conditionText: z.string().max(300).nullable().optional(),
  isActive:      z.boolean().optional(),
  displayOrder:  z.number().int().min(0).optional(),
});

router.post("/content/deal-coupons", async (req, res) => {
  const parsed = dealCouponSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  const sa = (req as any).superAdmin!;
  try {
    const [row] = await db.insert(platformDealCouponsTable).values({
      titleEn:      parsed.data.titleEn      ?? "Special Offer",
      titleAr:      parsed.data.titleAr      ?? "عرض خاص",
      titleKu:      parsed.data.titleKu      ?? "ئۆفەری تایبەت",
      code:          parsed.data.code,
      discountText:  parsed.data.discountText,
      conditionText: parsed.data.conditionText ?? null,
      isActive:     parsed.data.isActive      ?? true,
      displayOrder: parsed.data.displayOrder  ?? 0,
      createdBySaId: sa.superAdminId,
    }).returning();
    return res.status(201).json({ coupon: row });
  } catch (err) {
    logger.error({ err }, "SA create deal coupon failed");
    return res.status(500).json({ error: "Failed to create coupon" });
  }
});

router.patch("/content/deal-coupons/:id", async (req, res) => {
  const id     = String(req.params["id"]);
  const parsed = dealCouponSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const [row] = await db.update(platformDealCouponsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(platformDealCouponsTable.id, id)).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ coupon: row });
  } catch (err) {
    logger.error({ err }, "SA update deal coupon failed");
    return res.status(500).json({ error: "Failed to update coupon" });
  }
});

router.delete("/content/deal-coupons/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    await db.delete(platformDealCouponsTable).where(eq(platformDealCouponsTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete deal coupon failed");
    return res.status(500).json({ error: "Failed to remove coupon" });
  }
});

export default router;

// ════════════════════════════════════════════════════════════════════════════
// BRANDS — SA-managed editorial brand catalog
// ════════════════════════════════════════════════════════════════════════════

import { platformBrandsTable } from "@workspace/db";

const brandCreateSchema = z.object({
  nameEn:       z.string().min(1),
  nameAr:       z.string().optional().nullable(),
  nameKu:       z.string().optional().nullable(),
  logoText:     z.string().min(1).max(14),
  logoColor:    z.string().default("#111827"),
  category:     z.enum(["electronics","fashion","home_living","beauty","automotive","other"]).default("other"),
  productCount: z.number().int().min(0).default(0),
  website:      z.string().url().optional().nullable(),
  isTop:        z.boolean().default(false),
  isActive:     z.boolean().default(true),
  displayOrder: z.number().int().optional(),
});
const brandUpdateSchema = brandCreateSchema.partial();

// GET /superadmin/content/brands
router.get("/content/brands", async (_req, res) => {
  try {
    const brands = await db
      .select()
      .from(platformBrandsTable)
      .orderBy(asc(platformBrandsTable.displayOrder), asc(platformBrandsTable.nameEn));
    return res.json({ brands });
  } catch (err) {
    logger.error({ err }, "SA list brands failed");
    return res.status(500).json({ error: "Failed to list brands" });
  }
});

// POST /superadmin/content/brands
router.post("/content/brands", async (req, res) => {
  const parsed = brandCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const maxOrder = await db
      .select({ v: platformBrandsTable.displayOrder })
      .from(platformBrandsTable)
      .orderBy(desc(platformBrandsTable.displayOrder))
      .limit(1);
    const nextOrder = parsed.data.displayOrder ?? ((maxOrder[0]?.v ?? -1) + 1);
    const [brand] = await db
      .insert(platformBrandsTable)
      .values({ ...parsed.data, displayOrder: nextOrder })
      .returning();
    return res.status(201).json({ brand });
  } catch (err) {
    logger.error({ err }, "SA create brand failed");
    return res.status(500).json({ error: "Failed to create brand" });
  }
});

// PATCH /superadmin/content/brands/:id
router.patch("/content/brands/:id", async (req, res) => {
  const id = String(req.params["id"]);
  const parsed = brandUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const [brand] = await db
      .update(platformBrandsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(platformBrandsTable.id, id))
      .returning();
    if (!brand) return res.status(404).json({ error: "Not found" });
    return res.json({ brand });
  } catch (err) {
    logger.error({ err }, "SA update brand failed");
    return res.status(500).json({ error: "Failed to update brand" });
  }
});

// DELETE /superadmin/content/brands/:id
router.delete("/content/brands/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    await db.delete(platformBrandsTable).where(eq(platformBrandsTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete brand failed");
    return res.status(500).json({ error: "Failed to delete brand" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SUPPLIER DIRECTORY — SA-managed editorial supplier catalog
// ════════════════════════════════════════════════════════════════════════════

import { platformSuppliersTable } from "@workspace/db";

const supplierCreateSchema = z.object({
  nameEn:          z.string().min(1),
  nameAr:          z.string().optional().nullable(),
  nameKu:          z.string().optional().nullable(),
  initials:        z.string().min(1).max(3),
  avatarColor:     z.string().default("#1E3A5F"),
  category:        z.string().min(1),
  categoryColor:   z.string().default("#3B82F6"),
  location:        z.string().optional().nullable(),
  productCount:    z.number().int().min(0).default(0),
  establishedYear: z.number().int().optional().nullable(),
  minOrderText:    z.string().optional().nullable(),
  isVerified:      z.boolean().default(false),
  isOnline:        z.boolean().default(false),
  rating:          z.union([z.string(), z.number()]).optional().nullable(),
  reviewCount:     z.number().int().min(0).default(0),
  certifications:  z.array(z.string()).default([]),
  isActive:        z.boolean().default(true),
  displayOrder:    z.number().int().optional(),
});
const supplierUpdateSchema = supplierCreateSchema.partial();

// GET /superadmin/content/suppliers
router.get("/content/suppliers", async (_req, res) => {
  try {
    const suppliers = await db
      .select()
      .from(platformSuppliersTable)
      .orderBy(asc(platformSuppliersTable.displayOrder), asc(platformSuppliersTable.nameEn));
    return res.json({ suppliers });
  } catch (err) {
    logger.error({ err }, "SA list suppliers failed");
    return res.status(500).json({ error: "Failed to list suppliers" });
  }
});

// POST /superadmin/content/suppliers
router.post("/content/suppliers", async (req, res) => {
  const parsed = supplierCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const maxOrder = await db
      .select({ v: platformSuppliersTable.displayOrder })
      .from(platformSuppliersTable)
      .orderBy(desc(platformSuppliersTable.displayOrder))
      .limit(1);
    const nextOrder = parsed.data.displayOrder ?? ((maxOrder[0]?.v ?? -1) + 1);
    const [supplier] = await db
      .insert(platformSuppliersTable)
      .values({ ...parsed.data, rating: parsed.data.rating != null ? String(parsed.data.rating) : null, displayOrder: nextOrder })
      .returning();
    return res.status(201).json({ supplier });
  } catch (err) {
    logger.error({ err }, "SA create supplier failed");
    return res.status(500).json({ error: "Failed to create supplier" });
  }
});

// PATCH /superadmin/content/suppliers/:id
router.patch("/content/suppliers/:id", async (req, res) => {
  const id = String(req.params["id"]);
  const parsed = supplierUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const updateData: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
    if (parsed.data.rating != null) updateData["rating"] = String(parsed.data.rating);
    const [supplier] = await db
      .update(platformSuppliersTable)
      .set(updateData)
      .where(eq(platformSuppliersTable.id, id))
      .returning();
    if (!supplier) return res.status(404).json({ error: "Not found" });
    return res.json({ supplier });
  } catch (err) {
    logger.error({ err }, "SA update supplier failed");
    return res.status(500).json({ error: "Failed to update supplier" });
  }
});

// DELETE /superadmin/content/suppliers/:id
router.delete("/content/suppliers/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    await db.delete(platformSuppliersTable).where(eq(platformSuppliersTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete supplier failed");
    return res.status(500).json({ error: "Failed to delete supplier" });
  }
});

// ── Order Status Display Config ───────────────────────────────────────────────
import { platformOrderStatusesTable } from "@workspace/db";

const orderStatusCreateSchema = z.object({
  statusKey:      z.string().min(1).max(64),
  labelEn:        z.string().min(1).max(100),
  labelAr:        z.string().max(100).optional(),
  labelKu:        z.string().max(100).optional(),
  dotColor:       z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#6B7280"),
  badgeBgColor:   z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#F3F4F6"),
  badgeTextColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#374151"),
  iconName:       z.string().min(1).max(100).default("clock-outline"),
  iconBgColor:    z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#F3F4F6"),
  iconColor:      z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#6B7280"),
  isActive:       z.boolean().default(true),
  displayOrder:   z.number().int().default(0),
});

const orderStatusUpdateSchema = orderStatusCreateSchema.partial();

// GET /superadmin/content/order-statuses
router.get("/content/order-statuses", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(platformOrderStatusesTable)
      .orderBy(asc(platformOrderStatusesTable.displayOrder), asc(platformOrderStatusesTable.labelEn));
    return res.json({ statuses: rows });
  } catch (err) {
    logger.error({ err }, "SA list order-statuses failed");
    return res.status(500).json({ error: "Failed to list order statuses" });
  }
});

// POST /superadmin/content/order-statuses
router.post("/content/order-statuses", async (req, res) => {
  const parsed = orderStatusCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const [row] = await db.insert(platformOrderStatusesTable).values(parsed.data).returning();
    return res.status(201).json({ status: row });
  } catch (err) {
    logger.error({ err }, "SA create order-status failed");
    return res.status(500).json({ error: "Failed to create order status" });
  }
});

// PATCH /superadmin/content/order-statuses/:id
router.patch("/content/order-statuses/:id", async (req, res) => {
  const id = String(req.params["id"]);
  const parsed = orderStatusUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const [row] = await db
      .update(platformOrderStatusesTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(platformOrderStatusesTable.id, id))
      .returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ status: row });
  } catch (err) {
    logger.error({ err }, "SA update order-status failed");
    return res.status(500).json({ error: "Failed to update order status" });
  }
});

// DELETE /superadmin/content/order-statuses/:id
router.delete("/content/order-statuses/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    await db.delete(platformOrderStatusesTable).where(eq(platformOrderStatusesTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete order-status failed");
    return res.status(500).json({ error: "Failed to delete order status" });
  }
});

// ── RFQ Status Display Config ─────────────────────────────────────────────────
import {
  platformRfqStatusesTable, platformWishlistCategoriesTable,
  platformRecentlyViewedProductsTable,
} from "@workspace/db";

const rfqStatusCreateSchema = z.object({
  statusKey:      z.string().min(1).max(64),
  labelEn:        z.string().min(1).max(100),
  labelAr:        z.string().max(100).optional(),
  labelKu:        z.string().max(100).optional(),
  dotColor:       z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#6B7280"),
  badgeBgColor:   z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#F3F4F6"),
  badgeTextColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#374151"),
  iconName:       z.string().min(1).max(100).default("file-document-outline"),
  iconBgColor:    z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#F3F4F6"),
  iconColor:      z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#6B7280"),
  dateLabel:      z.string().max(60).optional(),
  isActive:       z.boolean().default(true),
  displayOrder:   z.number().int().default(0),
});
const rfqStatusUpdateSchema = rfqStatusCreateSchema.partial();

router.get("/content/rfq-statuses", async (_req, res) => {
  try {
    const rows = await db.select().from(platformRfqStatusesTable)
      .orderBy(asc(platformRfqStatusesTable.displayOrder), asc(platformRfqStatusesTable.labelEn));
    return res.json({ statuses: rows });
  } catch (err) {
    logger.error({ err }, "SA list rfq-statuses failed");
    return res.status(500).json({ error: "Failed to list RFQ statuses" });
  }
});

router.post("/content/rfq-statuses", async (req, res) => {
  const parsed = rfqStatusCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const [row] = await db.insert(platformRfqStatusesTable).values(parsed.data).returning();
    return res.status(201).json({ status: row });
  } catch (err) {
    logger.error({ err }, "SA create rfq-status failed");
    return res.status(500).json({ error: "Failed to create RFQ status" });
  }
});

router.patch("/content/rfq-statuses/:id", async (req, res) => {
  const id = String(req.params["id"]);
  const parsed = rfqStatusUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const [row] = await db.update(platformRfqStatusesTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(platformRfqStatusesTable.id, id)).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ status: row });
  } catch (err) {
    logger.error({ err }, "SA update rfq-status failed");
    return res.status(500).json({ error: "Failed to update RFQ status" });
  }
});

router.delete("/content/rfq-statuses/:id", async (req, res) => {
  const id = String(req.params["id"]);
  try {
    await db.delete(platformRfqStatusesTable).where(eq(platformRfqStatusesTable.id, id));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete rfq-status failed");
    return res.status(500).json({ error: "Failed to delete RFQ status" });
  }
});

// ── Wishlist Category Tabs ────────────────────────────────────────────────────

const wishlistCategoryCreateSchema = z.object({
  marketplaceCategoryId: z.string().uuid().nullable().optional(),
  labelEn: z.string().min(1).max(100),
  labelAr: z.string().max(100).optional(),
  labelKu: z.string().max(100).optional(),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().default(0),
});
const wishlistCategoryUpdateSchema = wishlistCategoryCreateSchema.partial();

router.get("/content/wishlist-categories", async (_req, res) => {
  try {
    const categories = await db.select().from(platformWishlistCategoriesTable)
      .orderBy(asc(platformWishlistCategoriesTable.displayOrder), asc(platformWishlistCategoriesTable.labelEn));
    return res.json({ categories });
  } catch (err) {
    logger.error({ err }, "SA list wishlist categories failed");
    return res.status(500).json({ error: "Failed to list wishlist categories" });
  }
});

router.post("/content/wishlist-categories", async (req, res) => {
  const parsed = wishlistCategoryCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const [category] = await db.insert(platformWishlistCategoriesTable).values(parsed.data).returning();
    return res.status(201).json({ category });
  } catch (err) {
    logger.error({ err }, "SA create wishlist category failed");
    return res.status(500).json({ error: "Failed to create wishlist category" });
  }
});

router.patch("/content/wishlist-categories/:id", async (req, res) => {
  const parsed = wishlistCategoryUpdateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const [category] = await db.update(platformWishlistCategoriesTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(platformWishlistCategoriesTable.id, String(req.params["id"]))).returning();
    if (!category) return res.status(404).json({ error: "Not found" });
    return res.json({ category });
  } catch (err) {
    logger.error({ err }, "SA update wishlist category failed");
    return res.status(500).json({ error: "Failed to update wishlist category" });
  }
});

router.delete("/content/wishlist-categories/:id", async (req, res) => {
  try {
    await db.delete(platformWishlistCategoriesTable)
      .where(eq(platformWishlistCategoriesTable.id, String(req.params["id"])));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete wishlist category failed");
    return res.status(500).json({ error: "Failed to delete wishlist category" });
  }
});

// ── Recently Viewed curated products ──────────────────────────────────────────
const recentlyViewedProductSchema = z.object({
  productId: z.string().uuid(),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().default(0),
});

router.get("/content/recently-viewed-products", async (_req, res) => {
  try {
    const rows = await db.select().from(platformRecentlyViewedProductsTable)
      .orderBy(asc(platformRecentlyViewedProductsTable.displayOrder));
    return res.json({ products: rows });
  } catch (err) {
    logger.error({ err }, "SA list recently viewed products failed");
    return res.status(500).json({ error: "Failed to list recently viewed products" });
  }
});

router.post("/content/recently-viewed-products", async (req, res) => {
  const parsed = recentlyViewedProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const [row] = await db.insert(platformRecentlyViewedProductsTable).values(parsed.data).returning();
    return res.status(201).json({ product: row });
  } catch (err) {
    logger.error({ err }, "SA create recently viewed product failed");
    return res.status(500).json({ error: "Failed to create recently viewed product" });
  }
});

router.patch("/content/recently-viewed-products/:id", async (req, res) => {
  const parsed = recentlyViewedProductSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(422).json({ error: "Validation failed", issues: parsed.error.issues });
  try {
    const [row] = await db.update(platformRecentlyViewedProductsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(platformRecentlyViewedProductsTable.id, String(req.params["id"]))).returning();
    if (!row) return res.status(404).json({ error: "Not found" });
    return res.json({ product: row });
  } catch (err) {
    logger.error({ err }, "SA update recently viewed product failed");
    return res.status(500).json({ error: "Failed to update recently viewed product" });
  }
});

router.delete("/content/recently-viewed-products/:id", async (req, res) => {
  try {
    await db.delete(platformRecentlyViewedProductsTable)
      .where(eq(platformRecentlyViewedProductsTable.id, String(req.params["id"])));
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "SA delete recently viewed product failed");
    return res.status(500).json({ error: "Failed to delete recently viewed product" });
  }
});
