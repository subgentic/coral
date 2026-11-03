package frontend

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io/fs"
	"math"
	"os"
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
	t.Logf("app.js %d (baseline %d, ceiling %d), css %d (baseline %d, ceiling %d)", appJs, base.AppJs, ceilWeight(base.AppJs), css, base.CSS, ceilWeight(base.CSS))
	if appJs > ceilWeight(base.AppJs) {
		t.Errorf("app.js at start is %d bytes encoded, over the baseline %d plus 2 percent (%d): a module joined the startup graph; load it lazily with importOnce, or the Operator raises the baseline (page_weight_baseline.json)", appJs, base.AppJs, ceilWeight(base.AppJs))
	}
	if css > ceilWeight(base.CSS) {
		t.Errorf("the start stylesheet is %d bytes encoded, over the baseline %d plus 2 percent (%d): move styles into the stylesheet of the view that needs them, or the Operator raises the baseline", css, base.CSS, ceilWeight(base.CSS))
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
