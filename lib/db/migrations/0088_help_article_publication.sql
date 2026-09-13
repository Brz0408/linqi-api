-- Help article publication metadata.
--
-- Existing help articles may already be published without a publication
-- timestamp, so the column is deliberately nullable.  Public readers treat a
-- NULL timestamp as immediately effective for backwards compatibility.

ALTER TABLE help_articles
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS help_articles_publication_idx
  ON help_articles (status, published_at, sort_order, created_at, id);