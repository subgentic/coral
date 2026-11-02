package background

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/subgentic/coral/internal/agent"
	at "github.com/subgentic/coral/internal/agenttypes"
	"github.com/subgentic/coral/internal/hermesdb"
	"github.com/subgentic/coral/internal/store"
	"github.com/subgentic/coral/internal/transcriptlink"
)

// SetHermesDataDir gives the poller the Coral data folder a Hermes agent's own home lives under (agent.HermesAgentHome). Without it Hermes agents are not polled. Must be called before Run.
func (p *TokenPoller) SetHermesDataDir(dir string) { p.hermesDir = dir }

// hermesRecordModel is the model a Hermes poll is recorded under: the id alone ("provider/vendor-model" is "vendor-model", as Pi's is), "" when the column holds anything that is not a model name (a control
// character, over maxPiModelLen bytes): it is Hermes's own text.
func hermesRecordModel(m string) string {
	m = strings.TrimSpace(m)
	if m == "" || len(m) > maxPiModelLen {
		return ""
	}
	for _, r := range m {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	if i := strings.Index(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	return m
}

// hermesStateStamp is the state of a Hermes home's database files (size and modification time of state.db and its write-ahead file), so a poll opens the database only when Hermes wrote to it.
func hermesStateStamp(home string) string {
	var parts []string
	for _, name := range []string{"state.db", "state.db-wal"} {
		fi, err := os.Lstat(filepath.Join(home, name))
		if err != nil {
			parts = append(parts, "-")
			continue
		}
		parts = append(parts, fmt.Sprintf("%d:%d", fi.Size(), fi.ModTime().UnixNano()))
	}
	return strings.Join(parts, "|")
}

// pollHermesSession records the tokens of a Hermes agent (#12041). Hermes keeps no transcript file: its session row in the agent's own state.db has running totals (input_tokens, output_tokens), which this
// reads read-only through hermesdb, by the session id its hooks bound to this Coral session. What is recorded is the growth of the totals over what is already recorded for the session (so a server
// restart, or a poller that dropped its state, never counts a session twice), as one row per poll that saw growth. Hermes states no cache tokens or cost: a cost is derived from the model as for the others.
func (p *TokenPoller) pollHermesSession(ctx context.Context, ls *store.LiveSession) {
	if p.hermesDir == "" || !transcriptlink.IsSessionID(ls.SessionID) {
		return
	}
	hermesID := transcriptlink.HermesSession(p.hermesDir, ls.SessionID)
	if hermesID == "" {
		return
	}
	team := ""
	if ls.BoardName != nil {
		team = *ls.BoardName
	}
	home := agent.HermesAgentHome(p.hermesDir, team, ls.SessionID)
	if home == "" {
		return
	}
	stamp := hermesStateStamp(home) + "#" + hermesID
	if p.hermesStamps[ls.SessionID] == stamp {
		return
	}
	db, err := hermesdb.Open(home)
	if err != nil {
		return // no database yet, or a layout Coral does not read: nothing is recorded, and the next write tries again
	}
	row, ok, err := db.Session(ctx, hermesID)
	db.Close()
	if err != nil || !ok {
		return
	}
	p.hermesStamps[ls.SessionID] = stamp
	if row.InputTokens <= 0 && row.OutputTokens <= 0 {
		return
	}
	var haveIn, haveOut int
	if u, err := p.usageStore.GetSessionUsage(ctx, ls.SessionID); err == nil && u != nil {
		haveIn, haveOut = u.InputTokens, u.OutputTokens
	}
	in, out := int(row.InputTokens)-haveIn, int(row.OutputTokens)-haveOut
	if in < 0 { // a total that went down (Hermes started the session over): never a negative row
		in = 0
	}
	if out < 0 {
		out = 0
	}
	if in == 0 && out == 0 {
		return
	}
	agentName := ""
	if ls.DisplayName != nil {
		agentName = *ls.DisplayName
	}
	started := ""
	if row.StartedAt > 0 {
		started = time.Unix(int64(row.StartedAt), 0).UTC().Format(store.ISOFormat)
	}
	rec := &store.TokenUsage{
		SessionID:      ls.SessionID,
		AgentName:      agentName,
		AgentType:      at.Hermes,
		TeamID:         ls.TeamID,
		BoardName:      ls.BoardName,
		InputTokens:    in,
		OutputTokens:   out,
		TotalTokens:    in + out,
		SessionStartAt: started,
		Source:         "jsonl", // the source the per-session views prefer over the proxy's, as Pi's and Codex's file-read rows are (store.sourceDedup): Hermes's own record of its calls
		Model:          hermesRecordModel(row.Model),
	}
	if err := p.usageStore.RecordUsage(ctx, rec); err != nil {
		p.logger.Error("failed to record Hermes usage", "session_id", ls.SessionID, "error", err)
	}
}
