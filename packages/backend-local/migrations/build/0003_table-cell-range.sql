-- The cell range a table was read from (#235).
--
-- `tables` already stores the rest of the locator as columns: relative_path, sheet,
-- line_start, line_end. The cell range was the one part left out, so it survived only inside
-- the parser-defined `metadata` blob and `describeTable` returned a locator naming a file
-- rather than a range. Architecture section 10.8 is explicit that a queried row traces back to
-- a sheet and a cell range, so this belongs beside the other locator parts rather than behind
-- a key one parser happens to write.
--
-- Nullable, because most tables have no such thing. A CSV file is one table with no cell
-- range, and reporting an invented one would be worse than reporting none.

ALTER TABLE tables ADD COLUMN cell_range TEXT;
