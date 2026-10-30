//go:build !windows

package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/jsonl"
	"github.com/subgentic/coral/internal/naming"
	"github.com/subgentic/coral/internal/store"
)

// #11123: what the live list costs with many busy agents. Opt-in (CORAL_LOAD_MEASURE=1, it prints a table and takes a minute): N awake agents (claude, codex and pi, each with a transcript of about 300 KB) whose
// transcripts all gain a line before every poll (the worst case: every file changed), polled through GET /api/sessions/live, with the last_message field on and off. It reports the poll's p50, p95 and max, the
// process's CPU per poll and the bytes the last_message tails read per poll.
func TestLiveListLoadMeasurement(t *testing.T) {
	if os.Getenv("CORAL_LOAD_MEASURE") != "1" {
		t.Skip("CORAL_LOAD_MEASURE=1 runs the live list load measurement (#11123)")
	}
	const agents, polls = 50, 60
	server, h, mock, ss := setupSessionsTestServer(t)
	h.terminal = orderedTerm{mock}
	_ = server
	root := t.TempDir()
	claudeDir, codexHome, dataDir := filepath.Join(root, "claude"), filepath.Join(root, "codex"), filepath.Join(root, "data")
	t.Setenv("CLAUDE_PROJECTS_DIR", claudeDir)
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CORAL_DATA_DIR", dataDir)
	require.NoError(t, os.MkdirAll(filepath.Join(claudeDir, "proj"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(codexHome, "sessions", "2026", "10", "29"), 0o755))

	type agent struct {
		typ, sid, path string
		appendLine     func(n int) string
	}
	var all []agent
	pad := strings.Repeat("padding for a realistic transcript line ", 5)
	for i := 0; i < agents; i++ {
		typ := []string{"claude", "codex", "pi"}[i%3]
		sid := fmt.Sprintf("%08x-1123-4000-8000-%012x", i+1, i)
		dir := fmt.Sprintf("/tmp/load-%d", i)
		mock.addSession(naming.SessionName(typ, sid), dir)
		require.NoError(t, ss.RegisterLiveSession(context.Background(), &store.LiveSession{SessionID: sid, AgentType: typ, AgentName: fmt.Sprintf("agent-%d", i), WorkingDir: dir}))
		var a agent
		a.typ, a.sid = typ, sid
		require.NoError(t, os.WriteFile(naming.LogFile(h.cfg.LogDir, typ, sid), []byte("agent started\nworking\n"), 0o600)) // the agent's terminal log, which a warmed row reads
		var seed []string
		switch typ {
		case "claude":
			a.path = filepath.Join(claudeDir, "proj", sid+".jsonl")
			line := func(n int) string {
				return fmt.Sprintf(`{"type":"assistant","timestamp":"2026-10-29T10:%02d:%02d.000Z","message":{"content":[{"type":"text","text":"reply %d %s"}]}}`, (n/60)%60, n%60, n, pad)
			}
			a.appendLine = line
			for n := 0; n < 1000; n++ {
				seed = append(seed, line(n))
			}
		case "codex":
			a.path = filepath.Join(codexHome, "sessions", "2026", "10", "29", "rollout-2026-10-29T10-00-00-"+sid+".jsonl")
			line := func(n int) string {
				return fmt.Sprintf(`{"timestamp":"2026-10-29T10:%02d:%02d.000Z","type":"event_msg","payload":{"type":"agent_message","message":"reply %d %s","phase":"final_answer"}}`, (n/60)%60, n%60, n, pad)
			}
			a.appendLine = line
			for n := 0; n < 1000; n++ {
				seed = append(seed, line(n))
			}
		case "pi":
			sd := filepath.Join(dataDir, "pi-sessions", sid)
			require.NoError(t, os.MkdirAll(sd, 0o700))
			a.path = filepath.Join(sd, "2026-10-29T10-00-00-000Z_x.jsonl")
			line := func(n int) string {
				return fmt.Sprintf(`{"type":"message","id":"m%d","parentId":null,"timestamp":"2026-10-29T10:%02d:%02d.000Z","message":{"role":"assistant","content":[{"type":"text","text":"reply %d %s"},{"type":"toolCall","id":"c%d","name":"bash","arguments":{"command":"ls"}}],"stopReason":"stop"}}`, n, (n/60)%60, n%60, n, pad, n)
			}
			a.appendLine = line
			seed = append(seed, `{"type":"session","version":3,"id":"00000000-0000-4000-8000-0000000000f1","timestamp":"2026-10-29T09:00:00.000Z","cwd":"/work"}`)
			for n := 0; n < 1000; n++ {
				seed = append(seed, line(n))
			}
		}
		require.NoError(t, os.WriteFile(a.path, []byte(strings.Join(seed, "\n")+"\n"), 0o600))
		all = append(all, a)
	}
	tick := 1000
	appendAll := func() {
		tick++
		for _, a := range all {
			f, err := os.OpenFile(a.path, os.O_APPEND|os.O_WRONLY, 0o600)
			require.NoError(t, err)
			_, err = f.WriteString(a.appendLine(tick) + "\n")
			require.NoError(t, err)
			f.Close()
		}
	}
	pending := func(body []byte) int {
		var rows []map[string]any
		require.NoError(t, json.Unmarshal(body, &rows))
		n := 0
		for _, r := range rows {
			if r["enrichment_pending"] == true {
				n++
			}
		}
		return n
	}
	poll := func() time.Duration {
		start := time.Now()
		rec := httptest.NewRecorder()
		h.List(rec, httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil))
		d := time.Since(start)
		require.Equal(t, http.StatusOK, rec.Code)
		return d
	}
	// A list of more than 8 agents answers its first polls with the cold rows left to background warming (enrichment_pending); the figures are for the warmed list, as the sidebar's refreshes are.
	warm := func() (rounds int) {
		for rounds = 1; rounds < 200; rounds++ {
			rec := httptest.NewRecorder()
			h.List(rec, httptest.NewRequest(http.MethodGet, "/api/sessions/live", nil))
			if pending(rec.Body.Bytes()) == 0 {
				return rounds
			}
			time.Sleep(20 * time.Millisecond)
		}
		return rounds
	}
	cpu := func() time.Duration {
		var ru syscall.Rusage
		require.NoError(t, syscall.Getrusage(syscall.RUSAGE_SELF, &ru))
		return time.Duration(ru.Utime.Nano()+ru.Stime.Nano()) * time.Nanosecond
	}
	pct := func(d []time.Duration, p float64) time.Duration {
		s := append([]time.Duration(nil), d...)
		sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
		return s[int(float64(len(s)-1)*p)]
	}
	run := func(name string, on bool, changedEvery int) {
		lastMessageEnabled = on
		t.Cleanup(func() { lastMessageEnabled = true })
		// a new reader per scenario: every one starts cold, as a server's first poll does
		h.jsonl = jsonl.NewSessionReader()
		cold := poll()
		warmRounds := warm()
		_ = warmRounds
		var ds []time.Duration
		var cpuTotal time.Duration
		bytes0 := jsonl.LastMessageBytesRead()
		for i := 0; i < polls; i++ {
			if changedEvery > 0 && i%changedEvery == 0 {
				appendAll()
			}
			c0 := cpu()
			ds = append(ds, poll())
			cpuTotal += cpu() - c0
		}
		fmt.Printf("| %-44s | %7.1f | %7.1f | %7.1f | %7.1f | %8.1f | %10d |\n", name, float64(cold.Microseconds())/1000, float64(pct(ds, .5).Microseconds())/1000, float64(pct(ds, .95).Microseconds())/1000,
			float64(pct(ds, 1).Microseconds())/1000, float64(cpuTotal.Microseconds())/1000/polls, (jsonl.LastMessageBytesRead()-bytes0)/polls)
	}
	fmt.Printf("\n%d agents (claude, codex, pi), transcripts of about 300 KB, %d polls\n", agents, polls)
	fmt.Println("| scenario                                     | cold ms | p50 ms  | p95 ms  | max ms  | cpu ms/poll | tail B/poll |")
	fmt.Println("|----------------------------------------------|---------|---------|---------|---------|-------------|-------------|")
	run("last_message OFF, every file changes each poll", false, 1)
	run("last_message ON,  every file changes each poll", true, 1)
	run("last_message OFF, nothing changes", false, 0)
	run("last_message ON,  nothing changes", true, 0)
	run("last_message OFF, files change every 5th poll", false, 5)
	run("last_message ON,  files change every 5th poll", true, 5)
}
