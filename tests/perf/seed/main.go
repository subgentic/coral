// Command perfseed seeds an isolated Coral data dir with a BIG dataset for the Goal #85 baseline (#9086): 5,000 tasks, 50,000 board messages, 2,000 artifacts, 30 agents on one team,
// 40 goals, 40,000 usage rows and 3,000 commits over 30 days, and a second small team. It is a MEASUREMENT helper only; it changes no product code. Build it inside the coral-go module (it
// imports internal packages) the way tests/latency does, and run it against an EMPTY CORAL_DATA_DIR before a server starts there:
//
//	cp -r tests/perf/seed coral-go/cmd/perfseed
//	cd coral-go && go build -tags "dev fts5" -o /path/perfseed ./cmd/perfseed && rm -r cmd/perfseed
//
// It never touches ~/.coral: -datadir is required and must not be the default folder.
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/store"
)

type targets struct {
	DataDir     string   `json:"data_dir"`
	ProjectsDir string   `json:"projects_dir"`
	BoardID     string   `json:"board_id"`
	SmallBoard  string   `json:"small_board_id"`
	SessionIDs  []string `json:"session_ids"`
	SessionName []string `json:"session_names"`
	Tasks       int      `json:"tasks"`
	Messages    int      `json:"messages"`
	Artifacts   int      `json:"artifacts"`
	Goals       int      `json:"goals"`
	GoalIDs     []int64  `json:"goal_ids"`
	TaskIDs     []int64  `json:"sample_task_ids"`
	ArtifactIDs []string `json:"sample_artifact_ids"`
}

func main() {
	var (
		dataDir   = flag.String("datadir", "", "CORAL_DATA_DIR path (must be empty or new, never ~/.coral)")
		projects  = flag.String("projects", "", "CLAUDE_PROJECTS_DIR path")
		out       = flag.String("out", "", "targets JSON output path")
		nTasks    = flag.Int("tasks", 5000, "tasks on the big team")
		nMessages = flag.Int("messages", 50000, "board messages on the big team")
		nArtifact = flag.Int("artifacts", 2000, "artifacts (stored objects linked from completed tasks)")
		nAgents   = flag.Int("agents", 30, "live agents on the big team")
		nGoals    = flag.Int("goals", 40, "goals on the big team")
		nUsage    = flag.Int("usage", 40000, "token usage rows over 30 days")
		nCommits  = flag.Int("commits", 3000, "commits over 30 days")
		seed      = flag.Int64("seed", 85, "random seed")
	)
	flag.Parse()
	if *dataDir == "" || *projects == "" || *out == "" {
		fatal("need -datadir, -projects, -out")
	}
	home, _ := os.UserHomeDir()
	if abs, _ := filepath.Abs(*dataDir); abs == filepath.Join(home, ".coral") {
		fatal("refusing the default data folder")
	}
	rng := rand.New(rand.NewSource(*seed))
	ctx := context.Background()
	must(os.MkdirAll(*dataDir, 0o700))
	must(os.MkdirAll(*projects, 0o700))
	workRoot := filepath.Join(*dataDir, "work")
	must(os.MkdirAll(workRoot, 0o700))

	db, err := store.OpenWithKey(ctx, filepath.Join(*dataDir, "sessions.db"), "")
	must(err)
	defer db.Close()
	ss := store.NewSessionStore(db)
	ts := store.NewTokenUsageStore(db)
	gs := store.NewGitStore(db)
	boardPath := filepath.Join(*dataDir, "messageboard.db")
	bs, err := board.NewStoreWithKey(boardPath, "")
	must(err)

	// The seeded agents are not running CLIs: nothing may wake them after the server starts (a woken agent would start whatever CLI is on the PATH).
	must(ss.SetSetting(ctx, "auto_wake_after_restart", "false"))
	big, err := bs.CreateBoard(ctx, "Perf Big", "Operator")
	must(err)
	small, err := bs.CreateBoard(ctx, "Perf Small", "Operator")
	must(err)
	t := targets{DataDir: *dataDir, ProjectsDir: *projects, BoardID: big.ID, SmallBoard: small.ID, Tasks: *nTasks, Messages: *nMessages, Artifacts: *nArtifact, Goals: *nGoals}

	// ---- agents: live sessions, subscribers, a small transcript each
	roles := []string{"Backend Dev", "Frontend Dev", "QA Engineer", "Security Reviewer", "UI Reviewer", "DevOps Engineer", "Data Science", "Docs"}
	models := []string{"claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.5", "gpt-5.5-codex"}
	types := []string{"claude", "claude", "claude", "codex", "codex"}
	var names []string
	_, err = bs.Subscribe(ctx, big.ID, "Operator", "Operator", "", nil, "all")
	must(err)
	_, err = bs.Subscribe(ctx, big.ID, "Lead", "Orchestrator", "", nil, "all")
	must(err)
	names = append(names, "Lead")
	for i := 0; i < *nAgents; i++ {
		id := uuid.NewString()
		workdir := filepath.Join(workRoot, fmt.Sprintf("agent%02d", i))
		must(os.MkdirAll(workdir, 0o700))
		role := roles[i%len(roles)]
		dn := fmt.Sprintf("%s %d", role, i/len(roles)+1)
		agentType := types[i%len(types)]
		bn := big.ID
		backend := "pty"
		model := models[i%len(models)]
		created := time.Now().UTC().Add(-time.Duration(30-i%25) * 24 * time.Hour).Format(time.RFC3339Nano)
		must(ss.RegisterLiveSession(ctx, &store.LiveSession{SessionID: id, AgentType: agentType, AgentName: filepath.Base(workdir), WorkingDir: workdir, DisplayName: &dn, BoardName: &bn, Backend: &backend, Model: &model, CreatedAt: created}))
		sessionName := agentType + "-" + id
		_, err := bs.Subscribe(ctx, big.ID, dn, role, sessionName, nil, "mentions")
		must(err)
		if agentType == "claude" {
			tp := filepath.Join(*projects, strings.ReplaceAll(workdir, "/", "-"), id+".jsonl")
			must(os.MkdirAll(filepath.Dir(tp), 0o700))
			writeTranscript(tp, 256*1024)
		}
		t.SessionIDs = append(t.SessionIDs, id)
		t.SessionName = append(t.SessionName, sessionName)
		names = append(names, dn)
	}
	fmt.Printf("[seed] %d agents\n", *nAgents)

	// ---- goals
	for g := 0; g < *nGoals; g++ {
		gl, err := bs.CreateGoal(ctx, big.ID, board.GoalInput{Title: fmt.Sprintf("Goal %d: make the %s better", g+1, []string{"dashboard", "board", "terminal", "installer", "analytics"}[g%5]),
			Outcome: "An outcome a team can check.", DoneWhen: "It is done when the tasks are.", State: "active", CreatedBy: "Operator", Driver: names[1+g%*nAgents]})
		must(err)
		t.GoalIDs = append(t.GoalIDs, gl.ID)
	}

	// ---- artifacts (objects and sidecars in the store's own layout), linked from the first completed tasks
	objDir := filepath.Join(*dataDir, "artifacts", "objects")
	must(os.MkdirAll(objDir, 0o700))
	artifactFor := func(i int) board.TaskArtifact {
		body := []byte(fmt.Sprintf("# Report %d\n\n%s\n", i, strings.Repeat("A finding about the system, with numbers 12345 and a path internal/x/y.go. ", 20+rng.Intn(100))))
		sum := sha256.Sum256(body)
		hx := hex.EncodeToString(sum[:])
		must(os.WriteFile(filepath.Join(objDir, hx), body, 0o600))
		meta, _ := json.Marshal(map[string]any{"name": fmt.Sprintf("report-%d.md", i), "media_type": "text/markdown", "size": len(body), "digest": "sha256:" + hx})
		must(os.WriteFile(filepath.Join(objDir, hx+".json"), meta, 0o600))
		if len(t.ArtifactIDs) < 5 {
			t.ArtifactIDs = append(t.ArtifactIDs, hx)
		}
		return board.TaskArtifact{Name: fmt.Sprintf("report-%d.md", i), URI: "coral://artifacts/" + hx, Digest: "sha256:" + hx, MediaType: "text/markdown", Kind: "report"}
	}

	// ---- tasks: ~70% completed (the first ones carry an artifact), a few in progress, the rest pending
	completed := *nTasks * 7 / 10
	inProgress := min(*nAgents, 25)
	artifactsMade := 0
	for i := 0; i < *nTasks; i++ {
		who := names[1+i%*nAgents]
		goal := t.GoalIDs[i%len(t.GoalIDs)]
		tk, err := bs.CreateTaskWithOpts(ctx, big.ID, fmt.Sprintf("Task %d: %s", i+1, []string{"fix the list", "add the route", "review the patch", "measure the load", "write the docs", "tidy the tests"}[i%6]),
			strings.Repeat("The body of a task explains what to do and how to check it. ", 3+rng.Intn(10)), []string{"low", "medium", "high", "critical"}[i%4], "Operator", &board.CreateTaskOpts{GoalID: &goal}, who)
		must(err)
		switch {
		case i < completed:
			_, err = bs.ClaimTask(ctx, big.ID, who, tk.ID)
			must(err)
			msg := "done"
			var arts []board.TaskArtifact
			if artifactsMade < *nArtifact {
				arts = append(arts, artifactFor(artifactsMade))
				artifactsMade++
			}
			_, err = bs.CompleteTaskWithArtifacts(ctx, big.ID, tk.ID, who, &msg, "success", arts)
			must(err)
		case i < completed+inProgress:
			_, err = bs.ClaimTask(ctx, big.ID, who, tk.ID)
			must(err)
		}
		if len(t.TaskIDs) < 5 && i >= completed/2 {
			t.TaskIDs = append(t.TaskIDs, tk.ID)
		}
		if (i+1)%1000 == 0 {
			fmt.Printf("[seed] %d tasks, %d artifacts\n", i+1, artifactsMade)
		}
	}
	for artifactsMade < *nArtifact { // artifacts beyond the completed tasks' are stored objects nobody links (an upload not yet attached)
		artifactFor(artifactsMade)
		artifactsMade++
	}

	// ---- messages
	for i := 0; i < *nMessages; i++ {
		who := names[rng.Intn(len(names))]
		text := fmt.Sprintf("Message %d from %s: %s", i+1, who, strings.Repeat("progress on the task, with a few details and a number 4242. ", 1+rng.Intn(6)))
		if i%9 == 0 {
			text += " @" + strings.ReplaceAll(names[rng.Intn(len(names))], " ", "-")
		}
		_, err := bs.PostMessage(ctx, big.ID, who, text, nil)
		must(err)
		if (i+1)%10000 == 0 {
			fmt.Printf("[seed] %d messages\n", i+1)
		}
	}
	// a second small team
	_, err = bs.Subscribe(ctx, small.ID, "Operator", "Operator", "", nil, "all")
	must(err)
	_, err = bs.Subscribe(ctx, small.ID, "Small Dev", "Developer", "", nil, "all")
	must(err)
	for i := 0; i < 200; i++ {
		_, err := bs.CreateTask(ctx, small.ID, fmt.Sprintf("Small task %d", i+1), "a body", "medium", "Operator", "Small Dev")
		must(err)
	}
	for i := 0; i < 2000; i++ {
		_, err := bs.PostMessage(ctx, small.ID, "Small Dev", fmt.Sprintf("Small message %d", i+1), nil)
		must(err)
	}
	must(bs.Close())

	// spread the tasks' times over 30 days (the Analytics windows read them) and the messages' too
	raw, err := sql.Open("sqlite", boardPath+"?_pragma=busy_timeout(5000)")
	must(err)
	now := time.Now().UTC()
	_, err = raw.Exec(`UPDATE board_tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', ?, '-' || ((id * 7919) % 43200) || ' minutes', '-1 day'),
		claimed_at = CASE WHEN claimed_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%SZ', ?, '-' || ((id * 7919) % 43200) || ' minutes') END,
		completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%SZ', ?, '-' || ((id * 7919) % 43200) || ' minutes', '+' || (20 + id % 200) || ' minutes') END
		WHERE board_id = ?`, now.Format(time.RFC3339), now.Format(time.RFC3339), now.Format(time.RFC3339), big.ID)
	must(err)
	_, err = raw.Exec(`UPDATE board_messages SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', ?, '-' || ((id * 104729) % 43200) || ' minutes') WHERE project = ?`, now.Format(time.RFC3339), big.ID)
	must(err)
	must(raw.Close())
	fmt.Printf("[seed] board times spread over 30 days\n")

	// ---- usage rows and commits for the Analytics views
	batch := make([]*store.TokenUsage, 0, 500)
	for i := 0; i < *nUsage; i++ {
		si := rng.Intn(*nAgents)
		at := now.Add(-time.Duration(rng.Intn(30*24*60)) * time.Minute)
		in := 500 + rng.Intn(20000)
		bn := big.ID
		batch = append(batch, &store.TokenUsage{SessionID: t.SessionIDs[si], AgentName: names[1+si], AgentType: types[si%len(types)], BoardName: &bn, InputTokens: in, OutputTokens: in / 4, TotalTokens: in + in/4,
			CostUSD: float64(in) / 200000, Model: models[si%len(models)], Thinking: []string{"low", "medium", "high", ""}[i%4], Source: "jsonl", RecordedAt: at.Format(store.ISOFormat), SessionStartAt: at.Add(-time.Hour).Format(store.ISOFormat)})
		if len(batch) == cap(batch) {
			for _, e := range ts.RecordUsageBatch(ctx, batch) {
				must(e)
			}
			batch = batch[:0]
		}
	}
	for _, e := range ts.RecordUsageBatch(ctx, batch) {
		must(e)
	}
	for i := 0; i < *nCommits; i++ {
		si := rng.Intn(*nAgents)
		at := now.Add(-time.Duration(rng.Intn(30*24*60)) * time.Minute).Format(time.RFC3339)
		sid := t.SessionIDs[si]
		must(gs.UpsertGitSnapshot(ctx, &store.GitSnapshot{AgentName: names[1+si], AgentType: types[si%len(types)], WorkingDirectory: filepath.Join(workRoot, fmt.Sprintf("agent%02d", si)), Branch: fmt.Sprintf("feature-%d", si%7),
			CommitHash: fmt.Sprintf("%040x", rng.Int63()), CommitSubject: fmt.Sprintf("Commit %d: change the thing", i), CommitTimestamp: &at, SessionID: &sid}))
	}
	// A real install keeps raw usage rows for two days and hourly rows before that (the retention job): roll the seeded history up the same way, so the usage reads are measured over the shape they have in use
	// (a first baseline run left all 40,000 rows raw, which no install does).
	hours, rolled, err := db.RollupTokenUsage(ctx, now.Add(-48*time.Hour), 100000)
	must(err)
	fmt.Printf("[seed] rolled up %d raw usage rows into %d hourly groups\n", rolled, hours)
	fmt.Printf("[seed] %d usage rows, %d commits\n", *nUsage, *nCommits)

	data, _ := json.MarshalIndent(t, "", "  ")
	must(os.WriteFile(*out, data, 0o600))
	fmt.Printf("[seed] wrote %s\n", *out)
}

func writeTranscript(path string, n int64) {
	f, err := os.Create(path)
	must(err)
	defer f.Close()
	w := bufio.NewWriterSize(f, 1<<20)
	defer w.Flush()
	filler := strings.Repeat("The quick brown fox jumps over the lazy dog. ", 20)
	var written int64
	for i := 0; written < n; i++ {
		var m map[string]any
		if i%2 == 0 {
			m = map[string]any{"type": "user", "timestamp": "2026-10-15T00:00:00.000Z", "message": map[string]any{"role": "user", "content": fmt.Sprintf("Message %d: please continue the work.", i)}}
		} else {
			m = map[string]any{"type": "assistant", "timestamp": "2026-10-15T00:00:00.000Z", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": fmt.Sprintf("Reply %d. %s", i, filler)}}}}
		}
		b, _ := json.Marshal(m)
		w.Write(b)
		w.WriteByte('\n')
		written += int64(len(b)) + 1
	}
}

func must(err error) {
	if err != nil {
		fatal(err.Error())
	}
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "[seed] FATAL:", msg)
	os.Exit(1)
}
