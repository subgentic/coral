package machinelaunch

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// sweepProvider is a Lister that answers each look from a script and records every call: a test pins from the calls alone that nothing is deleted except by id.
type sweepProvider struct {
	*stubProvider
	looks   [][]Instance // one answer per list call; the last repeats
	listErr error
	lists   int
	// staysListed: a deleted machine still shows in the list (the delete is not confirmed)
	staysListed bool
	// lagReads: the first this-many lists after a delete still show the machine, as a provider does for a few seconds
	lagReads int
	ghost    []Instance
}

// Delete forgets the machine unless staysListed: a provider whose delete is not yet visible in the list.
func (p *sweepProvider) Delete(ctx context.Context, id string) error {
	err := p.stubProvider.Delete(ctx, id)
	if err == nil && p.lagReads > 0 {
		for _, look := range p.looks {
			p.ghost = append(p.ghost, look...)
		}
	}
	if err == nil && !p.staysListed {
		for i, look := range p.looks {
			var keep []Instance
			for _, in := range look {
				if in.ID != id {
					keep = append(keep, in)
				}
			}
			p.looks[i] = keep
		}
	}
	return err
}

func (p *sweepProvider) List(context.Context) ([]Instance, error) {
	p.lists++
	p.calls = append(p.calls, "list")
	if p.listErr != nil {
		return nil, p.listErr
	}
	if p.lagReads > 0 && p.ghost != nil {
		p.lagReads--
		return p.ghost, nil
	}
	i := p.lists - 1
	if i >= len(p.looks) {
		i = len(p.looks) - 1
	}
	return p.looks[i], nil
}

func sweepFixture(looks ...[]Instance) (*sweepProvider, sweepWant, *bytes.Buffer) {
	return &sweepProvider{stubProvider: &stubProvider{}, looks: looks}, sweepWant{Name: "coral-1", Region: "ams3", Size: "s-1vcpu-2gb", Since: time.Now().Add(-time.Second)}, &bytes.Buffer{}
}

func mineAt(tag string) Instance {
	return Instance{ID: "d1", Name: "coral-1", Region: "ams3", Size: "s-1vcpu-2gb", Created: time.Now(), Tags: []string{Tag, tag}}
}

func init() { sweepConfirmEvery = time.Millisecond } // the confirming reads, close together in tests

const sweepTag = "coral-launch-0123456789abcdef0123456789abcdef"

// A create may sweep when it got NO answer (a timeout, a cut connection, an interruption) or a 5xx answer with no droplet id; a 4xx and the auth errors never do (Security's limit 4, as corrected for 5xx).
func TestCreateMayHaveLanded(t *testing.T) {
	for name, err := range map[string]error{
		"deadline": context.DeadlineExceeded, "wrapped deadline": errors.Join(errors.New("create"), context.DeadlineExceeded), "cancelled": context.Canceled,
		"eof": io.EOF, "unexpected eof": io.ErrUnexpectedEOF, "net timeout": &net.DNSError{IsTimeout: true},
		"500": &APIError{Status: 500}, "502": &APIError{Status: 502}, "503": &APIError{Status: 503}, "504": &APIError{Status: 504}, "wrapped 502": errors.Join(errors.New("create"), &APIError{Status: 502}),
	} {
		if !createMayHaveLanded(err) {
			t.Errorf("%s may have landed", name)
		}
	}
	for name, err := range map[string]error{
		"nil": nil, "400": &APIError{Status: 400}, "401": &APIError{Status: 401}, "403": &APIError{Status: 403}, "404": &APIError{Status: 404}, "422": &APIError{Status: 422}, "429": &APIError{Status: 429}, "499": &APIError{Status: 499},
		"unauthorized": ErrUnauthorized, "not found": ErrNotFound, "plain": errors.New("an ssh key is not an id"),
	} {
		if createMayHaveLanded(err) {
			t.Errorf("%s never sweeps", name)
		}
	}
}

func TestSweepAnAnswerNeverListsOrDeletes(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 422, 429} {
		p, want, out := sweepFixture([]Instance{mineAt(sweepTag)})
		note, clean := sweepAfterFailedCreate(p, sweepTag, want, &APIError{Status: status}, time.Millisecond, nil, out)
		if p.lists != 0 || len(p.calls) != 0 || note != "" || !clean {
			t.Fatalf("HTTP %d: lists %d, calls %v, note %q, clean %v", status, p.lists, p.calls, note, clean)
		}
	}
}

func TestSweepDeletesTheOneMatchingMachineByIDAndPrintsIt(t *testing.T) {
	p, want, out := sweepFixture([]Instance{mineAt(sweepTag), {ID: "other", Name: "coral-1", Tags: []string{Tag}}})
	note, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out)
	if !clean || strings.Join(p.calls, ",") != "list,delete:d1,list" || p.lists != 2 { // list, delete by id, list again to confirm it is gone
		t.Fatalf("clean %v, calls %v", clean, p.calls)
	}
	if !strings.Contains(out.String(), "Deleted machine d1 (tag "+sweepTag+")") || !strings.Contains(note, "d1") || !strings.Contains(out.String(), "id d1") {
		t.Fatalf("the ids and the tag are printed: %q / %q", out.String(), note)
	}
}

// Anything that does not match what the launch asked for deletes NOTHING, prints what it saw, and says to check by hand (limit 3).
func TestSweepRefusesAMismatch(t *testing.T) {
	for name, edit := range map[string]func(*Instance){
		"name":         func(i *Instance) { i.Name = "someone-elses" },
		"region":       func(i *Instance) { i.Region = "nyc3" },
		"size":         func(i *Instance) { i.Size = "s-8vcpu-16gb" },
		"old":          func(i *Instance) { i.Created = time.Now().Add(-time.Hour) },
		"no created":   func(i *Instance) { i.Created = time.Time{} },
		"before start": func(i *Instance) { i.Created = time.Now().Add(-10 * time.Minute) },
	} {
		in := mineAt(sweepTag)
		edit(&in)
		p, want, out := sweepFixture([]Instance{in})
		note, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out)
		if clean || strings.Contains(strings.Join(p.calls, ","), "delete") || !strings.Contains(note, "check by hand") || !strings.Contains(out.String(), "id d1") || !strings.Contains(note, sweepTag) {
			t.Errorf("%s: clean %v, calls %v, note %q, out %q", name, clean, p.calls, note, out.String())
		}
	}
}

func TestSweepRefusesMoreThanOneMachine(t *testing.T) {
	a, b := mineAt(sweepTag), mineAt(sweepTag)
	b.ID = "d2"
	p, want, out := sweepFixture([]Instance{a, b})
	note, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out)
	if clean || strings.Contains(strings.Join(p.calls, ","), "delete") || !strings.Contains(note, "2 machines") || !strings.Contains(out.String(), "d1") || !strings.Contains(out.String(), "d2") {
		t.Fatalf("clean %v, calls %v, note %q", clean, p.calls, note)
	}
}

func TestSweepAListFailureDeletesNothingAndLeavesTheNetwork(t *testing.T) {
	p, want, out := sweepFixture()
	p.listErr = errors.New("down")
	note, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out)
	if clean || strings.Contains(strings.Join(p.calls, ","), "delete") || !strings.Contains(note, sweepTag) || p.lists != 1 {
		t.Fatalf("clean %v, calls %v, note %q", clean, p.calls, note)
	}
}

// Two looks: a machine that shows only in the second list is handled the same way; after that the launch ends and says the tag.
func TestSweepSecondLookFindsALateMachineAndNothingFindsNothing(t *testing.T) {
	p, want, out := sweepFixture(nil, []Instance{mineAt(sweepTag)})
	if _, clean := sweepAfterFailedCreate(p, sweepTag, want, io.ErrUnexpectedEOF, time.Millisecond, nil, out); !clean || p.lists != 3 || !strings.Contains(strings.Join(p.calls, ","), "delete:d1") {
		t.Fatalf("clean %v, lists %d, calls %v", clean, p.lists, p.calls)
	}
	p, want, out = sweepFixture(nil)
	note, clean := sweepAfterFailedCreate(p, sweepTag, want, io.ErrUnexpectedEOF, time.Millisecond, nil, out)
	if clean || p.lists != 2 || !strings.Contains(note, sweepTag) || !strings.Contains(note, "check by hand") {
		t.Fatalf("clean %v, lists %d, note %q", clean, p.lists, note)
	}
}

// A SECOND Ctrl-C ends the wait at once, prints the tag and "check by hand", and deletes nothing.
func TestSweepSecondInterruptEndsTheWaitAtOnce(t *testing.T) {
	p, want, out := sweepFixture(nil)
	stop := make(chan struct{})
	close(stop)
	start := time.Now()
	note, clean := sweepAfterFailedCreate(p, sweepTag, want, context.Canceled, time.Hour, stop, out)
	if time.Since(start) > 5*time.Second || clean || p.lists != 1 || !strings.Contains(note, "interrupted a second time") || !strings.Contains(note, sweepTag) || !strings.Contains(strings.ToLower(out.String()), "check by hand") {
		t.Fatalf("clean %v, lists %d, note %q, took %s", clean, p.lists, note, time.Since(start))
	}
}

func TestSweepAFailedDeleteIsPrintedAndNotClean(t *testing.T) {
	p, want, out := sweepFixture([]Instance{mineAt(sweepTag)})
	p.deleteErr = errors.New("refused")
	note, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out)
	if clean || !strings.Contains(out.String(), "Could NOT delete machine d1") || !strings.Contains(note, "could NOT be deleted") || strings.Count(strings.Join(p.calls, ","), "delete:d1") != 1 {
		t.Fatalf("clean %v, calls %v, note %q, out %q", clean, p.calls, note, out.String())
	}
}

// The package has no delete-by-tag call: a delete request names a droplet id and never a tag (limit 2). The one delete that names a tag is of the TAG ITSELF (DELETE /tags/coral-launch-...: the label a
// launch made for its firewall, #13592), which removes no droplet; it is allowed on that exact path only, and deleteLaunchTag refuses any name that does not start with coral-launch-.
func TestNoDeleteByTagAnywhere(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(b), "\n") {
			if strings.Contains(line, "MethodDelete") && strings.Contains(line, `"/tags/"+name`) && strings.Contains(line, "delete a tag") {
				continue
			}
			if strings.Contains(line, "MethodDelete") && (strings.Contains(strings.ToLower(line), "tag") || strings.Contains(line, "?")) {
				t.Errorf("%s:%d: a delete that names a tag or a query: %s", f, i+1, strings.TrimSpace(line))
			}
		}
	}
}

// Deleted is not gone: the launch's network may come off only when a read after the delete no longer shows the machine (Security's ruling, #9934).
func TestSweepDeleteThatIsNotConfirmedGoneIsNotClean(t *testing.T) {
	p, want, out := sweepFixture([]Instance{mineAt(sweepTag)})
	p.staysListed = true
	note, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out)
	if clean || !strings.Contains(note, "not confirmed gone") || !strings.Contains(note, sweepTag) || p.lists != 1+sweepConfirmReads { // the look, then the bounded confirming reads
		t.Fatalf("clean %v, lists %d, note %q", clean, p.lists, note)
	}
	p, want, out = sweepFixture([]Instance{mineAt(sweepTag)})
	p.listErr = nil
	calls := 0
	lister := &failSecondList{sweepProvider: p, failAt: 2, calls: &calls}
	if _, clean := sweepAfterFailedCreate(lister, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out); clean {
		t.Fatal("a failed confirming read must not count as gone")
	}
}

// failSecondList fails the failAt-th list call.
type failSecondList struct {
	*sweepProvider
	failAt int
	calls  *int
}

func (f *failSecondList) List(ctx context.Context) ([]Instance, error) {
	*f.calls++
	if *f.calls == f.failAt {
		return nil, errors.New("down")
	}
	return f.sweepProvider.List(ctx)
}

// The made-at window is one minute on BOTH sides: no earlier than the launch start minus a minute and no later than now plus a minute; just inside and just outside each bound.
func TestSweepMadeAtWindowEdges(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	old := sweepNow
	sweepNow = func() time.Time { return now }
	defer func() { sweepNow = old }()
	since := now.Add(-10 * time.Second)
	for name, tc := range map[string]struct {
		created time.Time
		ok      bool
	}{
		"just inside, before start":  {since.Add(-59 * time.Second), true},
		"exactly at the lower bound": {since.Add(-time.Minute), true},
		"just outside, before start": {since.Add(-61 * time.Second), false},
		"just inside, after now":     {now.Add(59 * time.Second), true},
		"exactly at the upper bound": {now.Add(time.Minute), true},
		"just outside, after now":    {now.Add(61 * time.Second), false},
		"in the middle":              {now.Add(-5 * time.Second), true},
	} {
		in := mineAt(sweepTag)
		in.Created = tc.created
		p, want, out := sweepFixture([]Instance{in})
		want.Since = since
		_, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out)
		deleted := strings.Contains(strings.Join(p.calls, ","), "delete:d1")
		if clean != tc.ok || deleted != tc.ok {
			t.Errorf("%s: clean %v, deleted %v, want %v", name, clean, deleted, tc.ok)
		}
	}
}

// The by-hand text names the delete command as well as the tag, and a leading digit is left alone.
func TestSweepByHandNamesTheDeleteCommandAndCapitaliseOnlyTouchesLetters(t *testing.T) {
	p, want, out := sweepFixture()
	p.listErr = errors.New("down")
	note, _ := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out)
	for _, s := range []string{note, out.String()} {
		if !strings.Contains(s, "coral machine delete coral-1") || !strings.Contains(s, sweepTag) {
			t.Errorf("the by-hand text names the tag and the delete command: %q", s)
		}
	}
	for in, want := range map[string]string{"": "", "abc": "Abc", "Abc": "Abc", "2 machines": "2 machines", "[x]": "[x]", "\x00": "\x00", "{z": "{z"} {
		if got := capitalise(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

// A 5xx with no droplet id sweeps under all the limits. 502, 503, 504 where the droplet DID land: found, deleted by id, confirmed gone, the network may come off.
func TestSweepAfterA5xxThatLanded(t *testing.T) {
	for _, status := range []int{502, 503, 504} {
		p, want, out := sweepFixture([]Instance{mineAt(sweepTag)})
		_, clean := sweepAfterFailedCreate(p, sweepTag, want, &APIError{Status: status}, time.Millisecond, nil, out)
		if !clean || strings.Join(p.calls, ",") != "list,delete:d1,list" {
			t.Errorf("HTTP %d: clean %v, calls %v", status, clean, p.calls)
		}
	}
}

// A 500 where two looks find nothing is UNSURE, like a timeout (Security's amendment, #9934): a gateway can answer before the provider finishes the create, so two empty looks do not prove it never will. The network stays.
func TestSweepAfter500WithTwoEmptyLooksIsUnsureAndKeepsTheNetwork(t *testing.T) {
	for _, err := range []error{&APIError{Status: 500}, &APIError{Status: 502}, &APIError{Status: 504}, context.DeadlineExceeded, io.ErrUnexpectedEOF} {
		p, want, out := sweepFixture(nil)
		note, clean := sweepAfterFailedCreate(p, sweepTag, want, err, time.Millisecond, nil, out)
		if clean || p.lists != 2 || strings.Contains(strings.Join(p.calls, ","), "delete") || !strings.Contains(note, "check by hand") || !strings.Contains(note, sweepTag) || !strings.Contains(note, "coral machine delete coral-1") {
			t.Errorf("%v: clean %v, lists %d, calls %v, note %q", err, clean, p.lists, p.calls, note)
		}
	}
}

// A 502 where the list shows two droplets, or a droplet that does not match: nothing is deleted and the network stays.
func TestSweepAfter502WithTwoOrAMismatch(t *testing.T) {
	a, b := mineAt(sweepTag), mineAt(sweepTag)
	b.ID = "d2"
	odd := mineAt(sweepTag)
	odd.Region = "sfo3"
	for name, look := range map[string][]Instance{"two": {a, b}, "mismatch": {odd}} {
		p, want, out := sweepFixture(look)
		_, clean := sweepAfterFailedCreate(p, sweepTag, want, &APIError{Status: 502}, time.Millisecond, nil, out)
		if clean || strings.Contains(strings.Join(p.calls, ","), "delete") {
			t.Errorf("%s: clean %v, calls %v", name, clean, p.calls)
		}
	}
}

// A provider that still lists the droplet for a read or two after the delete is confirmed gone by the repeated, bounded reads (coral-go Security's INFO).
func TestSweepConfirmingReadsOutlastABriefLag(t *testing.T) {
	p, want, out := sweepFixture([]Instance{mineAt(sweepTag)})
	p.lagReads = 2
	_, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out)
	if !clean || p.lists != 1+sweepConfirmReads {
		t.Fatalf("clean %v, lists %d (want the look and %d reads)", clean, p.lists, sweepConfirmReads)
	}
	p, want, out = sweepFixture([]Instance{mineAt(sweepTag)})
	p.lagReads = 99
	if _, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, nil, out); clean || p.lists != 1+sweepConfirmReads {
		t.Fatalf("a lag longer than the bound is not confirmed: clean %v, lists %d", clean, p.lists)
	}
}

// A second Ctrl-C ends the confirming reads' wait: not confirmed, said by hand with the tag.
func TestSweepConfirmWaitEndsOnASecondInterrupt(t *testing.T) {
	old := sweepConfirmEvery
	sweepConfirmEvery = time.Hour
	defer func() { sweepConfirmEvery = old }()
	p, want, out := sweepFixture([]Instance{mineAt(sweepTag)})
	p.staysListed = true
	stop := make(chan struct{})
	close(stop)
	start := time.Now()
	note, clean := sweepAfterFailedCreate(p, sweepTag, want, context.DeadlineExceeded, time.Millisecond, stop, out)
	if time.Since(start) > 5*time.Second || clean || !strings.Contains(note, "interrupted") || !strings.Contains(note, sweepTag) {
		t.Fatalf("clean %v, took %s, note %q", clean, time.Since(start), note)
	}
}
