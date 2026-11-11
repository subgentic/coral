package config

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestTierValues verifies the compile-time tier configuration.
// Run with different build tags to test each tier:
//
//	go test ./internal/config/ -run TestTier           → prod tier
//	go test -tags dev ./internal/config/ -run TestTier  → dev tier
//	go test -tags beta ./internal/config/ -run TestTier → prod tier (the beta tier is gone, #15075)
func TestTierValues(t *testing.T) {
	t.Logf("TierName=%s SkipEULA=%v ChecksForUpdates=%v", TierName, TierSkipEULA, TierChecksForUpdates)

	switch TierName {
	case "prod", "staging":
		assert.False(t, TierSkipEULA, "prod: EULA should be required")
		assert.True(t, TierChecksForUpdates, "prod: checks for a newer release")
	case "dev":
		assert.True(t, TierSkipEULA, "dev: EULA should be skipped")
		assert.False(t, TierChecksForUpdates, "dev: no update check")
	default:
		t.Fatalf("unexpected TierName: %s", TierName)
	}
}

// #78 W2: only a dev build may open the app window's DevTools; every release tier (prod, staging) keeps them closed.
func TestOnlyADevBuildHasDevTools(t *testing.T) {
	assert.Equal(t, TierName == "dev", TierDevTools, "tier %s", TierName)
}

func TestEULARequired(t *testing.T) {
	switch TierName {
	case "dev":
		assert.False(t, EULARequired(), "dev: EULA not required")
	case "prod", "staging":
		assert.True(t, EULARequired(), "prod: EULA required")
	}
}

// #15075: the beta and dropboxers tiers are gone. No tier file names them, so a stale -tags beta / -tags dropboxers (an old script, an old CI line) compiles the PROD tier: the terms
// required, the update check on. A build that quietly skipped the terms would be the unsafe way to fail.
func TestOnlyProdDevAndStagingTiersExist(t *testing.T) {
	files, err := filepath.Glob("tier_*.go")
	require.NoError(t, err)
	var names []string
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		names = append(names, f)
		src, err := os.ReadFile(f)
		require.NoError(t, err)
		first, _, _ := strings.Cut(string(src), "\n")
		assert.NotContains(t, first, "beta", f)
		assert.NotContains(t, first, "dropboxers", f)
	}
	sort.Strings(names)
	assert.Equal(t, []string{"tier_dev.go", "tier_prod.go", "tier_staging.go"}, names)
}
