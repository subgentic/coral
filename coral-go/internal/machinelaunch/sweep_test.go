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
}

func (p *sweepProvider) List(context.Context) ([]Instance, error) {
	p.lists++
	p.calls = append(p.calls, "list")
	if p.listErr != nil {
		return nil, p.listErr
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

const sweepTag = "coral-launch-0123456789abcdef0123456789abcdef"

// Only a create that got NO answer may sweep: a timeout, a cut connection or an interruption. Every answer from the provider, and the auth errors, never do (Security's limit 4).
func TestCreateMayHaveLanded(t *testing.T) {
	for name, err := range map[string]error{
		"deadline": context.DeadlineExceeded, "wrapped deadline": errors.Join(errors.New("create"), context.DeadlineExceeded), "cancelled": context.Canceled,
		"eof": io.EOF, "unexpected eof": io.ErrUnexpectedEOF, "net timeout": &net.DNSError{IsTimeout: true},
	} {
		if !createMayHaveLanded(err) {
			t.Errorf("%s may have landed", name)
		}
	}
	for name, err := range map[string]error{
		"nil": nil, "400": &APIError{Status: 400}, "401": &APIError{Status: 401}, "403": &APIError{Status: 403}, "422": &APIError{Status: 422}, "429": &APIError{Status: 429}, "500": &APIError{Status: 500}, "503": &APIError{Status: 503},
		"unauthorized": ErrUnauthorized, "not found": ErrNotFound, "plain": errors.New("an ssh key is not an id"),
	} {
		if createMayHaveLanded(err) {
			t.Errorf("%s never sweeps", name)
		}
	}
}

func TestSweepAnAnswerNeverListsOrDeletes(t *testing.T) {
	for _, status := range []int{401, 403, 422, 429, 500, 503} {
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
	if !clean || strings.Join(p.calls, ",") != "list,delete:d1" || p.lists != 1 {
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
	if _, clean := sweepAfterFailedCreate(p, sweepTag, want, io.ErrUnexpectedEOF, time.Millisecond, nil, out); !clean || p.lists != 2 || !strings.Contains(strings.Join(p.calls, ","), "delete:d1") {
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
	if time.Since(start) > 5*time.Second || clean || p.lists != 1 || !strings.Contains(note, "interrupted a second time") || !strings.Contains(note, sweepTag) || !strings.Contains(out.String(), "check by hand") {
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

// The package has no delete-by-tag call: a delete request names a droplet id and never a tag (limit 2).
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
			if strings.Contains(line, "MethodDelete") && (strings.Contains(strings.ToLower(line), "tag") || strings.Contains(line, "?")) {
				t.Errorf("%s:%d: a delete that names a tag or a query: %s", f, i+1, strings.TrimSpace(line))
			}
		}
	}
}
