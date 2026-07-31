-- The catalog inside a sealed build. Written once by the compiler, then opened read-only
-- forever. Schema semantics stay close to D1 so the Cloudflare projection is a
-- translation rather than a redesign (architecture section 17.4).

CREATE TABLE artifacts (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL,
  relative_path  TEXT NOT NULL,
  display_path   TEXT NOT NULL,
  media_type     TEXT NOT NULL,
  byte_size      INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  parser_id      TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  title          TEXT,
  status         TEXT NOT NULL,
  authority      INTEGER NOT NULL,
  object_hash    TEXT NOT NULL,
  metadata       TEXT NOT NULL
) STRICT;

CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL REFERENCES artifacts (id),
  parent_id     TEXT REFERENCES nodes (id),
  kind          TEXT NOT NULL,
  ordinal       INTEGER NOT NULL,
  title         TEXT,
  text          TEXT,
  heading_path  TEXT NOT NULL,
  line_start    INTEGER,
  line_end      INTEGER,
  metadata      TEXT NOT NULL,
  revision_hash TEXT NOT NULL
) STRICT;

CREATE TABLE chunks (
  id               TEXT PRIMARY KEY,
  artifact_id      TEXT NOT NULL REFERENCES artifacts (id),
  node_ids         TEXT NOT NULL,
  heading_path     TEXT NOT NULL,
  text             TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  relative_path    TEXT NOT NULL,
  line_start       INTEGER,
  line_end         INTEGER,
  revision_hash    TEXT NOT NULL
) STRICT;

-- Supersession is stored separately so an artifact can supersede several others without
-- an encoded list, which keeps the rule resolution queryable.
CREATE TABLE supersessions (
  artifact_id    TEXT NOT NULL REFERENCES artifacts (id),
  superseded_id  TEXT NOT NULL,
  PRIMARY KEY (artifact_id, superseded_id)
) STRICT;

CREATE TABLE build_warnings (
  id      INTEGER PRIMARY KEY,
  code    TEXT NOT NULL,
  class   TEXT NOT NULL,
  path    TEXT,
  message TEXT NOT NULL
) STRICT;

-- Column layout is fixed by architecture section 12.9. Ranking weights are applied at
-- query time by the runtime and deliberately not stored here: baking them into the index
-- would make retuning ranking a rebuild.
CREATE VIRTUAL TABLE chunks_fts USING fts5 (
  chunk_id UNINDEXED,
  artifact_id UNINDEXED,
  status UNINDEXED,
  authority UNINDEXED,
  path,
  title,
  heading,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE INDEX nodes_artifact ON nodes (artifact_id);
CREATE INDEX nodes_parent ON nodes (parent_id);
CREATE INDEX chunks_artifact ON chunks (artifact_id);
CREATE INDEX artifacts_status ON artifacts (status);
CREATE INDEX artifacts_path ON artifacts (relative_path);
