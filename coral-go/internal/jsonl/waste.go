package jsonl

import (
	"bufio"
	"encoding/json"
	"os"
	"sync"
	"time"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// The waste line per agent (#21057, feature bets stage 2, task 9) reads two things only a Claude transcript says:
//   - A cache expiry: a model call that came more than CacheTTL after the call before it and wrote its prompt again (its cache writes beat its cache reads): the agent sat idle past the cache time, so the
//     next turn paid full price. A long gap with the cache still read is not one (an hour cache).
//   - An idle compaction: a /compact typed at the prompt (compact_boundary, trigger manual: the person's, or Coral's compaction of an idle agent). The CLI's own mid-turn one (trigger auto) is not idle.
//
// A message the CLI wrote as several entries (one per content block) is one call, and a subagent's calls (isSidechain) are not the agent's: it has a cache of its own.

// CacheTTL is how long the CLI's prompt cache lives without a call.
const CacheTTL = 5 * time.Minute

// Waste is what a transcript says of an agent's waste in a range.
type Waste struct {
	CacheExpiries   int
	IdleCompactions int
}

type wasteCall struct {
	at           time.Time
	read, create int64
}

type wasteFile struct {
	size, mtime int64
	calls       []wasteCall // in the file's order, one per message id
	compactions []time.Time // the manual ones
}

var wasteCache = struct {
	sync.Mutex
	m map[string]*wasteFile
}{m: map[string]*wasteFile{}}

const wasteCacheMax = 512

// Waste reads the agent's Claude transcript for the calls and compactions in [from, to). ok is false for another agent type or a session with no transcript: no figures, never zeros. The parsed file is
// kept by its size and modification time, so an unchanged transcript is not read again.
func (r *SessionReader) Waste(sessionID, workingDir, agentType string, from, to time.Time) (Waste, bool) {
	if agentType != at.Claude {
		return Waste{}, false
	}
	path := resolveTranscriptPathMode(sessionID, workingDir, agentType, true)
	if path == "" {
		return Waste{}, false
	}
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return Waste{}, false
	}
	wasteCache.Lock()
	wf := wasteCache.m[path]
	wasteCache.Unlock()
	if wf == nil || wf.size != fi.Size() || wf.mtime != fi.ModTime().UnixNano() {
		wf = readWasteFile(path, agentType)
		if wf == nil {
			return Waste{}, false
		}
		wf.size, wf.mtime = fi.Size(), fi.ModTime().UnixNano()
		wasteCache.Lock()
		if len(wasteCache.m) >= wasteCacheMax {
			wasteCache.m = map[string]*wasteFile{}
		}
		wasteCache.m[path] = wf
		wasteCache.Unlock()
	}
	var w Waste
	for i := 1; i < len(wf.calls); i++ {
		c, prev := wf.calls[i], wf.calls[i-1]
		if c.at.Before(from) || !c.at.Before(to) {
			continue
		}
		if c.at.Sub(prev.at) > CacheTTL && c.create > c.read {
			w.CacheExpiries++
		}
	}
	for _, t := range wf.compactions {
		if !t.Before(from) && t.Before(to) {
			w.IdleCompactions++
		}
	}
	return w, true
}

func readWasteFile(path, agentType string) *wasteFile {
	f, err := openTranscript(path, agentType)
	if err != nil {
		return nil
	}
	defer f.Close()
	wf := &wasteFile{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 256*1024), 64*1024*1024)
	lastID := ""
	for sc.Scan() {
		var e struct {
			Type      string `json:"type"`
			Subtype   string `json:"subtype"`
			Timestamp string `json:"timestamp"`
			Sidechain bool   `json:"isSidechain"`
			Compact   struct {
				Trigger string `json:"trigger"`
			} `json:"compactMetadata"`
			Message struct {
				ID    string `json:"id"`
				Usage *struct {
					Read   int64 `json:"cache_read_input_tokens"`
					Create int64 `json:"cache_creation_input_tokens"`
				} `json:"usage"`
			} `json:"message"`
		}
		line := sc.Bytes()
		if len(line) == 0 || line[0] != '{' || json.Unmarshal(line, &e) != nil {
			continue
		}
		t, err := time.Parse(time.RFC3339Nano, e.Timestamp)
		if err != nil || e.Sidechain {
			continue
		}
		switch {
		case e.Type == "system" && e.Subtype == "compact_boundary" && e.Compact.Trigger == "manual":
			wf.compactions = append(wf.compactions, t)
		case e.Type == "assistant" && e.Message.Usage != nil:
			if e.Message.ID != "" && e.Message.ID == lastID {
				continue // the same call's next block
			}
			lastID = e.Message.ID
			wf.calls = append(wf.calls, wasteCall{at: t, read: e.Message.Usage.Read, create: e.Message.Usage.Create})
		}
	}
	if sc.Err() != nil {
		return nil
	}
	return wf
}
