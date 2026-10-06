---
'@lorepack/parsers': patch
'@lorepack/connect-clients': patch
---

Replace Mammoth's vulnerable `sprintf-js` path with the dependency-free `argparse@2.0.1`
override and upgrade `smol-toml` to 1.9.0, which clears the production audit advisories.
