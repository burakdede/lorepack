---
'@lorepack/cli': patch
---

Fix Lore Studio's Overview crashing with `Cannot read properties of undefined (reading 'map')`
after visiting Sources. A route that fails to render now shows the error inside Studio, with
the sidebar still usable, instead of replacing the whole app.
