package frontend

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"os"
	"runtime"
	"strings"
	"testing"
)

// The start weight, offline (#12879). tests/frontend/page_weight_browser.test.js measures what a first visit loads in a real Chrome and fails over the baseline plus 2 percent; two of its numbers need no browser:
// app.js and the one stylesheet the shell loads are built here from the same tree and gzipped as the server gzips them (level 9, once), and their encoded sizes are what Chrome reports (checked to the byte:
// 420,803 and 104,565 at the time). So a change that grows the start path fails here, in a unit test run, with the same ceiling as the gate: fixtures/page_weight_baseline.json times 1.02. The other numbers of the
// browser test (requests, scripts, the total) still need the browser.
const startWeightRoom = 1.02

func weightGzip(b []byte) int64 {
	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	_, _ = zw.Write(b)
	_ = zw.Close()
	return int64(buf.Len())
}

// startWeights are the encoded bytes of the bundle's app.js and of its stylesheet bundle.
func startWeights(t *testing.T) (appJs, css int64) {
	t.Helper()
	sub, err := fs.Sub(Static, "static")
	if err != nil {
		t.Fatal(err)
	}
	index, err := fs.ReadFile(Templates, "templates/index.html")
	if err != nil {
		t.Fatal(err)
	}
	b, err := BuildBundle(sub, index)
	if err != nil {
		t.Fatal(err)
	}
	app, ok := b.Files["app.js"]
	if !ok {
		t.Fatal("the bundle has no app.js")
	}
	sheet, ok := b.Files["css/bundle.css"]
	if !ok {
		t.Fatal("the bundle has no css/bundle.css")
	}
	return weightGzip(app), weightGzip(sheet)
}

func TestStartPathWeightIsWithinThePageWeightBaseline(t *testing.T) {
	raw, err := os.ReadFile("../../../tests/frontend/fixtures/page_weight_baseline.json")
	if err != nil {
		t.Skip("no tests/frontend baseline beside this module")
	}
	var base struct {
		AppJs int64 `json:"appJs"`
		CSS   int64 `json:"css"`
	}
	if err := json.Unmarshal(raw, &base); err != nil || base.AppJs == 0 || base.CSS == 0 {
		t.Fatalf("page_weight_baseline.json: %v (appJs %d, css %d)", err, base.AppJs, base.CSS)
	}
	appJs, css := startWeights(t)
	t.Log(startWeightLine(appJs, css, base.AppJs, base.CSS, runtime.Version()))
	if appJs > ceilWeight(base.AppJs) {
		t.Errorf("app.js at start is %d bytes encoded, over the baseline %d plus 2 percent (%d): a module joined the startup graph; load it lazily with importOnce, or the Operator raises the baseline (page_weight_baseline.json)", appJs, base.AppJs, ceilWeight(base.AppJs))
	}
	if css > ceilWeight(base.CSS) {
		t.Errorf("the start stylesheet is %d bytes encoded, over the baseline %d plus 2 percent (%d): move styles into the stylesheet of the view that needs them, or the Operator raises the baseline", css, base.CSS, ceilWeight(base.CSS))
	}
}

// startWeightLine is the one line tests/frontend/start_bytes_delta.mjs parses (fixtures/start_weight_line.txt pins both sides): the gzip sizes depend on the Go toolchain's compress/flate (#17930), so the version is on it.
func startWeightLine(appJs, css, baseApp, baseCSS int64, goVersion string) string {
	return fmt.Sprintf("app.js %d (baseline %d, ceiling %d), css %d (baseline %d, ceiling %d), go %s", appJs, baseApp, ceilWeight(baseApp), css, baseCSS, ceilWeight(baseCSS), goVersion)
}

func TestTheStartWeightLineIsTheOneTheDeltaScriptReads(t *testing.T) {
	raw, err := os.ReadFile("../../../tests/frontend/fixtures/start_weight_line.txt")
	if err != nil {
		t.Skip("no tests/frontend fixtures beside this module")
	}
	if got, want := startWeightLine(426186, 106042, 418000, 106000, "go1.26.1"), strings.TrimSpace(string(raw)); got != want {
		t.Errorf("the log line drifted from fixtures/start_weight_line.txt (start_bytes_delta.mjs parses it):\n got  %s\n want %s", got, want)
	}
}

func ceilWeight(n int64) int64 { return int64(math.Ceil(float64(n) * startWeightRoom)) }

func TestTheCeilingIsTheBaselinePlusTwoPercentRoundedUp(t *testing.T) {
	if got := ceilWeight(405565); got != 413677 {
		t.Errorf("405,565 + 2%% = %d, want 413,677 (what the browser test computes)", got)
	}
	if got := ceilWeight(100); got != 102 {
		t.Errorf("100 + 2%% = %d, want 102", got)
	}
}
