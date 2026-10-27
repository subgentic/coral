package runrecord

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/subgentic/coral/internal/secfile"
)

// LaunchFile is the launch record's name in <data dir>/updates.
const LaunchFile = "launch.json"

// Launch is where a running Coral lives, for the updater's relaunch on macOS and Windows (#9056): the data folder, the home folder and the port it listens on. A relaunch that
// dropped them started the app against the login home and the default port, so an isolated or non-default install came back as another Coral. The server writes it at startup; it is
// the server's own, never a value from a request. (Linux restarts from the run record, which has the whole command line and the environment.)
type Launch struct {
	DataDir string `json:"data_dir"`
	Home    string `json:"home,omitempty"`
	Port    int    `json:"port,omitempty"`
}

// Valid says the record is one a relaunch may use: absolute folders with no control character, a port a program can listen on. A field that is not valid is not used.
func (l Launch) Valid() Launch {
	clean := func(p string) string {
		if p == "" || !filepath.IsAbs(p) || strings.ContainsAny(p, "\x00\r\n") || len(p) > 4096 {
			return ""
		}
		return p
	}
	l.DataDir, l.Home = clean(l.DataDir), clean(l.Home)
	if l.Port < 1 || l.Port > 65535 {
		l.Port = 0
	}
	return l
}

// WriteLaunch records l for the data folder, atomically, 0600.
func WriteLaunch(dataDir string, l Launch) error {
	b, err := json.Marshal(l.Valid())
	if err != nil {
		return err
	}
	return writePrivate(dataDir, LaunchFile, b)
}

// ReadLaunch reads <dataDir>/updates/launch.json without following a link (a regular file, owner-only where modes exist, small) and keeps only its valid fields. A missing or unreadable record
// is the zero Launch and an error: the relaunch then has nothing to add.
func ReadLaunch(dataDir string) (Launch, error) {
	f, err := secfile.OpenNoFollow(filepath.Join(dataDir, "updates", LaunchFile), os.O_RDONLY, 0)
	if err != nil {
		return Launch{}, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return Launch{}, err
	}
	if !fi.Mode().IsRegular() || fi.Size() > 16<<10 || (runtime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0) {
		return Launch{}, errors.New("the launch record is not a private regular file")
	}
	b, err := io.ReadAll(io.LimitReader(f, 16<<10+1))
	if err != nil {
		return Launch{}, err
	}
	var l Launch
	if err := json.Unmarshal(b, &l); err != nil {
		return Launch{}, err
	}
	return l.Valid(), nil
}
