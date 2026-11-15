package resourcequeue

import (
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Spread and capability (#17586, goal #246): a pool hands a claim to the ELIGIBLE member with the lowest recent use, not the first free one in listed order. A member is eligible when it meets every need of the
// claim (the pool's Needs, copied onto the entry) and no health veto closes it. Use is busy slot-seconds in the last UseWindow over slots times weight, so a box that has done little work for its size goes first;
// ties go to the one granted longest ago. The record of use lives in memory: after a restart every box starts level, which is fair, not wrong.

// ErrBadFacts and ErrBadNeeds say what a fact or a need must look like.
var (
	ErrBadFacts   = errors.New("resourcequeue: a fact is name=value (letters, digits and . _ - : /), at most 16 of them")
	ErrBadNeeds   = errors.New("resourcequeue: a need is name=value, name!=value or name>=number, at most 8 of them")
	ErrNoCapable  = errors.New("resourcequeue: no member of this pool can meet the needs of this command")
	ErrBadWeight  = errors.New("resourcequeue: a weight is a whole number from 0 to 1000 (0: 1)")
	factPart      = regexp.MustCompile(`^[A-Za-z0-9._:/-]{1,64}$`)
	needOperators = []string{">=", "!=", "="}
)

// UseWindow is how far back use is counted.
const UseWindow = time.Hour

// span is one finished hold of a member.
type span struct{ from, to time.Time }

// ValidFacts checks a resource's facts.
func ValidFacts(f map[string]string) error {
	if len(f) > 16 {
		return ErrBadFacts
	}
	for k, v := range f {
		if !factPart.MatchString(k) || !factPart.MatchString(v) {
			return ErrBadFacts
		}
	}
	return nil
}

// ValidNeeds checks a list of needs.
func ValidNeeds(needs []string) error {
	if len(needs) > 8 {
		return ErrBadNeeds
	}
	for _, n := range needs {
		k, op, v, ok := splitNeed(n)
		if !ok || !factPart.MatchString(k) || !factPart.MatchString(v) {
			return ErrBadNeeds
		}
		if op == ">=" {
			if _, err := strconv.ParseFloat(v, 64); err != nil {
				return ErrBadNeeds
			}
		}
	}
	return nil
}

func splitNeed(n string) (k, op, v string, ok bool) {
	for _, o := range needOperators { // ">=" and "!=" first: "=" is inside both
		if i := strings.Index(n, o); i > 0 {
			return n[:i], o, n[i+len(o):], true
		}
	}
	return "", "", "", false
}

// Meets reports whether a resource with these facts meets every need. A need on a fact the resource does not state is not met (never guessed), except "!=", which only asks that the fact is not that value.
func Meets(facts map[string]string, needs []string) bool {
	for _, n := range needs {
		k, op, v, ok := splitNeed(n)
		if !ok {
			return false
		}
		have, has := facts[k]
		switch op {
		case "=":
			if !has || have != v {
				return false
			}
		case "!=":
			if has && have == v {
				return false
			}
		case ">=":
			a, e1 := strconv.ParseFloat(have, 64)
			b, e2 := strconv.ParseFloat(v, 64)
			if !has || e1 != nil || e2 != nil || a < b {
				return false
			}
		}
	}
	return true
}

func (r *Resource) weight() int {
	if r.Weight < 1 {
		return 1
	}
	return r.Weight
}

// record keeps a finished hold of member m for the use count.
func (q *Queue) record(m string, e *Entry) {
	if e.Waiting() {
		return
	}
	if q.spans == nil {
		q.spans = map[string][]span{}
	}
	now := q.now()
	kept := q.spans[m][:0]
	for _, s := range q.spans[m] {
		if now.Sub(s.to) < UseWindow {
			kept = append(kept, s)
		}
	}
	q.spans[m] = append(kept, span{e.Granted, now})
}

// useOf is member m's busy slot-seconds in the window (finished holds and the ones going on) over slots times weight.
func (q *Queue) useOf(m string) float64 {
	mr := q.res[m]
	if mr == nil {
		return 0
	}
	now := q.now()
	from := now.Add(-UseWindow)
	var busy float64
	add := func(a, b time.Time) {
		if a.Before(from) {
			a = from
		}
		if b.After(a) {
			busy += b.Sub(a).Seconds()
		}
	}
	for _, s := range q.spans[m] {
		add(s.from, s.to)
	}
	for _, e := range q.entries {
		if !e.Waiting() && (e.Resource == m || e.Member == m) {
			add(e.Granted, now)
			if now.Sub(e.Granted) < time.Second { // a hold that has just begun still counts, so two grants in one instant do not land on one box
				busy += 1 - now.Sub(e.Granted).Seconds()
			}
		}
	}
	return busy / float64(mr.Slots*mr.weight())
}

// lastGrant is when member m was last given to anyone (zero: never in the window).
func (q *Queue) lastGrant(m string) time.Time {
	var last time.Time
	for _, s := range q.spans[m] {
		if s.from.After(last) {
			last = s.from
		}
	}
	for _, e := range q.entries {
		if !e.Waiting() && (e.Resource == m || e.Member == m) && e.Granted.After(last) {
			last = e.Granted
		}
	}
	return last
}

// eligible reports whether waiting entry x may take member m: the member meets x's needs and no veto closes it. A claim on a member by its own name is the agent's own choice and is never vetoed or filtered.
func (q *Queue) eligible(x *Entry, m string) bool {
	if x.Resource == m {
		return true
	}
	mr := q.res[m]
	if mr == nil || !Meets(mr.Facts, x.Needs) {
		return false
	}
	return q.cfg.Veto == nil || !q.cfg.Veto(*mr)
}

// capable reports whether some member of pool r could ever meet the needs (health aside).
func (q *Queue) capable(r *Resource, needs []string) bool {
	if len(needs) == 0 || len(r.Members) == 0 {
		return true
	}
	for _, m := range r.Members {
		if mr := q.res[m]; mr != nil && Meets(mr.Facts, needs) {
			return true
		}
	}
	return false
}

// byUse orders members: lowest use first, then the one granted longest ago, then the listed order.
func (q *Queue) byUse(members []string) []string {
	out := append([]string(nil), members...)
	use := map[string]float64{}
	last := map[string]time.Time{}
	for _, m := range out {
		use[m], last[m] = q.useOf(m), q.lastGrant(m)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if use[a] != use[b] {
			return use[a] < use[b]
		}
		return last[a].Before(last[b])
	})
	return out
}
