package routes

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"unicode"

	"github.com/subgentic/coral/internal/agent"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/ptr"
	"github.com/subgentic/coral/internal/store"
)

// "What you can do on this team" (#17622, the Operator: "the orchestrator on the other team doesn't know that it can launch agents"): the Orchestrator's prompt lists what its team's settings let it do, one line for each
// setting that changes that. ONE function composes the lines from the settings (orchestratorCanDo), and the launch prompt, a restart's or wake's prompt and the notice sent when the Operator changes a setting while
// the Orchestrator runs all use it, so they say the same words and a new setting adds one entry to orchestratorAbilities. A setting that is off by default adds a line only when its off text tells the Orchestrator what
// to do instead.

// teamAbilities is the team's settings as they decide what its Orchestrator may do, with what its text needs to be exact: this team's board, folder, agent type and model.
type teamAbilities struct {
	MayLaunch bool     // the Operator's grant of the team's Orchestrator is on (#11432): launching is held to the team's folder and caps and put on the team's board
	MayStop   bool     // the grant's separate stop switch is on (#17348); it counts only while MayLaunch is on, as coral-board stop needs both
	BoardID   string   // the team's board id
	Dir       string   // the team's folder
	AgentType string   // the seat's own agent type: the team's
	Model     string   // the seat's own model ("" when it runs on its CLI's default): the team's
	Pool      []string // the team's reviewer pool (#17612): empty when the team has none
}

// orchestratorAbilities is every setting that contributes a line, in the order the section lists them. A line is "" when the setting adds nothing.
var orchestratorAbilities = []func(teamAbilities) string{launchAbility, stopAbility, restAbility, poolAbility}

// stopAbility is the line for coral-board stop (#17348), which needs the main switch AND its own: with the main switch off the launch line already sends the Orchestrator to the Operator, so this adds nothing; with it
// on, the command when stop is on and ask the Operator when it is off.
func stopAbility(a teamAbilities) string {
	if !a.MayLaunch {
		return ""
	}
	if !a.MayStop {
		return "Stopping a member: the Operator has not allowed you to stop (archive) an agent, so you cannot stop or archive one; when one must be stopped, ask the Operator. You also cannot stop, sleep or remove yourself or the team's last Orchestrator: say so and ask the Operator to use the dashboard."
	}
	return "Stopping a member: coral-board stop <member> archives it: its session ends, it stays on the team (out of the Agents list, its history and tasks kept), and coral-board wake <member> starts it again. To end only a member's current turn, with its session and conversation kept, run coral-board interrupt <member>. An agent at a permission prompt or a dialog, or waiting on a person, is refused; you cannot stop, sleep or remove yourself or the team's last Orchestrator, and coral-board leave is not a way to do it: when asked to, including as 'kick the Orchestrator' (that is a stop request), say so and ask the Operator to use the dashboard."
}

// restAbility is the line for sleep and start (#19673), which need only the main switch: the three states are Awake, Asleep and Archived, and a name stays taken by an archived member.
func restAbility(a teamAbilities) string {
	if !a.MayLaunch {
		return ""
	}
	return "Sleeping and starting a member: coral-board sleep <member> puts a running member to sleep (an archived one becomes asleep, history kept; one already asleep is left as it is); coral-board wake <member> starts a sleeping or an archived member. A name on this team stays taken by an archived member, so to bring that role back start the member instead of launching a new one. To see who is archived or asleep, run coral-board status --json: each agent's availability is archived, sleeping, busy or available."
}

// poolAbility is the line for the team's reviewer pool (#17612): the Orchestrator need not pick between the pool's members, and a member takes review tasks on a bare claim. No pool, no line.
func poolAbility(a teamAbilities) string {
	var names []string
	for _, n := range a.Pool {
		if n = promptValue(n); n != "" {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return ""
	}
	return "Reviewers: besides the default reviewers, each submit also goes to the ONE of the review pool (" + strings.Join(names, ", ") + ") with the fewest open reviews, unless the task names its reviewers, so do not pick between them; the pool's members are offered review tasks on a bare coral-board task claim."
}

// launchAbility is the line for launching agents: on, the exact command; off, ask the Operator (today's text, which is also what the roster note says).
func launchAbility(a teamAbilities) string {
	if !a.MayLaunch {
		return "Adding a member: the Operator has not allowed you to launch agents, so when your plan needs a role the team lacks, ask the Operator to add that agent."
	}
	cmd := "coral-agent launch " + shellWord(promptValue(a.Dir)) + ` --name "<Role>"`
	if t := promptValue(a.AgentType); t != "" {
		cmd += " --type " + shellWord(t)
	}
	if m := promptValue(a.Model); m != "" {
		cmd += " --model " + shellWord(m)
	}
	cmd += ` --prompt "<its job>" --board ` + shellWord(promptValue(a.BoardID))
	return "Adding a member: when your plan needs a role the team lacks, run " + cmd + ". Keep the type and model shown: they are the team's own. If the name you want already belongs to an archived or sleeping member, do not start it on your own: ask the Operator whether to start that member or to pick another name, and launch only after they answer. Starting a new team under the name of another team (409 board_name_exists) is the Operator's choice, including renaming the old team to free the name: ask the Operator. If the launch answers 409 name_archived, that name belongs to an archived member: after the Operator says so, start it with coral-board wake, or launch again with the suggested name. Then post one line naming who you added and why."
}

// orchestratorCanDo is the lines for a team's settings: settings in, lines out.
func orchestratorCanDo(a teamAbilities) []string {
	var lines []string
	for _, ability := range orchestratorAbilities {
		if l := ability(a); l != "" {
			lines = append(lines, l)
		}
	}
	return lines
}

// canDoSection is the lines as the section the prompt carries; "" when there are none.
func canDoSection(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return "What you can do on this team:\n- " + strings.Join(lines, "\n- ")
}

// settingsChangedNotice is what a running Orchestrator is told when a setting changes: the line the prompt would have, so the two never disagree.
func settingsChangedNotice(line string) string {
	return "[Coral] The Operator changed a setting of your team. " + line
}

var plainShellWord = regexp.MustCompile(`^[A-Za-z0-9_./:@%+=,-]+$`)

// shellWord is s as one word a shell reads back unchanged: as it is when it is plain, else in single quotes.
func shellWord(s string) string {
	if plainShellWord.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// modelInFlags is the model a launch's flags name (--model X, --model=X or -m X), "" when none.
func modelInFlags(flags []string) string {
	for i, f := range flags {
		switch {
		case (f == "--model" || f == "-m") && i+1 < len(flags):
			return flags[i+1]
		case strings.HasPrefix(f, "--model="):
			return strings.TrimPrefix(f, "--model=")
		}
	}
	return ""
}

// grantStarting holds the boards of teams the Operator is starting right now: the seat's grant is written once the seat has started (seedTeamGrant), so while its first prompt is built the grant row is not there yet
// but will be on.
var grantStarting sync.Map

// grantIsOn is whether the Operator's grant of this team's Orchestrator is on: the same switch that holds an agent's launch to the team's folders and caps and puts it on the team's board by default.
func grantIsOn(ctx context.Context, bs *board.Store, boardID string) bool {
	if bs == nil || boardID == "" {
		return false
	}
	if _, starting := grantStarting.Load(boardID); starting {
		return true
	}
	g, err := bs.GetOrchGrant(ctx, boardID)
	return err == nil && g.Enabled
}

// BoardAbilitiesSection is the source agent.SetBoardAbilities takes: the section for the Orchestrator being launched, from the team's settings as they are now.
func BoardAbilitiesSection(bs *board.Store, ss *store.SessionStore) func(p agent.LaunchParams, agentType string) string {
	return func(p agent.LaunchParams, agentType string) string {
		model := modelInFlags(p.Flags)
		if model == "" && ss != nil && p.SessionID != "" { // a restart or wake passes no --model when the agent runs on its CLI's default or the stored flags lack it: the row's own model is the team's (#17662)
			if sess, err := ss.GetLiveSession(context.Background(), p.SessionID); err == nil && sess != nil && sess.Model != nil {
				model = *sess.Model
			}
		}
		ctx := context.Background()
		a := teamAbilities{MayLaunch: grantIsOn(ctx, bs, p.BoardName), BoardID: p.BoardName, Dir: p.WorkingDir, AgentType: agentType, Model: model}
		if bs != nil && p.BoardName != "" { // the stop switch and the reviewer pool, as they are now (#17710); a team being started has no row yet: stop is what the seed will write, on
			if g, err := bs.GetOrchGrant(ctx, p.BoardName); err == nil {
				a.MayStop = g.StopEnabled
				if _, starting := grantStarting.Load(p.BoardName); starting && g.SetAt == "" {
					a.MayStop = true // a team the Operator is starting: no row yet, and the seed (SeedOrchGrant) writes stop ON right after the seat starts, so the first prompt says what the grant will be
				}
			}
			a.Pool = bs.GetHealthSettings(ctx, p.BoardName).ReviewerPool
		}
		return canDoSection(orchestratorCanDo(a))
	}
}

// abilitiesOf is a running seat's abilities as its own row says them: its folder, type and model are what its prompt was built with.
func abilitiesOf(sess *store.LiveSession, boardID string, mayLaunch bool) teamAbilities {
	model := ""
	if sess.Model != nil {
		model = *sess.Model
	}
	return teamAbilities{MayLaunch: mayLaunch, BoardID: boardID, Dir: sess.WorkingDir, AgentType: sess.AgentType, Model: model}
}

// tellSeatOfChange tells the team's Orchestrator seat, once, that a setting changed (#17622): the line its prompt would have for it (ability, with the settings set by set), as a board notice to it alone, delivered through the normal notice gate.
// The seat is the session the grant names, and only while it is live on this board; nothing is sent when it is not.
func (h *SessionsHandler) tellSeatOfChange(ctx context.Context, project, seatSession string, ability func(teamAbilities) string, set func(*teamAbilities)) {
	if h.bs == nil || h.ss == nil || seatSession == "" {
		return
	}
	sess, err := h.ss.GetLiveSession(ctx, seatSession)
	if err != nil || sess == nil || sess.IsArchived == 1 || ptr.Value(sess.BoardName) != project {
		return
	}
	member := h.orchActor(sess)
	if member == "" {
		return
	}
	// The line quotes the team's folder and model, which are stored text: defuse it, then post it through the one notice path (the notice census, #9265).
	bh := &BoardHandler{bs: h.bs}
	a := abilitiesOf(sess, project, false)
	set(&a)
	line := ability(a)
	if line == "" {
		return
	}
	notice := settingsChangedNotice(bh.noticeText(ctx, project, line))
	bh.postNotice(ctx, project, fmt.Sprintf("@%s %s", orchName(member), notice), board.CoralSender)
}

// callersTeamModel is the model an agent's launch that names none runs on (#17545): the model of the calling agent's own session, when that agent is seated on the board the new agent joins, that board's grant is on and the
// new agent is of the same type (a model name means nothing to another type). "" for everyone else: the Operator, the dashboard, a launch onto another board or computer, another type, a seat with no stored model.
func (h *SessionsHandler) callersTeamModel(r *http.Request, agentType, boardName, boardServer string) string {
	if boardName == "" || (boardServer != "" && boardServer != "local") || h.ss == nil || h.bs == nil {
		return ""
	}
	owner, ok := VerifiedSession(r.Context())
	if !ok {
		return ""
	}
	sess, err := h.ss.GetLiveSession(r.Context(), owner.SessionID)
	if err != nil || sess == nil || sess.Model == nil || strings.TrimSpace(*sess.Model) == "" || sess.AgentType != agentType || ptr.Value(sess.BoardName) != boardName {
		return ""
	}
	if !grantIsOn(r.Context(), h.bs, boardName) {
		return ""
	}
	return strings.TrimSpace(*sess.Model)
}

// promptValue is a stored value (a folder, a model, a board name) made safe to write into the prompt's one line: every control character, line or paragraph separator and format character (zero-width, bidi) is dropped, so a
// value cannot start a line of its own or hide text (#17662, Security).
func promptValue(v string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, v)
}
