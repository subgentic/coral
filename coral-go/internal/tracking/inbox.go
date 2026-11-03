package tracking

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/secfile"
)

// Inbox telemetry (#7512, #7458 addendum). Three events, each built here from closed lists and bounded numbers only: never an id, a title, a text, an agent,
// board, task or file name. The page reports inbox_opened by name; the server works out what is waiting and sends the actions from the handlers that do them,
// for a person's own actions only.
const (
	EventInboxOpened       = "inbox_opened"        // the Inbox was opened (at most once per install per UTC day)
	EventInboxWaiting      = "inbox_waiting"       // what was waiting when it was opened, one event per kind
	EventInboxItemActioned = "inbox_item_actioned" // a person acted on an item
)

// The kinds of item, as the server knows them.
const (
	InboxAgentWait  = "agent_wait" // an agent waits on a permission, a question, a plan or a sign-in
	InboxReview     = "review"     // a file for review
	InboxRun        = "run"        // a failed automation run
	InboxProposal   = "proposal"   // a goal or task an agent proposed
	InboxGoalDone   = "goal_done"  // a goal that looks done
	InboxSkill      = "skill"      // a skill to approve
	InboxAsk        = "ask"        // a question an agent asked the Operator
	InboxWait       = "wait"       // an agent's wait on the Operator
	InboxUnrecorded = "unrecorded" // agents whose notices are held until they are recorded
	InboxOther      = "other"
)

var (
	inboxKinds    = []string{InboxAgentWait, InboxReview, InboxRun, InboxProposal, InboxGoalDone, InboxSkill, InboxAsk, InboxWait, InboxUnrecorded}
	inboxSubKinds = []string{"permission", "question", "plan", "login", InboxOther}
	inboxActions  = []string{"answer", "dismiss", "approve", "changes", "deny", "ignore", "save", "unsave", "seen", "reject", "close", "hide", "button", "record"}
	inboxSurfaces = []string{"inbox", "chat", InboxOther}
	inboxBuckets  = []string{"0", "1-2", "3-5", "6+"}
)

// inboxActionSeconds bounds secs_to_action: seven days.
const inboxActionSeconds = 7 * 24 * 3600

// The daily caps (the Orchestrator's #7520 decision on Security's D4): at most 50 events per kind and action, and 200 inbox events in all, per install per
// UTC day. Past a cap an action is counted but not sent.
const (
	inboxCapPerAction = 50
	inboxCapPerDay    = 200
)

func init() {
	eventSpecs[EventInboxOpened] = map[string]propSpec{"waiting": enum(inboxBuckets...)}
	eventSpecs[EventInboxWaiting] = map[string]propSpec{"kind": enum(inboxKinds...), "waiting": enum(inboxBuckets...)}
	eventSpecs[EventInboxItemActioned] = map[string]propSpec{
		"kind": enum(inboxKinds...), "sub_kind": enum(inboxSubKinds...), "action": enum(inboxActions...),
		"surface": enum(inboxSurfaces...), "secs_to_action": intRange(0, inboxActionSeconds),
	}
}

// InboxBucket is a count as the funnel's closed buckets: 0, 1-2, 3-5 or 6+.
func InboxBucket(n int) string {
	switch {
	case n <= 0:
		return "0"
	case n <= 2:
		return "1-2"
	case n <= 5:
		return "3-5"
	}
	return "6+"
}

// InboxSurface maps the page's word for where an action was taken (X-Coral-Surface) through the closed list: anything else is other.
func InboxSurface(s string) string {
	if s == "inbox" || s == "chat" {
		return s
	}
	return InboxOther
}

// InboxSubKind maps an agent wait's kind through the closed list: anything else is other.
func InboxSubKind(s string) string {
	for _, k := range inboxSubKinds {
		if k == s {
			return s
		}
	}
	return InboxOther
}

// ── The day's counts ────────────────────────────────────────────────────

const inboxDayFileName = ".inbox_day.json"

// inboxDay is the day's counts, kept in the data folder so a restart does not reset the caps. It holds counts and a date, nothing else.
type inboxDay struct {
	Day    string         `json:"day"`
	Opened bool           `json:"opened,omitempty"`
	Total  int            `json:"total,omitempty"`
	Per    map[string]int `json:"per,omitempty"`
}

var inboxMu sync.Mutex

func inboxToday() string { return time.Now().UTC().Format("2006-01-02") }

func loadInboxDay() inboxDay {
	var d inboxDay
	if data, err := os.ReadFile(filepath.Join(resolveCoralDir(), inboxDayFileName)); err == nil {
		_ = json.Unmarshal(data, &d)
	}
	if d.Day != inboxToday() {
		d = inboxDay{Day: inboxToday()}
	}
	return d
}

func saveInboxDay(d inboxDay) bool {
	data, err := json.Marshal(d)
	if err != nil {
		return false
	}
	if err := secfile.WriteFileNoFollow(filepath.Join(resolveCoralDir(), inboxDayFileName), data, 0o600); err != nil {
		logDeliveryFailure("inbox_day", 0, "inbox counts not kept: "+err.Error())
		return false
	}
	return true
}

// inboxSendable reports whether inbox events can go at all now: a data folder, a key and analytics on. With analytics off nothing is counted either.
func inboxSendable() bool {
	return stateDirReady() && posthogKeyPresent() && telemetryEnabled()
}

// takeInboxSlots counts n events of key (kind|action, or "" for the opened events) against today's caps and reports whether they may be sent.
// The kind and action's own count goes up either way (counted but not sent past its cap); the day's total counts what is sent. A day whose counts cannot be
// saved sends nothing.
func takeInboxSlots(d *inboxDay, key string, n int) bool {
	if d.Per == nil {
		d.Per = map[string]int{}
	}
	ok := d.Total+n <= inboxCapPerDay && (key == "" || d.Per[key]+n <= inboxCapPerAction)
	if ok {
		d.Total += n // the day's total is what was sent: an action past its own cap does not use up the others' room
	}
	if key != "" {
		d.Per[key] += n // every action of the kind is counted, sent or not
	}
	return ok
}

// TrackInboxOpened records that a person opened the Inbox, at most once per install per UTC day, with what was waiting: the total and each kind, as buckets.
// waiting holds the server's own counts by kind; a kind not on the list is not sent.
func TrackInboxOpened(waiting map[string]int) {
	if !inboxSendable() {
		return
	}
	inboxMu.Lock()
	d := loadInboxDay()
	if d.Opened {
		inboxMu.Unlock()
		return
	}
	d.Opened = true
	total := 0
	var kinds []string
	for _, k := range inboxKinds {
		if n := waiting[k]; n > 0 {
			total += n
			kinds = append(kinds, k)
		}
	}
	ok := takeInboxSlots(&d, "", 1+len(kinds))
	saved := saveInboxDay(d)
	inboxMu.Unlock()
	if !ok || !saved {
		return
	}
	TrackEvent(EventInboxOpened, map[string]string{"waiting": InboxBucket(total)})
	for _, k := range kinds {
		TrackEvent(EventInboxWaiting, map[string]string{"kind": k, "waiting": InboxBucket(waiting[k])})
	}
}

// TrackInboxActioned records a person's action on an item: kind and action from the closed lists (an action off them sends nothing), sub_kind for an agent
// wait, the surface, and the whole seconds since the item began when the server knows it (created is the zero time otherwise, and past seven days it is left out).
func TrackInboxActioned(kind, subKind, action, surface string, created time.Time) {
	if !inboxSendable() {
		return
	}
	props := map[string]string{"kind": kind, "action": action, "surface": InboxSurface(surface)}
	if kind == InboxAgentWait {
		props["sub_kind"] = InboxSubKind(subKind)
	}
	if !created.IsZero() {
		if secs := int(time.Since(created) / time.Second); secs >= 0 && secs <= inboxActionSeconds {
			props["secs_to_action"] = strconv.Itoa(secs)
		}
	}
	typed, _ := sanitizeProps(EventInboxItemActioned, props)
	for k := range props {
		if typed[k] == nil {
			return // a value off its list: nothing is counted or sent
		}
	}
	inboxMu.Lock()
	d := loadInboxDay()
	ok := takeInboxSlots(&d, kind+"|"+action, 1)
	saved := saveInboxDay(d)
	inboxMu.Unlock()
	if ok && saved {
		TrackEvent(EventInboxItemActioned, props)
	}
}
