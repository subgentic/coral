package agentmodels

import (
	"context"
	"errors"
	"os"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// When the CLI's path changes (Settings points at another program, or a stand-in goes away), the list the old program gave is not served: Get answers with the built-in list until a
// fetch for the new path succeeds, and a failed fetch for the new path does not bring the old program's list back.
func TestAnotherCLIPathDropsTheOldProgramsList(t *testing.T) {
	a, b := fakeCLI(t), fakeCLI(t)
	var cur atomic.Value
	cur.Store(a)
	s := NewService(func(string) (string, error) { return cur.Load().(string), nil })
	clock := time.Now()
	s.now = func() time.Time { return clock }
	t.Cleanup(s.Wait)
	s.fetch = func(ctx context.Context, family, path string) ([]Model, string, error) {
		if path == a {
			return []Model{{Value: "default"}, {Value: "opus"}}, "account", nil
		}
		return nil, "", errors.New("this program does not list models")
	}

	s.Get("claude")
	s.Wait()
	require.Equal(t, []string{"default", "opus"}, values(s.Get("claude").Models), "the first program's own list")

	cur.Store(b)
	r := s.Get("claude")
	assert.Equal(t, "builtin", r.Source, "another program: the built-in list at once, not the first program's")
	assert.True(t, r.Refreshing, "and a fetch for the new program started")
	s.Wait()
	r = s.Get("claude")
	assert.Equal(t, "builtin", r.Source, "the new program's fetch failed: still the built-in list, never the first program's")
	assert.NotContains(t, values(r.Models), "default")
	assert.NotEmpty(t, r.Error, "and it says the listing failed")
}

// A new build of the same program (its time or size changed) keeps its list while the new build is asked: only another path drops it.
func TestANewBuildOfTheSameCLIKeepsItsListWhileItRefetches(t *testing.T) {
	path := fakeCLI(t)
	release := make(chan struct{})
	first := true
	s, _ := newTestService(t, path, func(ctx context.Context, family, p string) ([]Model, string, error) {
		if first {
			first = false
			return []Model{{Value: "opus"}}, "account", nil
		}
		<-release
		return []Model{{Value: "opus"}, {Value: "sonnet"}}, "account", nil
	})
	s.Get("claude")
	s.Wait()
	later := time.Now().Add(time.Hour)
	require.NoError(t, os.Chtimes(path, later, later))
	r := s.Get("claude")
	assert.Equal(t, []string{"opus"}, values(r.Models), "the same program, a new build: its list stays while it is asked again")
	assert.True(t, r.Refreshing)
	close(release)
	s.Wait()
	assert.Equal(t, []string{"opus", "sonnet"}, values(s.Get("claude").Models))
}

// A fetch still running for the old path when the path changes does not fill the entry for the new one.
func TestALateFetchForTheOldPathIsNotKept(t *testing.T) {
	a, b := fakeCLI(t), fakeCLI(t)
	var cur atomic.Value
	cur.Store(a)
	release := make(chan struct{})
	s := NewService(func(string) (string, error) { return cur.Load().(string), nil })
	clock := time.Now()
	s.now = func() time.Time { return clock }
	t.Cleanup(s.Wait)
	s.fetch = func(ctx context.Context, family, path string) ([]Model, string, error) {
		if path == a {
			<-release
			return []Model{{Value: "old-program"}}, "account", nil
		}
		return nil, "", errors.New("no list")
	}
	s.Get("claude") // a fetch for a starts and waits
	cur.Store(b)
	assert.Equal(t, "builtin", s.Get("claude").Source)
	close(release)
	s.Wait()
	assert.NotContains(t, values(s.Get("claude").Models), "old-program", "the old path's late answer is not served for the new path")
}

// The path is compared as the system compares file names: on Windows C:\Tools\claude.exe and c:\tools\CLAUDE.EXE are one program, so a case change keeps the list (Security's
// condition on #553); elsewhere case is part of the name.
func TestSamePathFollowsTheSystemsCaseRule(t *testing.T) {
	assert.True(t, samePath("/opt/bin/claude", "/opt/bin/claude"))
	assert.False(t, samePath("/opt/bin/claude", "/opt/bin/other"))
	if runtime.GOOS == "windows" {
		assert.True(t, samePath(`C:\Tools\claude.exe`, `c:\tools\CLAUDE.EXE`), "Windows file names are not case-sensitive")
	} else {
		assert.False(t, samePath("/opt/bin/Claude", "/opt/bin/claude"), "case is part of the name here")
	}
}
