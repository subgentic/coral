package agent

import (
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/safego"
)

// A common install place can be on a network share: on a domain computer whose AppData is redirected, %APPDATA%\npm (where npm really installs claude.cmd and
// codex.cmd) is a folder on a file server. Skipping it would lose those CLIs, so it is kept, but a share that does not answer must not hang the CLI check or a
// launch (#464). Before a candidate in such a folder is stat'ed, the folder itself is stat'ed once with a time limit:
//   - only a folder on a share is probed (a UNC path, or a drive letter Windows does not call local: onNetworkShare, localDrive); a local folder is stat'ed as before;
//   - the probe is a Stat of the folder and nothing else: nothing on the share is opened, read or run;
//   - one probe per folder at a time (single-flight, keyed by the folder). A stat Windows cannot cancel ends when SMB gives up (about a minute); the folders are
//     the fixed few of CommonPlaceCandidates, so at most that many goroutines can be waiting at once;
//   - a folder that does not answer within shareProbeLimit is "not answered" for shareQuiet: it is skipped, and the check and the launch say so in one fixed
//     sentence (ShareNotAnsweredNote), which names no folder, server or person. The mark expires on its own;
//   - a late answer is thrown away. Nothing is remembered as found: the candidates are stat'ed again, through the same screens, at the next lookup.

var (
	shareProbeLimit = 2 * time.Second
	shareQuiet      = 60 * time.Second
	shareStat       = os.Stat   // the probe's one call; a test makes it slow
	shareNow        = time.Now  // a test moves the clock
	onShareFolder   = isOnShare // which folders are probed; a test marks one as a share
)

type shareProbe struct {
	done chan struct{}
	ok   bool
}

type shareFolder struct {
	inflight   *shareProbe
	quietUntil time.Time
}

var (
	shareMu      sync.Mutex
	shareFolders = map[string]*shareFolder{}
)

// isOnShare: a UNC folder, or one on a drive letter that is not one of this computer's own.
func isOnShare(dir string) bool {
	if onNetworkShare(dir) {
		return true
	}
	vol := filepath.VolumeName(dir)
	return len(vol) == 2 && vol[1] == ':' && !localDrive(vol+`\`)
}

// shareAnswers reports whether the folder of a candidate can be searched now: true for a folder that is not on a share, and for one on a share that answered its
// probe within the limit. False while the folder is marked "not answered".
func shareAnswers(dir string) bool {
	if !onShareFolder(dir) {
		return true
	}
	shareMu.Lock()
	f := shareFolders[dir]
	if f == nil {
		f = &shareFolder{}
		shareFolders[dir] = f
	}
	if shareNow().Before(f.quietUntil) {
		shareMu.Unlock()
		return false
	}
	p := f.inflight
	if p == nil {
		p = &shareProbe{done: make(chan struct{})}
		f.inflight = p
		go func() {
			defer safego.Recover("agent/share-probe")
			_, err := shareStat(dir)
			shareMu.Lock()
			p.ok = err == nil
			if f.inflight == p {
				f.inflight = nil
			}
			shareMu.Unlock()
			close(p.done)
		}()
	}
	shareMu.Unlock()
	timer := time.NewTimer(shareProbeLimit)
	defer timer.Stop()
	select {
	case <-p.done:
		shareMu.Lock()
		ok := p.ok
		shareMu.Unlock()
		return ok // a folder that answered "not there" is simply empty: nothing to search, no note
	case <-timer.C:
		shareMu.Lock()
		f.quietUntil = shareNow().Add(shareQuiet)
		shareMu.Unlock()
		return false
	}
}

// shareNotAnswered reports whether a folder is marked "not answered" right now.
func shareNotAnswered(dir string) bool {
	shareMu.Lock()
	defer shareMu.Unlock()
	f := shareFolders[dir]
	return f != nil && shareNow().Before(f.quietUntil)
}

// ShareNotAnsweredNote is the one sentence a person sees when a share holding a common install place did not answer in time: AppData's npm folder, or the home
// folder's .local\bin when the home folder is on a share. binary is a CLI's own fixed name (claude, codex), never a path's file name.
func ShareNotAnsweredNote(binary string) string {
	return "A folder where Coral looks for " + binary + " is on a network share that did not answer in time, so Coral could not look there. Check again when the network is back, or set the path in Settings > CLI paths."
}

// ShareSkipped reports whether a search for binary skipped a common place because its share did not answer (the CLI check adds ShareNotAnsweredNote then).
func ShareSkipped(binary string) bool {
	for _, p := range CommonPlaceCandidates(binary) {
		if shareNotAnswered(filepath.Dir(p)) {
			return true
		}
	}
	return false
}
