-- Mutable project state. Never part of a build: sealed build databases are read-only,
-- and everything here is operational rather than canonical (architecture section 11.1).

CREATE TABLE builds (
  build_id   TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  artifacts  INTEGER NOT NULL DEFAULT 0,
  nodes      INTEGER NOT NULL DEFAULT 0,
  chunks     INTEGER NOT NULL DEFAULT 0,
  tables_    INTEGER NOT NULL DEFAULT 0,
  table_rows INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Exactly one row, enforced by the primary key check. The generation is monotonic and
-- never repeats, including after a rollback, so a reader can detect a change by comparing
-- a single integer.
CREATE TABLE active_build (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  build_id       TEXT REFERENCES builds (build_id),
  generation     INTEGER NOT NULL DEFAULT 0,
  activated_at   TEXT
) STRICT;

INSERT INTO active_build (id, build_id, generation, activated_at) VALUES (1, NULL, 0, NULL);

-- Wall-clock and machine facts, deliberately outside the build so two machines can agree
-- on a build id while disagreeing about how long it took (architecture section 11.7).
CREATE TABLE build_receipts (
  build_id          TEXT PRIMARY KEY REFERENCES builds (build_id),
  started_at        TEXT NOT NULL,
  completed_at      TEXT NOT NULL,
  duration_ms       INTEGER NOT NULL,
  reused_artifacts  INTEGER NOT NULL,
  rebuilt_artifacts INTEGER NOT NULL,
  platform          TEXT NOT NULL,
  node_version      TEXT NOT NULL
) STRICT;

CREATE INDEX builds_created_at ON builds (created_at DESC);
