package routes

import (
	"log/slog"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/internal/resources"
	"github.com/subgentic/coral/pkg/resourcequeue"
	"github.com/subgentic/coral/pkg/tunnel"
)

// GET /api/analytics/resource-queue?days= (#13671, the Operator's Analytics tab): how much the resource queue is used and whether it improves coordination. NUMBERS ONLY: per resource, per agent and per matched
// pattern counts, wait and hold times, and by day the minutes heavy runs overlapped on one machine and the slot-request posts, before and since the queue went live (QueueGoLive). The queue's own numbers come
// from its history file (resources.History: names, times and the hook's pattern, never a command or a note); the "before" numbers from the board's HEAVY RUN posts, reduced to times and counts by board.HeavyRuns,
// and no post text is ever in the reply. The Operator's alone and read only, on this computer: not through Coral Hub, not an agent's.

// QueueGoLive is the moment the queue became the way to get a heavy machine (the Operator's day, 2026-11-05 16:00 UTC): the line the page draws before/after at.
var QueueGoLive = time.Date(2026, 11, 5, 16, 0, 0, 0, time.UTC)

// ResourceQueueAnalyticsHandler serves the read.
type ResourceQueueAnalyticsHandler struct {
	mu  sync.Mutex
	m   *resources.Manager // set once the queue is open (SetManager): the route is there either way, and says "no queue" until then
	bs  *board.Store
	now func() time.Time
}

// SetManager gives the handler the queue it reads.
func (h *ResourceQueueAnalyticsHandler) SetManager(m *resources.Manager) {
	h.mu.Lock()
	h.m = m
	h.mu.Unlock()
}

func (h *ResourceQueueAnalyticsHandler) manager() *resources.Manager {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.m
}

// NewResourceQueueAnalyticsHandler creates the handler.
func NewResourceQueueAnalyticsHandler(m *resources.Manager, bs *board.Store) *ResourceQueueAnalyticsHandler {
	return &ResourceQueueAnalyticsHandler{m: m, bs: bs}
}

func (h *ResourceQueueAnalyticsHandler) clock() time.Time {
	if h.now != nil {
		return h.now().UTC()
	}
	return time.Now().UTC()
}

func median(d []time.Duration) time.Duration {
	if len(d) == 0 {
		return 0
	}
	s := append([]time.Duration(nil), d...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[len(s)/2]
}

func p90(d []time.Duration) time.Duration {
	if len(d) == 0 {
		return 0
	}
	s := append([]time.Duration(nil), d...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	return s[int(math.Ceil(0.9*float64(len(s))))-1]
}

type rqResource struct {
	Resource    string  `json:"resource"`
	Slots       int     `json:"slots"`
	Claims      int     `json:"claims"`
	BusyPct     float64 `json:"busy_pct"`
	WaitMedianS int64   `json:"wait_median_s"`
	WaitP90S    int64   `json:"wait_p90_s"`
	AtOncePct   float64 `json:"at_once_pct"`
	Auto        int     `json:"auto"`
	Hand        int     `json:"hand"`
	Refused     int     `json:"refused"`
	Kicked      int     `json:"kicked"`
	Expired     int     `json:"expired"`
}

type rqAgent struct {
	Agent string  `json:"agent"`
	Holds int     `json:"holds"`
	Hours float64 `json:"hours"`
}

// rqHour is the claims granted in one hour of the day (UTC), summed over the range, for each resource.
type rqHour struct {
	Hour       int            `json:"hour"`
	ByResource map[string]int `json:"by_resource"`
}

type rqPattern struct {
	Pattern string `json:"pattern"`
	Holds   int    `json:"holds"`
}

type rqDay struct {
	Day         string         `json:"day"`
	Claims      int            `json:"claims"`
	Refused     int            `json:"refused"`
	Kicked      int            `json:"kicked"`
	Expired     int            `json:"expired"`
	ByResource  map[string]int `json:"by_resource"` // claims granted that day, for each resource
	OverlapMac  int            `json:"overlap_mac_min"`
	OverlapMini int            `json:"overlap_mini_min"`
	SlotPosts   int            `json:"slot_posts"`
}

// rqSpan is one side of the cut.
type rqSpan struct {
	Days             float64 `json:"days"`
	OverlapMinPerDay float64 `json:"overlap_min_per_day"`
	SlotPostsPerDay  float64 `json:"slot_posts_per_day"`
	WaitMedianMin    float64 `json:"wait_median_min"` // before: estimated from the posts; since: the queue's own waits (0 samples: -1)
	WaitSamples      int     `json:"wait_samples"`
	WaitUnavailable  bool    `json:"wait_unavailable"` // the queue's own record is not available: not "no samples"
	Runs             int     `json:"runs"`
}

// Read answers the read.
func (h *ResourceQueueAnalyticsHandler) Read(w http.ResponseWriter, r *http.Request) {
	if cloud.Tunneled(r) || r.Header.Get(tunnel.ViaHeader) != "" {
		commentRefuse(w, http.StatusForbidden, "not_through_hub", "the resource queue's analytics are on this computer only")
		return
	}
	if !operatorOnly(w, r) {
		return
	}
	days := 7
	if v := r.URL.Query().Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n <= 0 {
			errBadRequest(w, "days is a positive number")
			return
		}
		days = n
	}
	if days > resources.HistoryDays {
		days = resources.HistoryDays
	}
	now := h.clock()
	until := now.Truncate(24 * time.Hour).Add(24 * time.Hour) // the end of today, UTC
	since := until.Add(-time.Duration(days) * 24 * time.Hour)

	m := h.manager()
	out := map[string]any{"days_asked": days, "generated_at": now.Format(time.RFC3339), "go_live": QueueGoLive.Format(time.RFC3339), "queue": m != nil, "history": m != nil && m.History() != nil}
	var evs []resourcequeue.Event
	if m != nil && m.History() != nil {
		m.History().Flush()
		var err error
		if evs, err = m.History().Events(since, until); err != nil {
			slog.Error("resource history read failed", "error", err)
			errInternalServer(w, "the read failed")
			return
		}
		out["dropped"] = m.History().Dropped()
	}
	out["resources"], out["by_agent"], out["by_pattern"], out["per_day"], out["by_hour"], out["queue_wait_s"] = h.fromHistory(m, evs, since, until, now)

	var posts []board.HeavyPost
	if h.bs != nil {
		var err error
		if posts, err = h.bs.HeavyPosts(r.Context(), "", since, until); err != nil {
			slog.Error("resource queue baseline read failed", "error", err)
			errInternalServer(w, "the read failed")
			return
		}
	}
	runs := board.HeavyRuns(posts, now)
	overlap := board.OverlapMinutes(runs)
	slots := board.SlotRequestPosts(posts)
	unclosed := 0
	for _, r := range runs {
		if r.Unclosed {
			unclosed++
		}
	}
	out["heavy"] = map[string]any{"runs": len(runs), "unclosed": unclosed, "overlap_by_day": overlap, "slot_posts_by_day": slots}
	out["per_day"] = mergeDays(out["per_day"].([]rqDay), overlap, slots, since, until)
	out["before_after"] = h.beforeAfter(runs, posts, evs, m != nil && m.History() != nil, since, now)
	writeJSON(w, http.StatusOK, out)
}

func dayOf(t time.Time) string { return t.UTC().Format("2006-01-02") }

func mergeDays(days []rqDay, overlap map[string]map[string]int, slots map[string]int, since, until time.Time) []rqDay {
	byDay := map[string]*rqDay{}
	for i := range days {
		byDay[days[i].Day] = &days[i]
	}
	var out []rqDay
	for d := since; d.Before(until); d = d.Add(24 * time.Hour) {
		k := dayOf(d)
		row := rqDay{Day: k}
		if x := byDay[k]; x != nil {
			row = *x
		}
		row.OverlapMac, row.OverlapMini, row.SlotPosts = overlap[k]["Mac"], overlap[k]["mini"], slots[k]
		out = append(out, row)
	}
	return out
}

func (h *ResourceQueueAnalyticsHandler) fromHistory(m *resources.Manager, evs []resourcequeue.Event, since, until, now time.Time) (any, any, any, []rqDay, []rqHour, any) {
	type acc struct {
		rqResource
		waits []time.Duration
		held  time.Duration
		once  int
	}
	res := map[string]*acc{}
	get := func(k string) *acc {
		if res[k] == nil {
			res[k] = &acc{rqResource: rqResource{Resource: k}}
		}
		return res[k]
	}
	if m != nil {
		for _, st := range m.Queue().All() {
			get(st.Resource.Key).Slots = st.Resource.Slots
			for _, e := range st.Holders { // a hold still going counts up to now
				from := e.Granted
				if from.Before(since) {
					from = since
				}
				get(st.Resource.Key).held += now.Sub(from)
			}
		}
	}
	agents := map[string]*rqAgent{}
	patterns := map[string]int{}
	days := map[string]*rqDay{}
	day := func(t time.Time) *rqDay {
		k := dayOf(t)
		if days[k] == nil {
			days[k] = &rqDay{Day: k}
		}
		return days[k]
	}
	var allWaits []time.Duration
	hours := make([]rqHour, 24)
	for i := range hours {
		hours[i] = rqHour{Hour: i, ByResource: map[string]int{}}
	}
	for _, e := range evs {
		a := get(e.Resource)
		d := day(e.At)
		switch e.Kind {
		case "granted":
			a.Claims++
			d.Claims++
			if d.ByResource == nil {
				d.ByResource = map[string]int{}
			}
			d.ByResource[e.Resource]++
			hours[e.At.UTC().Hour()].ByResource[e.Resource]++
			a.waits = append(a.waits, e.Wait)
			allWaits = append(allWaits, e.Wait)
			if e.Wait < time.Second {
				a.once++
			}
			if e.Via == "hook" {
				a.Auto++
			} else {
				a.Hand++
			}
			if e.Pattern != "" {
				patterns[e.Pattern]++
			}
			if agents[e.Agent] == nil {
				agents[e.Agent] = &rqAgent{Agent: e.Agent}
			}
			agents[e.Agent].Holds++
		case "refused":
			a.Refused++
			d.Refused++
		case "kicked":
			a.Kicked++
			d.Kicked++
		case "expired":
			a.Expired++
			d.Expired++
		}
		if e.Held > 0 && (e.Kind == "released" || e.Kind == "kicked" || e.Kind == "expired" || e.Kind == "gone") {
			a.held += e.Held
			if agents[e.Agent] == nil {
				agents[e.Agent] = &rqAgent{Agent: e.Agent}
			}
			agents[e.Agent].Hours += e.Held.Hours()
		}
	}
	span := until.Sub(since)
	var rs []rqResource
	keys := make([]string, 0, len(res))
	for k := range res {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		a := res[k]
		a.WaitMedianS, a.WaitP90S = int64(median(a.waits).Seconds()), int64(p90(a.waits).Seconds())
		if a.Claims > 0 {
			a.AtOncePct = math.Round(1000*float64(a.once)/float64(a.Claims)) / 10
		}
		if a.Slots > 0 {
			a.BusyPct = math.Round(10000*float64(a.held)/(float64(a.Slots)*float64(span))) / 100
		}
		rs = append(rs, a.rqResource)
	}
	var as []rqAgent
	for _, a := range agents {
		a.Hours = math.Round(a.Hours*100) / 100
		as = append(as, *a)
	}
	sort.Slice(as, func(i, j int) bool {
		if as[i].Holds != as[j].Holds {
			return as[i].Holds > as[j].Holds
		}
		return as[i].Agent < as[j].Agent
	})
	var ps []rqPattern
	for p, n := range patterns {
		ps = append(ps, rqPattern{Pattern: p, Holds: n})
	}
	sort.Slice(ps, func(i, j int) bool {
		if ps[i].Holds != ps[j].Holds {
			return ps[i].Holds > ps[j].Holds
		}
		return ps[i].Pattern < ps[j].Pattern
	})
	var ds []rqDay
	for _, d := range days {
		ds = append(ds, *d)
	}
	sort.Slice(ds, func(i, j int) bool { return ds[i].Day < ds[j].Day })
	if rs == nil {
		rs = []rqResource{}
	}
	if as == nil {
		as = []rqAgent{}
	}
	if ps == nil {
		ps = []rqPattern{}
	}
	return rs, as, ps, ds, hours, map[string]any{"median": int64(median(allWaits).Seconds()), "p90": int64(p90(allWaits).Seconds()), "n": len(allWaits)}
}

// beforeAfter cuts the range at QueueGoLive, to the minute: the posts and run minutes before the cut are one side, those from the cut on the other (a run or an overlap that crosses the cut is split, a post at the cut
// is "since"), so nothing is counted on both sides. A side with nothing of the range in it says so by Days = 0. recorded says whether the queue's own record is available: without it the since wait is unavailable,
// never "no samples".
func (h *ResourceQueueAnalyticsHandler) beforeAfter(runs []board.HeavyRun, posts []board.HeavyPost, evs []resourcequeue.Event, recorded bool, since, now time.Time) map[string]any {
	cut := QueueGoLive
	side := func(from, to time.Time, queueWaits bool) rqSpan {
		var sp rqSpan
		if !to.After(from) {
			return sp
		}
		sp.Days = math.Round(to.Sub(from).Hours()/24*100) / 100
		days := to.Sub(from).Hours() / 24
		in := board.PostsIn(posts, from, to)
		sp.OverlapMinPerDay = math.Round(float64(board.OverlapMinutesIn(runs, from, to))/days*10) / 10
		sp.SlotPostsPerDay = math.Round(float64(countPosts(board.SlotRequestPosts(in)))/days*10) / 10
		for _, r := range runs {
			if !r.Start.Before(from) && r.Start.Before(to) {
				sp.Runs++
			}
		}
		var ws []time.Duration
		if queueWaits {
			if !recorded {
				sp.WaitUnavailable = true
				sp.WaitMedianMin = -1
				return sp
			}
			for _, e := range evs {
				if e.Kind == "granted" && !e.At.Before(from) && e.At.Before(to) {
					ws = append(ws, e.Wait)
				}
			}
		} else {
			for _, w := range board.SlotWaits(in, runs) {
				ws = append(ws, w.Wait)
			}
		}
		sp.WaitSamples = len(ws)
		sp.WaitMedianMin = -1
		if len(ws) > 0 {
			sp.WaitMedianMin = math.Round(median(ws).Minutes()*10) / 10
		}
		return sp
	}
	after := since
	if cut.After(after) {
		after = cut
	}
	beforeEnd := cut
	if now.Before(beforeEnd) {
		beforeEnd = now
	}
	return map[string]any{"cut": cut.Format(time.RFC3339), "before": side(since, beforeEnd, false), "since": side(after, now, true)}
}

func countPosts(byDay map[string]int) int {
	n := 0
	for _, c := range byDay {
		n += c
	}
	return n
}
