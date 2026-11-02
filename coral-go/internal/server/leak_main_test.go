package server

import (
	"fmt"
	"io/fs"
	"os"
	"sync"
	"testing"

	"github.com/subgentic/coral/internal/testleak"
	"github.com/subgentic/coral/internal/testmem"
	"github.com/subgentic/coral/internal/testtemp"
	"github.com/subgentic/coral/pkg/frontend"
)

// memoBundleSource builds the dashboard bundle once per test process, not once per server (#12062): a test binary starts hundreds of servers, each built the same bundle and kept about
// 12 MB of it (esbuild's source maps and chunk output) for the rest of the run, which took ./internal/server past 3 GB. The same tree and index give the same bundle, so they share one.
func memoBundleSource(build func(fs.FS, []byte) (*frontend.Bundle, string, error)) func(fs.FS, []byte) (*frontend.Bundle, string, error) {
	type built struct {
		b   *frontend.Bundle
		how string
	}
	var mu sync.Mutex
	done := map[string]built{}
	return func(static fs.FS, index []byte) (*frontend.Bundle, string, error) {
		key, err := frontend.BundleInputHash(static, index)
		if err != nil {
			return build(static, index)
		}
		mu.Lock()
		defer mu.Unlock()
		if d, ok := done[key]; ok {
			return d.b, d.how, nil
		}
		b, how, err := build(static, index)
		if err == nil {
			done[key] = built{b, how}
		}
		return b, how, err
	}
}

// TestMain fails the package when its tests leave a goroutine running (#4167).
func TestMain(m *testing.M) {
	// The message search index is on by default (#9685): the tests' stores would each build one in the background. The tests of the index and of the setting set the variable themselves.
	os.Setenv("CORAL_BOARD_SEARCH_INDEX", "off")
	cleanupTemp := testtemp.Use() // a private temp, home and data folder for this package (#356)
	bundleSource = memoBundleSource(bundleSource)
	stopMem := testmem.Start("internal/server", testmem.LimitMB(testmem.DefaultLimitMB)) // a run over 2 GB is stopped, not left to push the machine out of memory (#12062)
	code := m.Run()
	if peak := stopMem(); peak > 0 {
		fmt.Fprintf(os.Stderr, "internal/server: peak held memory %d MiB\n", peak)
	}
	testtemp.Exit(cleanupTemp, testleak.Check(code))
}
