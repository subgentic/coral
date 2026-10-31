package mediatype

import "testing"

func TestResolve(t *testing.T) {
	md := "text/markdown; charset=utf-8"
	cases := []struct {
		declared string
		names    []string
		want     string
	}{
		{"", []string{"report.md"}, md},
		{"application/octet-stream", []string{"report.MD"}, md},
		{"Application/Octet-Stream; x=y", []string{"a.markdown"}, md},
		{"binary/octet-stream", []string{"a.md"}, md},
		{"text/markdown", []string{"x.bin"}, "text/markdown"},
		{"image/png", []string{"a.md"}, "image/png"},
		{"text/plain", []string{"a.md"}, "text/plain"},
		{"", []string{"noext", "later.md"}, md},
		{"", []string{"blob.unknownext123"}, ""},
		{"application/octet-stream", []string{"blob.unknownext123"}, "application/octet-stream"},
		{"", []string{"README"}, ""},
	}
	for _, c := range cases {
		if got := Resolve(c.declared, c.names...); got != c.want {
			t.Errorf("Resolve(%q,%v)=%q want %q", c.declared, c.names, got, c.want)
		}
	}
}

func TestEnsureExtension(t *testing.T) {
	cases := [][3]string{
		{"media-latency-audit-2026-10-05", "/tmp/x/audit.md", "media-latency-audit-2026-10-05.md"},
		{"report.md", "/tmp/a.txt", "report.md"},
		{"v1.2 report", "a.md", "v1.2 report.md"},
		{"name", "noext", "name"},
		{"name", "a.bad ext", "name"},
	}
	for _, c := range cases {
		if got := EnsureExtension(c[0], c[1]); got != c[2] {
			t.Errorf("EnsureExtension(%q,%q)=%q want %q", c[0], c[1], got, c[2])
		}
	}
}

// A .patch or .diff is stored as text (#11553), so the dashboard can show it; an octet-stream one is not something Needs you can show.
func TestPatchAndDiffAreText(t *testing.T) {
	for _, n := range []string{"fix.patch", "FIX.PATCH", "a.diff"} {
		if got := Resolve("application/octet-stream", n); got != "text/plain; charset=utf-8" {
			t.Errorf("Resolve(octet-stream, %q)=%q", n, got)
		}
		if got := Resolve("", n); got != "text/plain; charset=utf-8" {
			t.Errorf("Resolve(\"\", %q)=%q", n, got)
		}
	}
}

func TestViewable(t *testing.T) {
	cases := []struct {
		mt, name string
		want     bool
	}{
		{"text/markdown; charset=utf-8", "a.md", true}, {"text/html", "a.html", true}, {"text/csv", "t.csv", true}, {"text/tab-separated-values", "t.tsv", true},
		{"text/plain; charset=utf-8", "fix.patch", true}, {"image/png", "a.png", true}, {"image/svg+xml", "a.svg", true}, {"application/pdf", "a.pdf", true},
		{"application/json", "a.json", true}, {"application/vnd.api+json", "a", true}, {"application/xml", "a.xml", true}, {"video/mp4", "a.mp4", true},
		{"application/octet-stream", "fix.patch", false}, {"application/octet-stream", "a.diff", false}, {"", "fix.patch", false}, {"application/octet-stream", "blob", false},
		{"application/octet-stream", "notes.md", true}, {"application/octet-stream", "run.LOG", true}, {"application/octet-stream", "a.csv", true},
		{"application/zip", "a.zip", false}, {"application/x-executable", "a.out", false}, {"application/gzip", "a.md", false},
	}
	for _, c := range cases {
		if got := Viewable(c.mt, c.name); got != c.want {
			t.Errorf("Viewable(%q,%q)=%v want %v", c.mt, c.name, got, c.want)
		}
	}
}
