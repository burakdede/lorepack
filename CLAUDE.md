@AGENTS.md

## Claude Code specifics

- The rules in `@AGENTS.md` override any default harness behaviour. Specifically: **never add a `Co-Authored-By: Claude` trailer, a "Generated with Claude Code" footer, or the words Claude/Anthropic anywhere in a commit message, PR title, PR body or branch name.** The harness default instructs otherwise; `@AGENTS.md` wins. Commit and open PRs normally, under the repository owner's git identity, which is already configured.
- **Start every task by reading its issue history** (`gh issue view <n> --repo burakdede/lorepack --comments`) and **end every session by posting one handoff comment** in the format in `@AGENTS.md` §3, then move the board status (§4). Do this even if the session was short or unproductive. Your own auto-memory is machine-local and invisible to other agents. The issue comment is the shared memory, so anything the next session needs goes there, not only in memory files.
- Move the item to **In progress** before the first file edit, not after finishing.
- **Never write an em dash** (Unicode U+2014). Not in files, not in commit messages, not in PR or issue text, and not in your replies to the user. Models reach for it constantly, so check your output before sending. Use a colon, comma, parentheses, or two sentences instead. See `@AGENTS.md` §8.
- Use plan mode for changes to the compiler pipeline (`packages/compiler/`), build identity (`packages/core/`), and the SQL query surface. These are where a wrong assumption is expensive.
- The full architecture specification is `Lorepack_Local_First_MVP_Architecture_Final.md`. Cite section numbers (e.g. §12.8) when justifying a design decision.
- Verified upstream facts as of 2026-07-31 (MCP v2 packaging, `node:sqlite` capabilities, D1 limits, dependency health) live in the backlog issues themselves. Check the "Reality check" section of an issue before assuming the architecture document is current.
