package routes

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	"github.com/subgentic/coral/internal/fsreplace"
)

// gdocLink is one shared artifact: the Google Doc it was made into and the version last sent (#19996).
type gdocLink struct {
	DocID  string `json:"doc_id"`
	Digest string `json:"digest"` // the artifact version last written to the Doc
	Name   string `json:"name,omitempty"`
}

var gdocLinksMu sync.Mutex

// gdocLinksPath is the side table: a file in Coral's data folder (owner-only), keyed by the artifact's series id, or its digest when it has no series.
func (h *SessionsHandler) gdocLinksPath() string {
	return filepath.Join(h.cfg.CoralDir(), "gdoc_links.json")
}

func (h *SessionsHandler) loadGdocLinks() (map[string]gdocLink, error) {
	links := map[string]gdocLink{}
	b, err := os.ReadFile(h.gdocLinksPath())
	if errors.Is(err, os.ErrNotExist) {
		return links, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &links); err != nil {
		return nil, err
	}
	return links, nil
}

func (h *SessionsHandler) saveGdocLinks(links map[string]gdocLink) error {
	b, err := json.MarshalIndent(links, "", "  ")
	if err != nil {
		return err
	}
	path := h.gdocLinksPath()
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return fsreplace.Rename(tmp, path)
}
