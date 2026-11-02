package server

import (
	"io/fs"
	"testing"
	"testing/fstest"

	"github.com/subgentic/coral/pkg/frontend"
)

// The test process builds the bundle once for the same tree and index, and again for a changed one (#12062).
func TestMemoBundleSourceBuildsOncePerInput(t *testing.T) {
	calls := 0
	src := memoBundleSource(func(fs.FS, []byte) (*frontend.Bundle, string, error) {
		calls++
		return &frontend.Bundle{}, "built", nil
	})
	a := fstest.MapFS{"app.js": {Data: []byte("a")}}
	b := fstest.MapFS{"app.js": {Data: []byte("b")}}
	b1, _, _ := src(a, []byte("x"))
	b2, _, _ := src(a, []byte("x"))
	if calls != 1 || b1 != b2 {
		t.Fatalf("same input: %d builds, same bundle %v", calls, b1 == b2)
	}
	src(b, []byte("x"))
	if calls != 2 {
		t.Fatalf("a changed tree builds again: %d builds", calls)
	}
}
