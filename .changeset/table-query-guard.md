---
'@lorepack/cli': patch
---

Table queries now pass a shared statement guard on every backend before they run. It admits only
the requested table, common table expressions over it and subqueries, so a query can neither read
nor detect another table. The Cloudflare Worker additionally refuses recursive common table
expressions, table-valued JSON functions, aggregates used as windows, and joins whose row product
exceeds a bound, because D1 cannot be interrupted before its own time limit.
