# Rendered Markdown text prototype (#13728 / goal #228)

Prototype only, no release target, no application entry point, no save/upload/version route. The portable HTML runs offline after download; Coral's artifact preview intentionally does not run its scripts.

Build from the worktree root:

```sh
(cd coral-go && go run ../tests/prototypes/markdown_text/build.go)
```

Open `scratchpad/13728-markdown-text.html` in a browser. It includes one verified agent-report copy, formatting examples, the existing vendored marked/DOMPurify and the existing `renderMarkdownStrict`, bundled with Coral's existing Go esbuild dependency. No external scripts, new packages or production CSP changes.

The Edit text toggle works at desktop and 390 px. Only exact-mapped rendered text runs become plaintext-only editable spans. Enter/blur applies locally, Escape cancels, Tab applies and moves to the next run. Inserted Markdown syntax is escaped only in the changed slice; surrounding source, BOM and original line endings are retained. A structural/rendered-text check refuses an edit that would alter markup. Reset restores the source bytes. All changes live in memory.

Read-only: tables, fenced code, raw HTML, front matter, images, hidden/bidi characters, nested/indented lists and blocks whose rendered text nodes cannot map one-to-one to lexer text runs. Remote/file images are placeholders in this offline demo. There is no raw-editor fallback. Inline bold/emphasis/link labels/simple code spans work when their text maps exactly.

Tests (the frontend test environment must already have its normal jsdom/CDP dependencies):

```sh
node tests/prototypes/markdown_text/model.test.mjs
node tests/prototypes/markdown_text/measure.mjs tests/prototypes/markdown_text/corpus.json
node tests/prototypes/markdown_text/browser.mjs
```

Measurement reads 30 downloaded immutable copies in the manifest's `file` paths. To restore a missing copy, run `coral-agent artifact download <uri> --output <file>` for that manifest entry, then verify its SHA-256. Do not edit or version the original artifacts. The measurement emits `scratchpad/13728-measurement.json` with per-artifact hashes/counts and UTF-8 byte-splice checks.

Browser tests expect an isolated headless Chrome on localhost CDP port 8894 and create/close their own explicit tab. They load the offline HTML using a file URL, make no HTTP requests, and cover 1280/390 px, native text insertion, Tab focus, BOM/CRLF, marks/URLs, lists, injection-as-text, read-only blocks and overflow. Screenshots go to scratchpad. There is no test web server and no process on :8420.

The later save build must meet Security's #162219 conditions: person-only owner route including Hub enforcement; team/series and upload type/size checks; server-side 409 against the opened version; visible special characters and original encoding/newline preservation. This prototype implements none of that write path.
