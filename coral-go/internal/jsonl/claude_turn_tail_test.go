package jsonl

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// #4788: the first read of a Claude transcript starts at its end, in longer and longer tails, until every field has a value and a user or
// assistant record was seen. Every field is the newest value in the file, so this must give exactly what a read of the whole file gives, at
// the first read and after what is appended. Old against new on random transcripts: records of every kind the readers know (turn ends,
// interrupts, quoted markers, API errors and the records that clear them, versions and models present or missing, a "version" inside a tool
// result before the record's own, long records, a last record with no newline), tails of a few hundred bytes so every window length and the
// whole-file fallback are used.

// tailRecord is a transcript record. rare names a field that most records leave out (so a tail often lacks it): "version", "model" or
// "event" (the turn ends and interrupts), or "" for none.
func tailRecord(rng *rand.Rand, i int, ts time.Time, rare string) string {
	stamp := ts.Format("2006-01-02T15:04:05.000Z")
	version := ""
	if rng.Intn(10) > 0 && (rare != "version" || rng.Intn(60) == 0) {
		version = fmt.Sprintf(`"version":"2.1.%d",`, 290+rng.Intn(15))
	}
	pad := strings.Repeat("x", rng.Intn(3)*rng.Intn(2500))
	k := rng.Intn(20)
	if rare == "event" && (k == 8 || k == 9 || k == 10) && rng.Intn(60) != 0 {
		k = 18
	}
	switch {
	case k < 4:
		return fmt.Sprintf(`{"type":"user",%s"message":{"role":"user","content":"prompt %d %s"},"timestamp":"%s"}`, version, i, pad, stamp)
	case k < 8:
		model := ""
		if rng.Intn(4) > 0 && (rare != "model" || rng.Intn(40) == 0) {
			model = fmt.Sprintf(`"model":"claude-m%d",`, rng.Intn(4))
		}
		return fmt.Sprintf(`{"type":"assistant",%s"message":{%s"role":"assistant","content":[{"type":"text","text":"answer %d %s"}]},"timestamp":"%s"}`, version, model, i, pad, stamp)
	case k < 10:
		return fmt.Sprintf(`{"type":"system","subtype":"turn_duration",%s"durationMs":%d,"timestamp":"%s"}`, version, rng.Intn(9000), stamp)
	case k == 10:
		return fmt.Sprintf(`{"type":"user",%s"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"timestamp":"%s"}`, version, stamp)
	case k == 11:
		return fmt.Sprintf(`{"type":"user",%s"message":{"role":"user","content":[{"type":"tool_result","content":"[Request interrupted by user] quoted","tool_use_id":"t"}]},"timestamp":"%s"}`, version, stamp)
	case k == 12:
		return fmt.Sprintf(`{"type":"assistant",%s"isApiErrorMessage":true,"error":"authentication_failed","message":{"model":"claude-m1","content":[{"type":"text","text":"Invalid API key %d"}]},"timestamp":"%s"}`, version, i, stamp)
	case k == 13:
		return fmt.Sprintf(`{"type":"assistant",%s"isApiErrorMessage":true,"apiErrorStatus":429,"error":"rate_limit","message":{"content":"limit %d"},"timestamp":"%s"}`, version, i, stamp)
	case k == 14:
		return fmt.Sprintf(`{"type":"user","toolUseResult":{"version":"9.9.9","stdout":"%s"},%s"message":{"role":"user","content":[{"type":"tool_result","content":"ok","tool_use_id":"t"}]},"timestamp":"%s"}`, pad, version, stamp)
	case k == 15:
		return fmt.Sprintf(`{"type":"progress",%s"data":"%s","timestamp":"%s"}`, version, pad, stamp)
	case k == 16:
		return fmt.Sprintf(`{"type":"summary","summary":"s %d"}`, i)
	case k == 17:
		return `not json at all ` + pad
	default:
		return fmt.Sprintf(`{"type":"system","subtype":"other",%s"timestamp":"%s"}`, version, stamp)
	}
}

func TestClaudeTranscriptTailFirstReadMatchesTheWholeFile(t *testing.T) {
	old := claudeTailWindows
	t.Cleanup(func() { claudeTailWindows = old })
	base := t.TempDir()
	t.Setenv("CLAUDE_PROJECTS_DIR", base)
	dir := filepath.Join(base, "-work")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	// The tail windows are one package-wide setting, so the seeds go through the same steps in the same order, together: every seed's step under
	// one setting runs in parallel, then the setting changes. A seed's own steps stay in order, and its random numbers are drawn in the same order
	// as when each seed ran start to finish.
	type seedRun struct {
		seed     int64
		rng      *rand.Rand
		rare     string
		sid      string
		path     string
		windows  []int64
		ts       time.Time
		body     string
		r        *SessionReader
		want     claudeTurnCache
		got      claudeTurnCache
		appended bool
	}
	runs := make([]*seedRun, 400)
	for i := range runs {
		seed := int64(i)
		sid := fmt.Sprintf("00000000-0000-4000-8000-%012d", seed)
		w := []int64{200, 800, 3200}
		if (seed/4)%2 == 1 {
			w = []int64{4000, 16000} // most of these transcripts end inside the first tail
		}
		runs[i] = &seedRun{seed: seed, rng: rand.New(rand.NewSource(seed)), rare: []string{"", "version", "event", "model"}[seed%4], sid: sid,
			path: filepath.Join(dir, sid+".jsonl"), windows: w, ts: time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)}
	}
	// step runs fn for the seeds that pick selects, all together, with the tail windows set to w.
	step := func(w []int64, pick func(*seedRun) bool, fn func(*seedRun) error) {
		claudeTailWindows = w
		var wg sync.WaitGroup
		sem := make(chan struct{}, 2*runtime.GOMAXPROCS(0))
		for _, sr := range runs {
			if !pick(sr) {
				continue
			}
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				if err := fn(sr); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
	}
	all := func(*seedRun) bool { return true }
	scan := func(sr *seedRun) (claudeTurnCache, *SessionReader) {
		r := NewSessionReader()
		return r.scanClaudeTranscript(sr.sid, "/work"), r
	}
	same := func(a, b claudeTurnCache) bool {
		return a.event == b.event && a.at.Equal(b.at) && a.version == b.version && a.model == b.model && reflect.DeepEqual(a.apiErr, b.apiErr)
	}
	// 1. the transcript is written, and read whole
	step(nil, all, func(sr *seedRun) error {
		n := sr.rng.Intn(120)
		var sb strings.Builder
		for i := 0; i < n; i++ {
			sr.ts = sr.ts.Add(time.Second)
			sb.WriteString(tailRecord(sr.rng, i, sr.ts, sr.rare))
			sb.WriteString("\n")
		}
		body := sb.String()
		if sr.rng.Intn(5) == 0 && len(body) > 0 {
			body = body[:len(body)-1] // the last record has no newline yet
		}
		sr.body = body
		if err := os.WriteFile(sr.path, []byte(body), 0o600); err != nil {
			return err
		}
		sr.want, _ = scan(sr)
		return nil
	})
	// 2. the first read, tail first, under each seed's windows
	var cases, tailAnswered, wholeRead, neededGrowth, afterAppend, withAPIError, withEvent int
	for _, group := range []int64{0, 1} {
		inGroup := func(sr *seedRun) bool { return (sr.seed/4)%2 == group }
		step(runs[int(group)*4].windows, inGroup, func(sr *seedRun) error {
			sr.got, sr.r = scan(sr)
			if !same(sr.want, sr.got) {
				return fmt.Errorf("seed %d: first read: whole file %+v, tail first %+v", sr.seed, sr.want, sr.got)
			}
			return nil
		})
	}
	for _, sr := range runs {
		cases++
		if sr.got.from > 0 {
			tailAnswered++
			if int64(len(sr.body))-sr.got.from > sr.windows[0] { // a window longer than the first one answered
				neededGrowth++
			}
		} else if sr.want.size > sr.windows[0] {
			wholeRead++
		}
		if sr.got.apiErr.Kind != "" {
			withAPIError++
		}
		if sr.got.event != "" {
			withEvent++
		}
	}
	// 3. what is appended after the first read is followed, and gives the whole file's state
	step(nil, all, func(sr *seedRun) error {
		more := &strings.Builder{}
		for i := 0; i < sr.rng.Intn(15); i++ {
			sr.ts = sr.ts.Add(time.Second)
			more.WriteString(tailRecord(sr.rng, 1000+i, sr.ts, sr.rare) + "\n")
		}
		if more.Len() == 0 {
			return nil
		}
		f, err := os.OpenFile(sr.path, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		if len(sr.body) > 0 && sr.body[len(sr.body)-1] != '\n' {
			f.WriteString("\n")
		}
		f.WriteString(more.String())
		f.Close()
		sr.appended = true
		return nil
	})
	got2 := map[int64]claudeTurnCache{}
	var mu sync.Mutex
	for _, group := range []int64{0, 1} {
		pick := func(sr *seedRun) bool { return sr.appended && (sr.seed/4)%2 == group }
		step(runs[int(group)*4].windows, pick, func(sr *seedRun) error {
			g := sr.r.scanClaudeTranscript(sr.sid, "/work")
			mu.Lock()
			got2[sr.seed] = g
			mu.Unlock()
			return nil
		})
	}
	step(nil, func(sr *seedRun) bool { return sr.appended }, func(sr *seedRun) error {
		want2, _ := scan(sr)
		mu.Lock()
		g := got2[sr.seed]
		mu.Unlock()
		if !same(want2, g) {
			return fmt.Errorf("seed %d: after an append: whole file %+v, tail first then followed %+v", sr.seed, want2, g)
		}
		return nil
	})
	for _, sr := range runs {
		if sr.appended {
			afterAppend++
		}
	}
	t.Logf("cases %d: tail answered %d (needed a longer tail %d), whole file read %d, with an API error %d, with a turn end %d, appended to %d",
		cases, tailAnswered, neededGrowth, wholeRead, withAPIError, withEvent, afterAppend)
	for name, n := range map[string]int{"tail answered": tailAnswered, "a longer tail needed": neededGrowth, "whole file read": wholeRead,
		"an API error": withAPIError, "a turn end": withEvent, "appended after": afterAppend} {
		if n < 40 {
			t.Fatalf("floor: %s only %d times", name, n)
		}
	}
}
