package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/updater/status"
)

// #395: what the updater has staged is offered only when it is newer than what runs. 2.0.1 staged on a Coral at 2.0.3 shows nothing.
func TestAStagedReleaseThatIsNotNewerThanTheInstalledOneIsNotOffered(t *testing.T) {
	for _, tc := range []struct {
		name, staged, installed string
		offered                 bool
	}{
		{"lower (the live case)", "2.0.1", "2.0.3", false},
		{"equal", "2.0.3", "2.0.3", false},
		{"higher", "2.0.4", "2.0.3", true},
		{"lower than a prerelease of a later version", "2.0.3", "2.0.4-rc1", false},
		{"a release over a prerelease of itself", "2.0.3", "2.0.3-rc1", true},
		{"an installed version that is not a version offers what is staged", "1.5.0", "dev", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := recordFrom(status.Out{Installed: tc.installed, Staged: &status.Stage{Version: tc.staged, StagedAt: "2026-10-28T10:00:00Z"}}, relaunchState{}, time.Now())
			if tc.offered {
				if assert.NotNil(t, rec.Staged) {
					assert.Equal(t, tc.staged, rec.Staged.Version)
				}
				assert.Equal(t, updStaged, rec.State)
				return
			}
			assert.Nil(t, rec.Staged, "no banner, no button")
			assert.Equal(t, updNone, rec.State)
			assert.Empty(t, rec.Latest)
		})
	}
}
