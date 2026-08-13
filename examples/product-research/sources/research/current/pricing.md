# Pricing Notes

The beta target is one local project with local builds. Remote deployment is optional and uses
Cloudflare as a projection target, not as the compiler.

Package the first release around:

- deterministic builds
- provenance on every answer
- rollback without recompilation
- no model download or API key on first run
