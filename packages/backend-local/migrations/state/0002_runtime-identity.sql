CREATE TABLE runtime_identity (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  corpus_id    TEXT NOT NULL,
  namespace_id TEXT NOT NULL
) STRICT;

INSERT INTO runtime_identity (id, corpus_id, namespace_id)
VALUES (1, 'corpus_' || lower(hex(randomblob(16))),
           'namespace_' || lower(hex(randomblob(16))));
