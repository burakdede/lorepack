-- The page a chunk is on (#241).
--
-- `nodes` could already carry a page inside its `metadata` blob, and the PDF parser wrote one
-- there. `chunks` could not, and search hits, context items and export citations are all built
-- from chunks. So the page reached the node table and stopped, and every citation of a PDF
-- named the file and then a line number of 1, which is not where the text is.
--
-- Nullable, because most formats have no such thing. A Markdown chunk has a line range and no
-- page, and inventing either is what this column exists to stop.

ALTER TABLE chunks ADD COLUMN page INTEGER;
