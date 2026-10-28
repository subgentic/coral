package frontend

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	_ "image/png"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The installed app (#10095, Mobile #10089): the manifest has an id and a scope, its icons are separate "any" and "maskable" files (a maskable icon keeps its picture inside the safe zone, so a round
// or squircle mask cuts nothing), and the page says its app name, runs edge to edge (viewport-fit=cover) with the top bar clear of the notch.
func TestWebAppManifest(t *testing.T) {
	raw, err := fs.ReadFile(Static, "static/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		ID, Scope   string
		Description string
		StartURL    string `json:"start_url"`
		Name        string
		ShortName   string `json:"short_name"`
		Display     string
		Icons       []struct{ Src, Sizes, Type, Purpose string }
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m.ID != "/" || m.Scope != "/" || m.StartURL != "/" {
		t.Errorf("id, scope and start_url are all /: %q %q %q", m.ID, m.Scope, m.StartURL)
	}
	// what a person does, in the words of the README's first line (#10469), not a category
	readme, err := os.ReadFile(filepath.Join("..", "..", "..", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	const want = "The control plane for the coding agents you already have"
	if !strings.Contains(string(readme), "Coral: the control plane for the coding agents you already have") {
		t.Fatal("the README's first line changed: update this test and the manifest description together")
	}
	if !strings.Contains(m.Description, want) || strings.Contains(strings.ToLower(m.Description), "multi-agent orchestration") {
		t.Errorf("the manifest description says %q: it should say %q, as the README does", m.Description, want)
	}
	have := map[string]bool{}
	for _, ic := range m.Icons {
		if strings.Contains(ic.Purpose, " ") {
			t.Errorf("icon %s mixes purposes (%q): any and maskable are separate files", ic.Src, ic.Purpose)
		}
		if ic.Purpose == "maskable" || ic.Purpose == "any" {
			have[ic.Purpose+" "+ic.Sizes] = true
		}
		if ic.Purpose == "maskable" {
			data, err := fs.ReadFile(Static, "static/"+ic.Src)
			if err != nil {
				t.Errorf("maskable icon %s: %v", ic.Src, err)
				continue
			}
			img, _, err := image.Decode(bytes.NewReader(data))
			if err != nil {
				t.Errorf("maskable icon %s: %v", ic.Src, err)
				continue
			}
			checkSafeZone(t, ic.Src, img)
		}
	}
	for _, want := range []string{"any 192x192", "any 512x512", "maskable 192x192", "maskable 512x512"} {
		if !have[want] {
			t.Errorf("manifest has no %s icon", want)
		}
	}
}

// Everything that is not the icon's background lies inside the circle of 80% of the width, the safe zone every mask keeps.
func checkSafeZone(t *testing.T, name string, img image.Image) {
	b := img.Bounds()
	size := float64(b.Dx())
	bg := img.At(b.Min.X+1, b.Min.Y+1)
	cx, cy := float64(b.Min.X)+size/2, float64(b.Min.Y)+size/2
	limit := size * 0.4
	worst := 0.0
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if near(img.At(x, y), bg) {
				continue
			}
			if d := math.Hypot(float64(x)+0.5-cx, float64(y)+0.5-cy); d > worst {
				worst = d
			}
		}
	}
	if worst > limit {
		t.Errorf("%s: its picture reaches %.0f px from the centre, past the safe zone of %.0f px", name, worst, limit)
	}
}

func near(a, b color.Color) bool {
	ar, ag, ab, _ := a.RGBA()
	br, bg, bb, _ := b.RGBA()
	d := func(x, y uint32) uint32 {
		if x > y {
			return x - y
		}
		return y - x
	}
	return d(ar, br) < 0x1800 && d(ag, bg) < 0x1800 && d(ab, bb) < 0x1800
}

func TestPageHeadForTheInstalledApp(t *testing.T) {
	index, err := fs.ReadFile(Templates, "templates/index.html")
	if err != nil {
		t.Fatal(err)
	}
	html := string(index)
	for _, want := range []string{`<meta name="apple-mobile-web-app-title" content="Coral">`, `viewport-fit=cover`} {
		if !strings.Contains(html, want) {
			t.Errorf("index.html has no %s", want)
		}
	}
	css, err := fs.ReadFile(Static, "static/css/layout.css")
	if err != nil {
		t.Fatal(err)
	}
	top := string(css)
	i := strings.Index(top, ".top-bar {")
	if i < 0 || !strings.Contains(top[i:i+400], "env(safe-area-inset-top") {
		t.Error("the top bar keeps clear of the notch: its padding uses env(safe-area-inset-top)")
	}
}
