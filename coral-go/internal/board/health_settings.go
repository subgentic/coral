package board

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// HealthSettings is a team's health check configuration (#4175, the operator: "allow the
// operator to configure the health check in the team settings"). A team that never sets it
// gets the defaults (DefaultHealthSettings). Only the Operator changes it, locally (Security's
// #4176 rules 16 and 17: PUT /api/board/{project}/settings); every value is clamped on the
// server (rule 7), and the recipient must be a member of this board (rule 18).
type HealthSettings struct {
	On               bool               `json:"on"`
	IntervalMin      int                `json:"interval_min"` // the check's cadence
	Recipient        string             `json:"recipient"`    // "" = the team's orchestrator
	AllClear         bool               `json:"all_clear"`    // send the one-line check when nothing needs the orchestrator
	DefaultReviewers []string           `json:"default_reviewers"`
	AutoDelegate     HealthRuleOn       `json:"auto_delegate"`
	ClaimNudge       HealthClaimNudge   `json:"claim_nudge"`
	StatusNudge      HealthStatusNudge  `json:"status_nudge"`
	MentionRenudge   HealthMentionNudge `json:"mention_renudge"`
	// HeldNotice tells the Operator about an agent whose automated messages have waited at a
	// dialog for AfterMin (#4175 step 3).
	HeldNotice HealthMentionNudge `json:"held_notice"`
	// The signals of work done off the books (#7793, goal #21): each is a line of the orchestrator's check, once per occurrence, and each is a switch.
	// BusyNoTask: an agent in a turn for AfterMin with no task in progress. PostNoTask: a commit, SHA or patch posted with no task number by an agent
	// with no task in progress. UploadNoTask: an artifact uploaded by an agent with no task in progress.
	BusyNoTask   HealthMentionNudge `json:"busy_no_task"`
	PostNoTask   HealthRuleOn       `json:"post_no_task"`
	UploadNoTask HealthRuleOn       `json:"upload_no_task"`
	// GoalSize tells the orchestrator when a goal has more than Limit tasks (#7808, goal #21 part 6), counting its open and its done ones: once per crossing, and again at each further Limit.
	GoalSize HealthGoalSize `json:"goal_size"`
	// AskReminder reminds a member, once, of a question (post --ask, asks.go) that @mentions them and that they have not answered for AfterMin (#7794). It runs for a team whether or not the
	// orchestrator's check is on: a reminder to one agent costs the team nothing.
	AskReminder HealthMentionNudge `json:"ask_reminder"`
	// Landing puts a line in the health check (off by default, #8942, goal #80) when the branch work lands on (Branch, "main" by default) has not moved for WaitMin although tasks were approved or completed
	// since it last did (#8942, goal #80): done work that is not landed. It reads the local branch only, never CI or GitHub.
	Landing HealthLanding `json:"landing"`
	// Release puts a line in the health check (off by default, #8948, goal #80) when Branch has been past the newest tag matching TagPattern for longer than WaitMin with tasks completed since the tag:
	// work that is landed and not released. It reads local branches and tags only.
	Release HealthRelease `json:"release"`
}

// HealthRelease: the branch and the tag pattern (a git glob, "v*" by default) to compare, how long the branch may be past the newest matching tag before Coral says so, and who else is told.
type HealthRelease struct {
	On         bool   `json:"on"`
	Branch     string `json:"branch"`
	TagPattern string `json:"tag_pattern"`
	WaitMin    int    `json:"wait_min"`
	Nudge      string `json:"nudge"`
}

// ReleaseWaitMin and ReleaseWaitMax bound the release wait, in minutes (an hour to thirty days).
const (
	ReleaseWaitMin = 60
	ReleaseWaitMax = 43200
)

// ReleaseTagPatternValid says a tag pattern is one Coral reads: letters, digits and . _ - / * ? [ ] ^, not starting with -, at most 60 bytes. It is an argument of git tag --list, never a shell.
func ReleaseTagPatternValid(p string) bool {
	if p == "" || len(p) > 60 || p[0] == '-' {
		return false
	}
	for _, r := range p {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._-/*?[]^", r)) {
			return false
		}
	}
	return true
}

// Problem is what is wrong with the setting as a user saves it, in words for them, or "". A field a body does not carry (empty, 0) is the default and is not a problem.
func (r HealthRelease) Problem() string {
	if b := strings.TrimSpace(r.Branch); b != "" && !LandingBranchValid(b) {
		return fmt.Sprintf("release.branch: %q is not a branch name Coral reads (letters, digits, . _ - /; at most 100 characters)", OneLine(b))
	}
	if p := strings.TrimSpace(r.TagPattern); p != "" && !ReleaseTagPatternValid(p) {
		return fmt.Sprintf("release.tag_pattern: %q is not a tag pattern Coral reads (letters, digits, . _ - / and the glob characters * ? [ ]; at most 60 characters)", OneLine(p))
	}
	if r.WaitMin != 0 && (r.WaitMin < ReleaseWaitMin || r.WaitMin > ReleaseWaitMax) {
		return fmt.Sprintf("release.wait_min: %d is outside %d to %d minutes", r.WaitMin, ReleaseWaitMin, ReleaseWaitMax)
	}
	return ""
}

// HealthLanding: the branch to watch and how long it may stand still, with tasks finished, before Coral says so (again after each further WaitMin until it moves).
type HealthLanding struct {
	On      bool   `json:"on"`
	Branch  string `json:"branch"`
	WaitMin int    `json:"wait_min"`
	// Nudge is the member also told, by a message of its own, when the alert is new; "" tells nobody beyond the check's recipient (the orchestrator, or whom the team set).
	Nudge string `json:"nudge"`
}

// LandingWaitMin and LandingWaitMax bound the wait, in minutes.
const (
	LandingWaitMin = 15
	LandingWaitMax = 10080
)

// Problem is what is wrong with the setting as a user saves it, in words for them, or "". A field a body does not carry (empty branch, wait 0) is the default and is not a problem.
func (l HealthLanding) Problem() string {
	if b := strings.TrimSpace(l.Branch); b != "" && !LandingBranchValid(b) {
		return fmt.Sprintf("landing.branch: %q is not a branch name Coral reads (letters, digits, . _ - /; at most 100 characters)", OneLine(b))
	}
	if l.WaitMin != 0 && (l.WaitMin < LandingWaitMin || l.WaitMin > LandingWaitMax) {
		return fmt.Sprintf("landing.wait_min: %d is outside %d to %d minutes", l.WaitMin, LandingWaitMin, LandingWaitMax)
	}
	return ""
}

// LandingBranchValid says a branch name is one Coral reads: letters, digits and . _ - /, not starting with - or /, no "..", at most 100 bytes. It goes into a git ref name, never a shell.
func LandingBranchValid(b string) bool {
	if b == "" || len(b) > 100 || b[0] == '-' || b[0] == '/' || strings.Contains(b, "..") || strings.HasSuffix(b, "/") || strings.HasSuffix(b, ".lock") {
		return false
	}
	for _, r := range b {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' || r == '/') {
			return false
		}
	}
	return true
}

// HealthGoalSize: say it once a goal's tasks pass Limit (then again at 2 x Limit, 3 x Limit ...).
type HealthGoalSize struct {
	On    bool `json:"on"`
	Limit int  `json:"limit"`
}

// HealthRuleOn is a rule that is only on or off.
type HealthRuleOn struct {
	On bool `json:"on"`
}

// HealthClaimNudge: nudge an idle agent to claim its work after AfterMin, escalate after Nudges.
type HealthClaimNudge struct {
	On       bool `json:"on"`
	AfterMin int  `json:"after_min"`
	Nudges   int  `json:"nudges"`
}

// HealthStatusNudge: ask for a status after AfterMin without activity, escalate EscalateAfterMin later.
type HealthStatusNudge struct {
	On               bool `json:"on"`
	AfterMin         int  `json:"after_min"`
	EscalateAfterMin int  `json:"escalate_after_min"`
}

// HealthMentionNudge: remind the orchestrator of a mention unanswered for AfterMin.
type HealthMentionNudge struct {
	On       bool `json:"on"`
	AfterMin int  `json:"after_min"`
}

// DefaultHealthSettings are the design's values. The check is OFF for a team that has not turned it on (#4962, the operator: it
// uses tokens each time and a user may not know what it does); the rules and numbers below are what it uses once it is on.
func DefaultHealthSettings() HealthSettings {
	return HealthSettings{
		On: false, IntervalMin: 10, AllClear: true,
		AutoDelegate:   HealthRuleOn{On: true},
		ClaimNudge:     HealthClaimNudge{On: true, AfterMin: 10, Nudges: 2},
		StatusNudge:    HealthStatusNudge{On: true, AfterMin: 20, EscalateAfterMin: 10},
		MentionRenudge: HealthMentionNudge{On: true, AfterMin: 10},
		HeldNotice:     HealthMentionNudge{On: true, AfterMin: 10},
		BusyNoTask:     HealthMentionNudge{On: true, AfterMin: 10},
		PostNoTask:     HealthRuleOn{On: true},
		UploadNoTask:   HealthRuleOn{On: true},
		GoalSize:       HealthGoalSize{On: true, Limit: 15},
		AskReminder:    HealthMentionNudge{On: true, AfterMin: 15},
		Landing:        HealthLanding{On: false, Branch: "main", WaitMin: 120},
		Release:        HealthRelease{On: false, Branch: "main", TagPattern: "v*", WaitMin: 1440},
	}
}

// Clamp keeps every value in its range (#4176 rule 7): times at least 5 and at most 1440
// minutes (the landing wait 15 to 10080), nudge counts 1 to 5, at most 8 default reviewers.
func (h HealthSettings) Clamp() HealthSettings {
	h.IntervalMin = min(max(h.IntervalMin, 5), 1440)
	h.ClaimNudge.AfterMin = min(max(h.ClaimNudge.AfterMin, 5), 1440)
	h.ClaimNudge.Nudges = min(max(h.ClaimNudge.Nudges, 1), 5)
	h.StatusNudge.AfterMin = min(max(h.StatusNudge.AfterMin, 5), 1440)
	h.StatusNudge.EscalateAfterMin = min(max(h.StatusNudge.EscalateAfterMin, 5), 1440)
	h.MentionRenudge.AfterMin = min(max(h.MentionRenudge.AfterMin, 5), 1440)
	h.HeldNotice.AfterMin = min(max(h.HeldNotice.AfterMin, 5), 1440)
	h.BusyNoTask.AfterMin = min(max(h.BusyNoTask.AfterMin, 5), 1440)
	h.GoalSize.Limit = min(max(h.GoalSize.Limit, 5), 500)
	h.AskReminder.AfterMin = min(max(h.AskReminder.AfterMin, 5), 1440)
	h.Landing.Branch = strings.TrimSpace(h.Landing.Branch)
	if !LandingBranchValid(h.Landing.Branch) {
		h.Landing.Branch = "main"
	}
	if h.Landing.WaitMin == 0 { // a body that does not carry the setting: the default wait, not the shortest
		h.Landing.WaitMin = 120
	}
	h.Landing.WaitMin = min(max(h.Landing.WaitMin, LandingWaitMin), LandingWaitMax)
	h.Landing.Nudge = strings.TrimSpace(h.Landing.Nudge)
	h.Release.Branch = strings.TrimSpace(h.Release.Branch)
	if !LandingBranchValid(h.Release.Branch) {
		h.Release.Branch = "main"
	}
	h.Release.TagPattern = strings.TrimSpace(h.Release.TagPattern)
	if !ReleaseTagPatternValid(h.Release.TagPattern) {
		h.Release.TagPattern = "v*"
	}
	if h.Release.WaitMin == 0 {
		h.Release.WaitMin = 1440
	}
	h.Release.WaitMin = min(max(h.Release.WaitMin, ReleaseWaitMin), ReleaseWaitMax)
	h.Release.Nudge = strings.TrimSpace(h.Release.Nudge)
	h.Recipient = strings.TrimSpace(h.Recipient)
	var revs []string
	for _, r := range h.DefaultReviewers {
		if r = strings.TrimSpace(r); r != "" && len(revs) < 8 {
			revs = append(revs, r)
		}
	}
	h.DefaultReviewers = revs
	return h
}

const settingHealth = "health"

// GetHealthSettings returns a board's health settings, the defaults when none are stored.
func (s *Store) GetHealthSettings(ctx context.Context, project string) HealthSettings {
	h := DefaultHealthSettings()
	if v, err := s.boardSettingValue(ctx, project, settingHealth); err == nil && v != "" {
		_ = json.Unmarshal([]byte(v), &h)
	}
	return h.Clamp()
}

// SetHealthSettings stores a board's health settings, clamped (the settings route's own save goes through BoardSettingsUpdate; this is for the rest of the server and tests).
// SetHealthSettings has no production caller: it is exported for tests in background, server/routes.
func (s *Store) SetHealthSettings(ctx context.Context, project string, h HealthSettings) error {
	return s.setHealthSettings(ctx, project, h)
}

func (s *Store) setHealthSettings(ctx context.Context, project string, h HealthSettings) error {
	raw, err := json.Marshal(h.Clamp())
	if err != nil {
		return err
	}
	return s.SetBoardSetting(ctx, project, settingHealth, string(raw))
}

// HealthOnByProject is, for each board that stores health settings, whether its check is on. A board with none is not in the map:
// it has the default (DefaultHealthSettings().On). A read that fails is an error and not an empty map: an empty map reads as every team
// having the default (off), and the live list's rows flipped a team's icon off for the tick (#5119).
func (s *Store) HealthOnByProject(ctx context.Context) (map[string]bool, error) {
	out := map[string]bool{}
	var rows []struct {
		Project string `db:"project"`
		Value   string `db:"value"`
	}
	if err := s.reader().SelectContext(ctx, &rows, `SELECT project, value FROM board_settings WHERE key = ?`, settingHealth); err != nil {
		return nil, err
	}
	for _, r := range rows {
		h := DefaultHealthSettings()
		if json.Unmarshal([]byte(r.Value), &h) == nil {
			out[r.Project] = h.On
		}
	}
	return out, nil
}

// SetHealthOn turns a board's health check on or off, leaving every other health setting as it is stored (or the defaults).
func (s *Store) SetHealthOn(ctx context.Context, project string, on bool) error {
	h := s.GetHealthSettings(ctx, project)
	h.On = on
	return s.setHealthSettings(ctx, project, h)
}

const healthDefaultOffMarker = "migration:health_default_off"

// migrateHealthDefaultOff keeps the teams that were running the health check when its default became OFF (#4962): a team that never
// stored a health setting had the check on by default, so the first time this runs it stores "on" for every board that exists and has
// none. It runs once (a marker row in board_settings under the project "~store"); a board made later has the new default, off.
func (s *Store) migrateHealthDefaultOff(ctx context.Context) error {
	var done []string
	if err := s.db.SelectContext(ctx, &done, `SELECT value FROM board_settings WHERE project = '~store' AND key = ?`, healthDefaultOffMarker); err != nil {
		return err
	}
	if len(done) > 0 {
		return nil
	}
	tx, err := s.db.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO board_settings (project, key, value)
		SELECT p.project, ?, '{"on":true}' FROM (
			SELECT DISTINCT project FROM board_subscribers WHERE is_active = 1
			UNION SELECT DISTINCT project FROM board_messages
		) p WHERE p.project <> ''`, settingHealth); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO board_settings (project, key, value) VALUES ('~store', ?, 'done')`, healthDefaultOffMarker); err != nil {
		return err
	}
	return tx.Commit()
}
