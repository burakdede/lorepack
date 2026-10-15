CREATE TABLE activation_events (
  generation INTEGER PRIMARY KEY,
  previous_build_id TEXT,
  build_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('transition', 'baseline')),
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER record_activation AFTER UPDATE OF build_id ON active_build
WHEN NEW.build_id IS NOT NULL AND OLD.build_id IS NOT NEW.build_id
BEGIN
  INSERT INTO activation_events (generation, previous_build_id, build_id, kind, recorded_at)
  VALUES (NEW.generation, OLD.build_id, NEW.build_id, 'transition',
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

INSERT INTO activation_events (generation, previous_build_id, build_id, kind, recorded_at)
SELECT generation, NULL, build_id, 'baseline', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM active_build WHERE build_id IS NOT NULL;
