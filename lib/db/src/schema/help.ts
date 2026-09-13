// Help Center — schema
// Articles (knowledge base) + Support Requests (user → LinQi)

import { pgTable, pgEnum, uuid, text, varchar, integer, timestamp } from "drizzle-orm/pg-core";

// ── Enums ──────────────────────────────────────────────────────────────────────

export const helpArticleScopeEnum   = pgEnum("help_article_scope",       ["seller", "buyer", "shared"]);
export const helpArticleStatusEnum  = pgEnum("help_article_status",      ["published", "draft"]);
export const supportRequestStatusEnum = pgEnum("support_request_status", ["open", "in_progress", "resolved", "closed"]);

// ── Help Articles ─────────────────────────────────────────────────────────────
//
// actorScope: 'seller' — visible only to sellers
//             'buyer'  — visible only to buyers
//             'shared' — visible to all authenticated users

export const helpArticlesTable = pgTable("help_articles", {
  id:         uuid("id").primaryKey().defaultRandom(),
  category:   varchar("category",   { length: 100 }).notNull(),
  actorScope: helpArticleScopeEnum("actor_scope").notNull().default("shared"),
  titleEn:    text("title_en").notNull(),
  titleAr:    text("title_ar").notNull(),
  titleKu:    text("title_ku").notNull(),
  contentEn:  text("content_en").notNull(),
  contentAr:  text("content_ar").notNull(),
  contentKu:  text("content_ku").notNull(),
  status:     helpArticleStatusEnum("status").notNull().default("published"),
  sortOrder:  integer("sort_order").notNull().default(0),
  // Set when an article is published.  Nullable preserves the availability of
  // the historical seeded articles, which predate publication timestamps.
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Support Requests ──────────────────────────────────────────────────────────
//
// Buyer/Seller → LinQi only. Never Buyer ↔ Seller.
// companyId/userId derived from JWT — never trusted from client input.

export const supportRequestsTable = pgTable("support_requests", {
  id:        uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  userId:    uuid("user_id").notNull(),
  actorType: varchar("actor_type", { length: 20 }).notNull(), // 'seller' | 'buyer'
  subject:   text("subject").notNull(),
  category:  varchar("category",  { length: 100 }).notNull(),
  status:    supportRequestStatusEnum("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Support Request Messages ───────────────────────────────────────────────────
//
// senderRole 'user'        — company user message
//            'linqi_admin' — LinQi support response

export const supportRequestMessagesTable = pgTable("support_request_messages", {
  id:           uuid("id").primaryKey().defaultRandom(),
  requestId:    uuid("request_id").notNull().references(() => supportRequestsTable.id, { onDelete: "cascade" }),
  senderUserId: uuid("sender_user_id"),  // null for LinQi admin messages
  senderRole:   varchar("sender_role",   { length: 20 }).notNull(), // 'user' | 'linqi_admin'
  message:      text("message").notNull(),
  createdAt:    timestamp("created_at",  { withTimezone: true }).notNull().defaultNow(),
});
