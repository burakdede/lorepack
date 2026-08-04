-- The typed-table catalog (architecture section 8.4).
--
-- Physical tables are created at import time with generated names, so they cannot appear
-- here. What can, and does, is the mapping from a stable Lore table id to the physical name,
-- which is the only place the two are connected. Nothing else in the system is allowed to
-- take a SQL identifier from user content.

CREATE TABLE tables (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL REFERENCES artifacts (id),
  name          TEXT NOT NULL,
  sheet         TEXT,
  -- The generated physical table, validated against a strict identifier pattern before it
  -- is ever interpolated into DDL or a query.
  sql_name      TEXT NOT NULL UNIQUE,
  row_count     INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  line_start    INTEGER,
  line_end      INTEGER,
  metadata      TEXT NOT NULL
) STRICT;

-- Ordinal is stored rather than implied by rowid: `describeTable` must return columns in the
-- order the source declared them, and a query plan is free to return rows in any order.
CREATE TABLE table_columns (
  table_id          TEXT NOT NULL REFERENCES tables (id),
  ordinal           INTEGER NOT NULL,
  name              TEXT NOT NULL,
  sql_name          TEXT NOT NULL,
  type              TEXT NOT NULL,
  nullable          INTEGER NOT NULL,
  null_count        INTEGER NOT NULL,
  distinct_estimate INTEGER NOT NULL,
  distinct_is_exact INTEGER NOT NULL,
  -- Stored as text regardless of the column's type. A STRICT table needs one storage class
  -- per column, and these hold numbers, dates and strings depending on the row. They are
  -- reported, never compared, so text is the honest choice.
  min_value         TEXT,
  max_value         TEXT,
  PRIMARY KEY (table_id, ordinal)
) STRICT;

CREATE INDEX tables_artifact ON tables (artifact_id);
