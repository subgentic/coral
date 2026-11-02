package skills

import (
	"archive/zip"
	"bytes"
	"embed"
	"fmt"
	"io/fs"
	"sort"
)

// The skills Coral ships as examples (#12463): a skill for writing skills, one for an agent working in a team, one for designing an automation. Markdown only (SKILL.md), embedded in the program; the server
// puts them in the Skills Store as approved, published by Coral (internal/server/routes SeedStarterSkills).
//
//go:embed starter/*/SKILL.md
var starterFS embed.FS

// StarterZip is one starter skill as the zip the Skills Store keeps: its name (the folder's) and the bytes. The zip is the same bytes on every run and every build (stored, not compressed, no times), so its
// digest changes only when the text does.
type StarterZip struct {
	Name string
	Data []byte
}

// StarterZips are the starter skills, by name.
func StarterZips() ([]StarterZip, error) {
	dirs, err := fs.ReadDir(starterFS, "starter")
	if err != nil {
		return nil, err
	}
	var out []StarterZip
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		md, err := starterFS.ReadFile("starter/" + d.Name() + "/SKILL.md")
		if err != nil {
			return nil, err
		}
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		w, err := zw.CreateHeader(&zip.FileHeader{Name: "SKILL.md", Method: zip.Store})
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(md); err != nil {
			return nil, err
		}
		if err := zw.Close(); err != nil {
			return nil, fmt.Errorf("starter skill %s: %w", d.Name(), err)
		}
		out = append(out, StarterZip{Name: d.Name(), Data: buf.Bytes()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
