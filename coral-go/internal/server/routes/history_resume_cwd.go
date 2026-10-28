package routes

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/secfile"
)

// resumeCwdScanBytes is how much of a transcript's start is read to find the folder the session ran in: the CLIs record it in their first entries (Claude's every entry carries cwd, Codex's
// session_meta and Pi's header have it), so a short look is enough, and a transcript of a hundred megabytes is not read.
const resumeCwdScanBytes = 256 << 10

// transcriptCwd is the folder a past session ran in, read from the start of its transcript (#10291, Desktop pass 25: Resume offered Coral's folder, not the session's own, for a chat Coral had no
// live row for). "" when the file has none, is not readable or names no absolute path. The text is only returned: nothing is opened under it.
func transcriptCwd(sourceFile string) string { cwd, _ := transcriptStart(sourceFile); return cwd }

// transcriptStart is the folder a past session ran in and, where the CLI keeps it in its transcript (Claude's entries carry permissionMode), the permission mode the chat started in, both read from
// the first 256 KiB of the file (#10291, #10487). Each is "" when the file has none; a mode that is no known mode is not returned.
func transcriptStart(sourceFile string) (cwd, mode string) {
	if sourceFile == "" {
		return "", ""
	}
	f, err := secfile.OpenNoFollow(sourceFile, os.O_RDONLY, 0) // a history file the indexer recorded, never read through a link
	if err != nil {
		return "", ""
	}
	defer f.Close()
	r := bufio.NewReaderSize(io.LimitReader(f, resumeCwdScanBytes), 64<<10)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			var entry struct {
				Cwd            string `json:"cwd"`
				PermissionMode string `json:"permissionMode"`
				Payload        struct {
					Cwd string `json:"cwd"`
				} `json:"payload"`
			}
			if json.Unmarshal(line, &entry) == nil {
				if cwd == "" {
					for _, c := range []string{entry.Cwd, entry.Payload.Cwd} {
						if c != "" && filepath.IsAbs(c) {
							cwd = filepath.Clean(c)
							break
						}
					}
				}
				if mode == "" && agent.ValidPermissionMode(entry.PermissionMode) {
					mode = entry.PermissionMode
				}
			}
		}
		if err != nil || (cwd != "" && mode != "") {
			return cwd, mode
		}
	}
}
