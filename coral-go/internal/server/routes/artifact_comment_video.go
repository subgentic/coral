package routes

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"strings"

	"github.com/subgentic/coral/internal/store"
)

func (h *SessionsHandler) videoCommentArtifact(id string) bool {
	if len(id) != 64 || strings.ToLower(id) != id {
		return false
	}
	if _, err := hex.DecodeString(id); err != nil {
		return false
	}
	b, err := readSmallFile(filepath.Join(h.artifactDir(), id+".json"), 64<<10)
	var m agentArtifactMeta
	if err != nil || json.Unmarshal(b, &m) != nil {
		return false
	}
	mt := strings.ToLower(strings.TrimSpace(strings.SplitN(m.MediaType, ";", 2)[0]))
	if strings.HasPrefix(mt, "video/") {
		return true
	}
	if mt != "" && mt != "application/octet-stream" {
		return false
	}
	switch strings.ToLower(filepath.Ext(m.Name)) {
	case ".mp4", ".webm", ".mov", ".m4v", ".ogv":
		return true
	}
	return false
}

func videoCommentLabel(c store.ArtifactComment) string {
	if c.AtS == nil {
		return ""
	}
	stamp := func(s float64) string { n := int(math.Round(s)); return fmt.Sprintf("%02d:%02d", n/60, n%60) }
	label := stamp(*c.AtS)
	if c.EndS != nil {
		label += "–" + stamp(*c.EndS)
	}
	return "Video time: " + label
}
