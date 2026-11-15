//go:build !windows

package background

import (
	"path/filepath"
	"syscall"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A umask of 002 (most Linux users' default; epoch's) makes git's worktree group-writable: the ticked job's run folder is still trusted, once the folder is made not writable by others.
func TestATickedJobTrustsItsRunsFolderUnderAGroupWritableUmask(t *testing.T) {
	old := syscall.Umask(0o002)
	t.Cleanup(func() { syscall.Umask(old) })
	_, during, run, _, _ := trustRunFixture(t, 1)
	r := run()
	require.NotNil(t, r.WorktreePath)
	assert.Contains(t, *during, filepath.Base(*r.WorktreePath), "the run's own folder was trusted although git made it group-writable")
	assert.Contains(t, *during, `"hasTrustDialogAccepted": true`)
}
