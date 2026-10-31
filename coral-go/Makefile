# Coral Go — development build targets
BINDIR ?= bin
CMD_PACKAGES := ./cmd/...

# SQLCipher's bundled codec uses OpenSSL. Override these for a non-Homebrew
# toolchain (Linux CI supplies system libssl-dev).
OPENSSL_PREFIX ?= $(shell brew --prefix openssl@3 2>/dev/null)
CGO_OPENSSL_FLAGS := $(if $(OPENSSL_PREFIX),CGO_CFLAGS="-I$(OPENSSL_PREFIX)/include" CGO_LDFLAGS="-L$(OPENSSL_PREFIX)/lib")

# Sync agent_docs to the static embed dir before any build
.PHONY: sync-docs
sync-docs:
	@../tools/sync-agent-docs.sh

# Local builds leave config.Version empty (no update offers) and report
# "<next patch>-dev+<commit>[.dirty]" instead (in /api/health and to Coral Hub),
# based on the latest release tag. Use make dev / make build to get that base: a
# plain `go build` reports 0.0.0-dev+<commit>, which hubs treat as a very old version.
DEV_BASE := $(shell git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' 2>/dev/null)
DEV_LDFLAGS := -ldflags "-X github.com/subgentic/coral/internal/config.DevBase=$(DEV_BASE)"

# Dev build (skips EULA + license)
.PHONY: dev
dev: sync-docs
	@mkdir -p $(BINDIR)
	$(CGO_OPENSSL_FLAGS) go build -trimpath -tags "dev fts5" $(DEV_LDFLAGS) -o $(BINDIR)/ $(CMD_PACKAGES)

# Production build
.PHONY: build
build: sync-docs
	@mkdir -p $(BINDIR)
	@# the dashboard ships minified (#6208): a fresh owner-only folder, read by this go build only
	@set -e; O="$$(go run ./tools/strip-static)"; [ -n "$$O" ]; trap 'go run ./tools/strip-static -clean "$$O"' EXIT; \
	$(CGO_OPENSSL_FLAGS) go build -trimpath -overlay "$$O" -tags fts5 $(DEV_LDFLAGS) -o $(BINDIR)/ $(CMD_PACKAGES)

# Dev build + run
.PHONY: run
run: dev
	./$(BINDIR)/coral --host 127.0.0.1 --port 8420

# Test server (accessible from other machines, isolated from production data)
.PHONY: test-server
test-server: dev
	CORAL_DATA_DIR=/tmp/coral-test ./$(BINDIR)/coral --host 0.0.0.0 --port 8450

# The go tool hashes its own value of every environment variable a test reads, so an agent shell's per-session CLAUDE_CODE_SESSION_ID or a token in another shell's environment
# would give each shell its own test cache entry (#413). TEST_ENV runs go test without that family (testguard drops it inside the test binary as well, so a test never holds a real credential).
# SHELL and NO_COLOR are hashed too and differ between shells (a Git Bash launched from PowerShell has NO_COLOR=1 and another SHELL): TEST_ENV pins the one and drops the other.
# PATH is hashed the same way and is not pinned (it is machine-specific): run go test from a shell with a stable PATH, and do not let the CDP runner's node prefix leak into a go test shell.
TEST_ENV = env -u NO_COLOR $(addprefix -u ,$(shell env | sed -n -E 's/^((CLAUDE|ANTHROPIC|CODEX|GEMINI|PI)_[A-Za-z0-9_]*)=.*/\1/p')) SHELL=/bin/sh
# On Windows the test folders are made directly in the profile (CORAL_TEST_ROOT, see internal/testtemp): the Go tool resolves the path of every file call a test logs, and a shallower root costs less.
# Windows only: on macOS the tests make Unix sockets below their temp folder and a socket path is limited to 104 bytes.
ifeq ($(OS),Windows_NT)
TEST_ENV += CORAL_TEST_ROOT=$(USERPROFILE)\ct
endif

# Run all tests
.PHONY: test
test: sync-docs
	$(TEST_ENV) go test ./...
	$(TEST_ENV) $(CGO_OPENSSL_FLAGS) go test -tags fts5 ./...

# Race detector on the packages with their own goroutines around process and PTY
# lifetimes (#3320). Slower than `make test`: run before changing session code.
.PHONY: test-race
test-race: sync-docs
	go test -race -timeout 30m ./internal/ptymanager ./internal/cloud/... ./pkg/...

# End-to-end frontend tests (headless Chrome + CDP). Requires node + Chrome.
.PHONY: test-frontend
test-frontend:
	@bash ../tests/frontend/run.sh
