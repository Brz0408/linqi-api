/**
 * Public Legal Content Endpoint — no auth required
 * Task #478
 *
 * GET /api/content/legal/:type?lang=en
 *
 *   type: "terms_and_conditions" | "about_linqi"
 *   lang: "en" | "ar" | "ku"  (defaults to "en")
 *
 * Returns the currently published/effective document for that type.
 * Returns 404 with code LEGAL_CONTENT_NOT_PUBLISHED if none exists.
 * Never exposes drafts or all translations — only the requested language.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db.js";
import { legalDocumentsTable, legalDocSectionsTable, helpArticlesTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { eq, and, isNull, lte, or, asc, desc } from "drizzle-orm";

const router = Router();

// Only document types that exist in the legalDocTypeEnum DB enum are safe to query.
const publicDocTypeSchema = z.enum([
  "terms_and_conditions",
  "privacy_policy",
  "seller_agreement",
  "buyer_terms",
  "marketplace_terms",
  "commission_agreement",
  "advertising_agreement",
  "return_policy",
  "payment_terms",
  "about_linqi",
  "other",
]);
const langSchema = z.enum(["en", "ar", "ku"]).default("en");
type Language = z.infer<typeof langSchema>;

function requestedLanguage(req: Request, res: Response): Language | null {
  const parsed = langSchema.safeParse(req.query["lang"]);
  if (!parsed.success) {
    res.status(400).json({
      error: "Unsupported language. Expected en, ar, or ku",
      code: "UNSUPPORTED_LANGUAGE",
    });
    return null;
  }
  return parsed.data;
}

type LocalizedContent = {
  title: string;
  content: string;
  language: Language;
};

/**
 * Select a complete translation rather than returning an empty requested
 * field.  English is the canonical fallback, followed by the other supported
 * languages so every response identifies the language actually returned.
 */
function localizeContent(
  row: Record<string, unknown>,
  requested: Language,
  titleFields: Record<Language, string>,
  contentFields: Record<Language, string>,
): LocalizedContent | null {
  const order = [requested, "en", "ar", "ku"] as Language[];
  for (const language of order.filter((value, index) => order.indexOf(value) === index)) {
    const title = String(row[titleFields[language]] ?? "").trim();
    const content = String(row[contentFields[language]] ?? "").trim();
    if (title && content) return { title, content, language };
  }
  return null;
}

const legalTitleFields: Record<Language, string> = {
  en: "titleEn", ar: "titleAr", ku: "titleKu",
};
const legalContentFields: Record<Language, string> = {
  en: "contentEn", ar: "contentAr", ku: "contentKu",
};

// ── GET /legal/doc/:id ─────────────────────────────────────────────────────
// Fetches a specific published document by its UUID. Used by the portal acceptance
// gate so it always displays the exact document version the user is accepting.

router.get("/legal/doc/:id", async (req, res) => {
  const id = String(req.params["id"]);
  const lang = requestedLanguage(req, res);
  if (!lang) return;

  try {
    const [doc] = await db
      .select()
      .from(legalDocumentsTable)
      .where(
        and(
          eq(legalDocumentsTable.id, id),
          eq(legalDocumentsTable.status, "published"),
          or(
            isNull(legalDocumentsTable.effectiveAt),
            lte(legalDocumentsTable.effectiveAt, new Date()),
          ),
        ),
      )
      .orderBy(desc(legalDocumentsTable.publishedAt), desc(legalDocumentsTable.effectiveAt), desc(legalDocumentsTable.updatedAt))
      .limit(1);

    if (!doc) {
      res.status(404).json({
        error: "Document not found or not yet effective",
        code: "LEGAL_CONTENT_NOT_PUBLISHED",
      });
      return;
    }

    const localized = localizeContent(doc as unknown as Record<string, unknown>, lang, legalTitleFields, legalContentFields);
    if (!localized) {
      res.status(503).json({
        error: "Published legal document has no usable translation",
        code: "LEGAL_CONTENT_UNAVAILABLE",
      });
      return;
    }

    res.json({
      document: {
        id:           doc.id,
        documentType: doc.documentType,
        version:      doc.version,
        title:        localized.title,
        content:      localized.content,
        effectiveAt:  doc.effectiveAt,
        publishedAt:  doc.publishedAt,
        language:     localized.language,
        requestedLanguage: lang,
        fallbackLanguage: localized.language === lang ? null : localized.language,
      },
    });
  } catch (err) {
    logger.error({ err }, "Public legal doc-by-id fetch failed");
    res.status(500).json({ error: "Failed to load legal document" });
  }
});

router.get("/legal/:type", async (req, res) => {
  const typeResult = publicDocTypeSchema.safeParse(req.params["type"]);
  if (!typeResult.success) {
    res.status(404).json({
      error: "Document type not found",
      code: "LEGAL_CONTENT_NOT_PUBLISHED",
    });
    return;
  }

  const lang = requestedLanguage(req, res);
  if (!lang) return;

  try {
    const [doc] = await db
      .select()
      .from(legalDocumentsTable)
      .where(
        and(
          eq(legalDocumentsTable.documentType, typeResult.data),
          eq(legalDocumentsTable.status, "published"),
          or(
            isNull(legalDocumentsTable.effectiveAt),
            lte(legalDocumentsTable.effectiveAt, new Date()),
          ),
        ),
      )
      .orderBy(desc(legalDocumentsTable.publishedAt), desc(legalDocumentsTable.effectiveAt), desc(legalDocumentsTable.updatedAt))
      .limit(1);

    if (!doc) {
      res.status(404).json({
        error: "No published document found for this type",
        code: "LEGAL_CONTENT_NOT_PUBLISHED",
      });
      return;
    }

    const localized = localizeContent(doc as unknown as Record<string, unknown>, lang, legalTitleFields, legalContentFields);
    if (!localized) {
      res.status(503).json({
        error: "Published legal document has no usable translation",
        code: "LEGAL_CONTENT_UNAVAILABLE",
      });
      return;
    }

    res.json({
      document: {
        id:           doc.id,
        documentType: doc.documentType,
        version:      doc.version,
        title:        localized.title,
        content:      localized.content,
        effectiveAt:  doc.effectiveAt,
        publishedAt:  doc.publishedAt,
        language:     localized.language,
        requestedLanguage: lang,
        fallbackLanguage: localized.language === lang ? null : localized.language,
      },
    });
  } catch (err) {
    logger.error({ err }, "Public legal content fetch failed");
    res.status(500).json({ error: "Failed to load legal document" });
  }
});

// ── GET /legal/:type/sections ─────────────────────────────────────────────────
// Returns the structured sections of a published document in the requested lang.

router.get("/legal/:type/sections", async (req, res) => {
  const typeResult = publicDocTypeSchema.safeParse(req.params["type"]);
  if (!typeResult.success) {
    res.status(404).json({
      error: "Document type not found",
      code: "LEGAL_CONTENT_NOT_PUBLISHED",
    });
    return;
  }

  const lang = requestedLanguage(req, res);
  if (!lang) return;

  try {
    const [doc] = await db
      .select({ id: legalDocumentsTable.id, documentType: legalDocumentsTable.documentType, version: legalDocumentsTable.version })
      .from(legalDocumentsTable)
      .where(
        and(
          eq(legalDocumentsTable.documentType, typeResult.data),
          eq(legalDocumentsTable.status, "published"),
          or(
            isNull(legalDocumentsTable.effectiveAt),
            lte(legalDocumentsTable.effectiveAt, new Date()),
          ),
        ),
      )
      .orderBy(desc(legalDocumentsTable.publishedAt), desc(legalDocumentsTable.effectiveAt), desc(legalDocumentsTable.updatedAt))
      .limit(1);

    if (!doc) {
      res.status(404).json({
        error: "No published document found for this type",
        code: "LEGAL_CONTENT_NOT_PUBLISHED",
      });
      return;
    }

    const sections = await db
      .select()
      .from(legalDocSectionsTable)
      .where(eq(legalDocSectionsTable.legalDocumentId, doc.id))
      .orderBy(legalDocSectionsTable.displayOrder);

    const localizedSections = sections.map((s) => {
      const localized = localizeContent(
        s as unknown as Record<string, unknown>,
        lang,
        { en: "titleEn", ar: "titleAr", ku: "titleKu" },
        { en: "contentEn", ar: "contentAr", ku: "contentKu" },
      );
      return localized ? {
        sectionKey: s.sectionKey,
        displayOrder: s.displayOrder,
        title: localized.title,
        content: localized.content,
        language: localized.language,
      } : null;
    });
    if (localizedSections.some((section) => section === null)) {
      res.status(503).json({
        error: "Published legal document has sections without usable translations",
        code: "LEGAL_CONTENT_UNAVAILABLE",
      });
      return;
    }

    res.json({
      documentId:   doc.id,
      documentType: doc.documentType,
      version:      doc.version,
      requestedLanguage: lang,
      language: localizedSections[0]?.language ?? lang,
      fallbackLanguage: localizedSections[0] && localizedSections[0].language !== lang
        ? localizedSections[0].language
        : null,
      sections: localizedSections,
    });
  } catch (err) {
    logger.error({ err }, "Public legal sections fetch failed");
    res.status(500).json({ error: "Failed to load legal sections" });
  }
});

// ── GET /legal/doc/:id/sections ───────────────────────────────────────────────
// Returns the structured sections of a specific published document by its UUID.
// Used by the /terms page when opened via a document-ID link so the exact
// gated version is shown rather than whatever is the latest published version.

router.get("/legal/doc/:id/sections", async (req, res) => {
  const id = String(req.params["id"]);
  const lang = requestedLanguage(req, res);
  if (!lang) return;

  try {
    const [doc] = await db
      .select({ id: legalDocumentsTable.id, documentType: legalDocumentsTable.documentType, version: legalDocumentsTable.version })
      .from(legalDocumentsTable)
      .where(
        and(
          eq(legalDocumentsTable.id, id),
          eq(legalDocumentsTable.status, "published"),
          or(
            isNull(legalDocumentsTable.effectiveAt),
            lte(legalDocumentsTable.effectiveAt, new Date()),
          ),
        ),
      )
      .orderBy(desc(legalDocumentsTable.publishedAt), desc(legalDocumentsTable.effectiveAt), desc(legalDocumentsTable.updatedAt))
      .limit(1);

    if (!doc) {
      res.status(404).json({
        error: "Document not found or not yet effective",
        code: "LEGAL_CONTENT_NOT_PUBLISHED",
      });
      return;
    }

    const sections = await db
      .select()
      .from(legalDocSectionsTable)
      .where(eq(legalDocSectionsTable.legalDocumentId, doc.id))
      .orderBy(legalDocSectionsTable.displayOrder);

    const localizedSections = sections.map((s) => {
      const localized = localizeContent(
        s as unknown as Record<string, unknown>,
        lang,
        { en: "titleEn", ar: "titleAr", ku: "titleKu" },
        { en: "contentEn", ar: "contentAr", ku: "contentKu" },
      );
      return localized ? {
        sectionKey: s.sectionKey,
        displayOrder: s.displayOrder,
        title: localized.title,
        content: localized.content,
        language: localized.language,
      } : null;
    });
    if (localizedSections.some((section) => section === null)) {
      res.status(503).json({
        error: "Published legal document has sections without usable translations",
        code: "LEGAL_CONTENT_UNAVAILABLE",
      });
      return;
    }

    res.json({
      documentId:   doc.id,
      documentType: doc.documentType,
      version:      doc.version,
      requestedLanguage: lang,
      language: localizedSections[0]?.language ?? lang,
      fallbackLanguage: localizedSections[0] && localizedSections[0].language !== lang
        ? localizedSections[0].language
        : null,
      sections: localizedSections,
    });
  } catch (err) {
    logger.error({ err }, "Public legal sections-by-id fetch failed");
    res.status(500).json({ error: "Failed to load legal sections" });
  }
});

// ── Public FAQ content ────────────────────────────────────────────────────────
// FAQ entries use the existing help_articles entity.  Only shared, published,
// currently effective entries are exposed; seller/buyer support articles remain
// behind the authenticated Help Center routes.

const faqPublicWhere = () => and(
  eq(helpArticlesTable.actorScope, "shared"),
  eq(helpArticlesTable.status, "published"),
  or(
    isNull(helpArticlesTable.publishedAt),
    lte(helpArticlesTable.publishedAt, new Date()),
  ),
);

const faqTitleFields: Record<Language, string> = {
  en: "titleEn", ar: "titleAr", ku: "titleKu",
};
const faqContentFields: Record<Language, string> = {
  en: "contentEn", ar: "contentAr", ku: "contentKu",
};

function publicFaq(row: typeof helpArticlesTable.$inferSelect, requested: Language) {
  const localized = localizeContent(
    row as unknown as Record<string, unknown>,
    requested,
    faqTitleFields,
    faqContentFields,
  );
  if (!localized) return null;
  return {
    id: row.id,
    category: row.category,
    title: localized.title,
    content: localized.content,
    sortOrder: row.sortOrder,
    language: localized.language,
    requestedLanguage: requested,
    fallbackLanguage: localized.language === requested ? null : localized.language,
  };
}

async function listPublicFaqs(req: Request, res: Response) {
  const lang = requestedLanguage(req, res);
  if (!lang) return;
  try {
    const rows = await db
      .select()
      .from(helpArticlesTable)
      .where(faqPublicWhere())
      .orderBy(asc(helpArticlesTable.sortOrder), asc(helpArticlesTable.createdAt), asc(helpArticlesTable.id));
    const faqs = rows.map((row) => publicFaq(row, lang));
    if (faqs.some((faq) => faq === null)) {
      res.status(503).json({
        error: "A published FAQ has no usable translation",
        code: "FAQ_CONTENT_UNAVAILABLE",
      });
      return;
    }
    res.json({ requestedLanguage: lang, faqs });
  } catch (err) {
    logger.error({ err }, "Public FAQ list failed");
    res.status(500).json({ error: "Failed to load FAQs" });
  }
}

async function getPublicFaq(req: Request, res: Response) {
  const id = String(req.params["id"]);
  const lang = requestedLanguage(req, res);
  if (!lang) return;
  try {
    const [row] = await db
      .select()
      .from(helpArticlesTable)
      .where(and(eq(helpArticlesTable.id, id), faqPublicWhere()))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "FAQ not found", code: "FAQ_NOT_PUBLISHED" });
      return;
    }
    const faq = publicFaq(row, lang);
    if (!faq) {
      res.status(503).json({
        error: "Published FAQ has no usable translation",
        code: "FAQ_CONTENT_UNAVAILABLE",
      });
      return;
    }
    res.json({ faq });
  } catch (err) {
    logger.error({ err }, "Public FAQ get failed");
    res.status(500).json({ error: "Failed to load FAQ" });
  }
}

// Canonical public FAQ routes. The existing authenticated /help routes remain
// unchanged for actor-scoped support articles.
router.get("/faqs", listPublicFaqs);
router.get("/faqs/:id", getPublicFaq);

export default router;
