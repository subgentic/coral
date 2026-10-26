# movecheck: prove a Go refactor only moved code

A file split is "move-only" when every top-level declaration (function, method, type, const, var) is still there with the same text, only in another file. Reading a diff cannot prove that for a thousand moved lines; this can.

```
cd tests/refactor/movecheck
go run . -repo ../../.. -old origin/main -new HEAD -paths coral-go/internal/store
go run . -repo ../../.. -old origin/main -new WORKTREE -paths coral-go/internal/store   # the uncommitted files
```

- `-old` and `-new` are git revisions; `WORKTREE` is the files on disk. `-paths` limits the comparison to folders (comma-separated, relative to the repository root); `-skip-tests` leaves out `_test.go` files.
- It compares multisets of declarations by identity (folder, package, build constraints, kind, names) and exact text from the doc comment to the closing brace, so file placement, file order and import blocks do not matter, and line endings are normalised. A const group with `iota` is one declaration: splitting it is not a move.
- Exit 0: the same declarations everywhere. Exit 1: it prints each `CHANGED` (with the first differing line), `MISSING` and `ADDED` declaration. Exit 2: a usage or git error.
- It reads the repository through one `git cat-file --batch` process: the whole tree takes about a second.

A real example: the "moves only" commit `4595e7742` (#4998, the board store and routes split) passes (`-old 4595e7742~1 -new 4595e7742`: 14,671 declarations the same).

Use it as the proof in a split commit's message ("movecheck: ok, N declarations") next to `go vet` for GOOS=darwin, linux and windows in both tag sets. It does not prove behaviour is unchanged for a rewrite: it exists to show that nothing but placement changed. Its own tests: `go test ./...` in this folder (a real move passes; a one-character body change, a doc-comment change, a dropped function and a split const group fail; platform files, several `init`s, CRLF, `-paths` and `WORKTREE` are covered).
