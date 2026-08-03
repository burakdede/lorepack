import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';

/**
 * The one place the MCP protocol revision is named.
 *
 * Everything that speaks the protocol, states which revision it speaks, or explains a
 * design decision by citing one, reads this constant. A future SDK bump then changes one
 * line and a test tells you which prose went stale, rather than leaving fifteen comments
 * to drift quietly apart from the wire (#188).
 *
 * ## Why the SDK's own constant is the wrong thing to read
 *
 * `@modelcontextprotocol/server` exports `LATEST_PROTOCOL_VERSION`, and it is
 * `2025-11-25`, which looks authoritative and is not what this server negotiates. That
 * constant, and `SUPPORTED_PROTOCOL_VERSIONS` below it, describe the **handshake era**:
 * the revisions reached through `initialize`, which 2026-07-28 removed. They exist so the
 * SDK can still answer a 2025-era client, and the 2026-07-28 specification requires
 * exactly that backward compatibility.
 *
 * Verified by hand against a running `lore serve` on 2026-08-03, and asserted by
 * `tools/contract/test/protocol-version.test.ts` against the server's own
 * `server/discover` result:
 *
 * - `server/discover` answers `supportedVersions: ["2026-07-28"]`.
 * - A request whose `_meta` names any other revision is refused with
 *   `UnsupportedProtocolVersionError` (`-32022`, the code 2026-07-28 renumbered it to).
 * - `initialize` still answers `2025-11-25`, for a 2025-era client, and that path serves
 *   `tools/list` and `tools/call` correctly.
 *
 * So both eras work, and the modern one is the server's own. Reading `initialize` and
 * concluding the server speaks 2025-11-25 is the mistake #188 was filed for.
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/**
 * The revisions the pinned SDK still answers through the removed `initialize` handshake.
 *
 * Kept as a named export so the drift test can tell a stale mention of a superseded
 * revision apart from an ordinary date, without hardcoding a second list.
 */
export const LEGACY_HANDSHAKE_VERSIONS: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS;
