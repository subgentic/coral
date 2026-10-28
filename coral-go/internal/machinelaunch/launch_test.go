package machinelaunch

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

const (
	launchTestToken      = "TOKEN-SECRET-dop_v1_0123"
	launchTestCredential = "chb_CREDENTIAL0123456789"
)

type stubProvider struct {
	calls      []string
	validate   error
	priceErr   error
	createErr  error
	waitErr    error
	deleteErr  error
	waitBlocks bool
	spec       Spec
	listed     []Instance
	listErr    error
}

func (s *stubProvider) Name() string { return "stubcloud" }
func (s *stubProvider) Validate(context.Context) error {
	s.calls = append(s.calls, "validate")
	return s.validate
}
func (s *stubProvider) Price(context.Context, string, string) (Price, error) {
	s.calls = append(s.calls, "price")
	return Price{HourlyUSD: 0.0357, MonthlyUSD: 24}, s.priceErr
}
func (s *stubProvider) Create(_ context.Context, spec Spec) (Instance, error) {
	s.calls = append(s.calls, "create")
	s.spec = spec
	if s.createErr != nil {
		return Instance{}, s.createErr
	}
	return Instance{ID: "42", Name: spec.Name, Status: StatusPending}, nil
}
func (s *stubProvider) WaitRunning(ctx context.Context, id string) (Instance, error) {
	s.calls = append(s.calls, "wait")
	if s.waitBlocks {
		<-ctx.Done()
		return Instance{}, ctx.Err()
	}
	if s.waitErr != nil {
		return Instance{}, s.waitErr
	}
	return Instance{ID: id, Name: s.spec.Name, Status: StatusRunning, IPv4: "203.0.113.7"}, nil
}
func (s *stubProvider) Delete(_ context.Context, id string) error {
	s.calls = append(s.calls, "delete:"+id)
	return s.deleteErr
}

type stubHub struct {
	labels []string
	err    error
}

func (h *stubHub) Mint(_ context.Context, label string) (string, error) {
	h.labels = append(h.labels, label)
	return launchTestCredential, h.err
}

func setup(p *stubProvider, h *stubHub) (Options, Deps, *bytes.Buffer) {
	out := &bytes.Buffer{}
	var gotCredential string
	d := Deps{Provider: p, Hub: h, Out: out,
		UserData: func(c string) (string, error) {
			gotCredential = c
			return "#cloud-config\n# credential " + c + "\n", nil
		},
		Confirm: func(string) (bool, error) { return true, nil }}
	_ = gotCredential
	return Options{Name: "coral-1", Region: "nyc3", Size: "s-2vcpu-4gb", HubURL: "https://app.coralhub.dev"}, d, out
}

func TestLaunchHappyPathOrderLabelAndOutput(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, out := setup(p, h)
	res, err := Launch(context.Background(), o, d)
	if err != nil || res.Instance.IPv4 != "203.0.113.7" {
		t.Fatalf("%v %+v", err, res)
	}
	if got := strings.Join(p.calls, ","); got != "validate,price,create,wait" {
		t.Fatalf("calls: %s", got)
	}
	if len(h.labels) != 1 || h.labels[0] != "coral-1" {
		t.Fatalf("the credential's label is the machine's name: %v", h.labels)
	}
	if len(p.spec.Tags) != 2 || p.spec.Tags[0] != Tag || !strings.Contains(p.spec.UserData, launchTestCredential) {
		t.Fatalf("spec: %+v", p.spec)
	}
	for _, secret := range []string{launchTestToken, launchTestCredential} {
		if strings.Contains(out.String(), secret) {
			t.Fatalf("the output holds a secret: %s", out.String())
		}
	}
	if !strings.Contains(out.String(), "press Keep") || !strings.Contains(out.String(), "https://app.coralhub.dev") {
		t.Fatalf("the approve instruction is missing: %s", out.String())
	}
}

func TestLaunchDeclinedOrUnaskableCreatesAndMintsNothing(t *testing.T) {
	for name, tweak := range map[string]func(*Deps){
		"declined":  func(d *Deps) { d.Confirm = func(string) (bool, error) { return false, nil } },
		"no prompt": func(d *Deps) { d.Confirm = nil },
	} {
		p, h := &stubProvider{}, &stubHub{}
		o, d, _ := setup(p, h)
		tweak(&d)
		_, err := Launch(context.Background(), o, d)
		if err == nil || len(h.labels) != 0 || strings.Contains(strings.Join(p.calls, ","), "create") {
			t.Errorf("%s: err %v, mints %v, calls %v", name, err, h.labels, p.calls)
		}
	}
	p, h := &stubProvider{}, &stubHub{}
	o, d, out := setup(p, h)
	o.Yes, d.Confirm = true, nil
	if _, err := Launch(context.Background(), o, d); err != nil || !strings.Contains(out.String(), "about $0.0357 an hour") {
		t.Errorf("--yes goes on without asking and still says the price: %v %s", err, out.String())
	}
}

func TestLaunchDeletesWhatItCreatedWhenTheWaitFailsOrTimesOut(t *testing.T) {
	p, h := &stubProvider{waitErr: errors.New("droplet entered a final state")}, &stubHub{}
	o, d, out := setup(p, h)
	_, err := Launch(context.Background(), o, d)
	if err == nil || strings.Join(p.calls, ",") != "validate,price,create,wait,delete:42" || !strings.Contains(err.Error(), "was deleted") || !strings.Contains(out.String(), "was deleted") {
		t.Fatalf("a failed wait: %v, calls %v", err, p.calls)
	}
	p2 := &stubProvider{waitBlocks: true}
	o, d, _ = setup(p2, &stubHub{})
	o.Wait = 30 * time.Millisecond
	_, err = Launch(context.Background(), o, d)
	if err == nil || !strings.Contains(err.Error(), "not running within") || !strings.Contains(strings.Join(p2.calls, ","), "delete:42") {
		t.Fatalf("a timeout: %v, calls %v", err, p2.calls)
	}
}

func TestLaunchCancelledByTheCallerStillCleansUpOnItsOwnDeadline(t *testing.T) {
	p := &stubProvider{waitBlocks: true}
	o, d, _ := setup(p, &stubHub{})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	_, err := Launch(ctx, o, d)
	if err == nil || !strings.Contains(strings.Join(p.calls, ","), "delete:42") {
		t.Fatalf("a cancelled launch must delete what it made: %v, calls %v", err, p.calls)
	}
}

func TestLaunchSaysWhenTheCleanupFailsAndIgnoresAnAlreadyGoneInstance(t *testing.T) {
	p := &stubProvider{waitErr: errors.New("x"), deleteErr: errors.New("HTTP 500")}
	o, d, out := setup(p, &stubHub{})
	_, err := Launch(context.Background(), o, d)
	if err == nil || !strings.Contains(err.Error(), "could NOT be deleted (id 42)") || !strings.Contains(out.String(), "costs money") {
		t.Fatalf("%v / %s", err, out.String())
	}
	p = &stubProvider{waitErr: errors.New("x"), deleteErr: &APIError{Provider: "stubcloud", Op: "delete", Status: 404}}
	o, d, _ = setup(p, &stubHub{})
	if _, err := Launch(context.Background(), o, d); err == nil || !strings.Contains(err.Error(), "was deleted") {
		t.Fatalf("an instance already gone counts as deleted: %v", err)
	}
}

func TestLaunchEarlyFailuresCreateNothing(t *testing.T) {
	cases := map[string]struct {
		p    *stubProvider
		h    *stubHub
		o    func(*Options)
		want string
	}{
		"refused token":  {p: &stubProvider{validate: &APIError{Provider: "stubcloud", Status: 401}}, h: &stubHub{}, want: "did not accept the token"},
		"size not there": {p: &stubProvider{priceErr: &APIError{Provider: "stubcloud", Status: 404}}, h: &stubHub{}, want: "does not offer size"},
		"hub refuses":    {p: &stubProvider{}, h: &stubHub{err: &HubError{Status: 401}}, want: "did not accept the key"},
		"bad name":       {p: &stubProvider{}, h: &stubHub{}, o: func(o *Options) { o.Name = "Bad Name" }, want: "machine name"},
		"no region":      {p: &stubProvider{}, h: &stubHub{}, o: func(o *Options) { o.Region = "" }, want: "region and a size"},
	}
	for name, c := range cases {
		o, d, _ := setup(c.p, c.h)
		if c.o != nil {
			c.o(&o)
		}
		_, err := Launch(context.Background(), o, d)
		if err == nil || !strings.Contains(err.Error(), c.want) || strings.Contains(strings.Join(c.p.calls, ","), "create") {
			t.Errorf("%s: %v, calls %v", name, err, c.p.calls)
		}
		if strings.Contains(err.Error(), launchTestToken) || strings.Contains(err.Error(), launchTestCredential) {
			t.Errorf("%s: the error holds a secret", name)
		}
	}
	p := &stubProvider{createErr: errors.New("quota")}
	o, d, _ := setup(p, &stubHub{})
	if _, err := Launch(context.Background(), o, d); err == nil || strings.Contains(strings.Join(p.calls, ","), "delete") {
		t.Errorf("a failed create has nothing to delete: %v %v", err, p.calls)
	}
}

// listingProvider is a stub that can also list, as the DigitalOcean provider does.
type listingProvider struct{ *stubProvider }

func (l listingProvider) List(context.Context) ([]Instance, error) {
	l.calls = append(l.calls, "list")
	return l.listed, l.listErr
}

func TestLaunchUserDataFailureNeverMintsACredential(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, _ := setup(p, h)
	d.UserData = func(string) (string, error) { return "", errors.New("no builder yet") }
	if _, err := Launch(context.Background(), o, d); err == nil || len(h.labels) != 0 || strings.Contains(strings.Join(p.calls, ","), "create") {
		t.Fatalf("err %v, mints %v, calls %v", err, h.labels, p.calls)
	}
}

func TestLaunchUserDataIsCheckedWithAPlaceholderThenBuiltWithTheCredential(t *testing.T) {
	p, h := &stubProvider{}, &stubHub{}
	o, d, _ := setup(p, h)
	var seen []string
	d.UserData = func(c string) (string, error) { seen = append(seen, c); return "#cloud-config " + c, nil }
	if _, err := Launch(context.Background(), o, d); err != nil || len(seen) != 2 || seen[0] != placeholderCredential || seen[1] != launchTestCredential {
		t.Fatalf("%v %v", err, seen)
	}
	if strings.Contains(p.spec.UserData, placeholderCredential) {
		t.Fatalf("the placeholder reached the instance: %s", p.spec.UserData)
	}
}

func TestLaunchFailedCreateDeletesOnlyTheInstanceCarryingThisLaunchsTag(t *testing.T) {
	base := &stubProvider{createErr: errors.New("connection reset")}
	p := listingProvider{base}
	base.listed = nil // filled once the launch's tag is known: the stub's Create saw the spec
	h := &stubHub{}
	o, d, out := setup(base, h)
	d.Provider = &tagEchoProvider{listingProvider: p}
	_, err := Launch(context.Background(), o, d)
	got := strings.Join(base.calls, ",")
	if err == nil || !strings.Contains(got, "delete:mine") || strings.Contains(got, "delete:same-name") || strings.Contains(got, "delete:other-launch") {
		t.Fatalf("err %v, calls %s", err, got)
	}
	if !strings.Contains(err.Error(), "deleted") || !strings.Contains(out.String(), "was deleted") {
		t.Fatalf("the person is told: %v %s", err, out.String())
	}
}

// tagEchoProvider lists, after a failed Create, a machine with this launch's tag, one with the same name but not the tag, and one from another launch.
type tagEchoProvider struct{ listingProvider }

func (t *tagEchoProvider) List(context.Context) ([]Instance, error) {
	t.stubProvider.calls = append(t.stubProvider.calls, "list")
	tag := t.stubProvider.spec.Tags[1]
	return []Instance{
		{ID: "mine", Name: "coral-1", Tags: []string{Tag, tag}},
		{ID: "same-name", Name: "coral-1", Tags: []string{Tag}},
		{ID: "other-launch", Name: "x", Tags: []string{Tag, "coral-launch-aaaaaaaaaaaa"}},
	}, nil
}

func TestLaunchFailedCreateWithAListFailureSaysWhereToLook(t *testing.T) {
	base := &stubProvider{createErr: errors.New("timeout")}
	base.listErr = errors.New("down")
	o, d, out := setup(base, &stubHub{})
	d.Provider = listingProvider{base}
	_, err := Launch(context.Background(), o, d)
	if err == nil || !strings.Contains(err.Error(), "tag coral-launch-") || !strings.Contains(out.String(), "costs money") {
		t.Fatalf("%v %s", err, out.String())
	}
	if strings.Contains(strings.Join(base.calls, ","), "delete") {
		t.Fatalf("nothing is deleted without a list: %v", base.calls)
	}
}

func TestLaunchEveryInstanceCarriesAUniqueLaunchTag(t *testing.T) {
	tags := map[string]bool{}
	for i := 0; i < 5; i++ {
		p := &stubProvider{}
		o, d, _ := setup(p, &stubHub{})
		if _, err := Launch(context.Background(), o, d); err != nil || len(p.spec.Tags) != 2 || p.spec.Tags[0] != Tag || !strings.HasPrefix(p.spec.Tags[1], "coral-launch-") {
			t.Fatalf("%v %v", err, p.spec.Tags)
		}
		tags[p.spec.Tags[1]] = true
	}
	if len(tags) != 5 {
		t.Fatalf("tags repeat: %v", tags)
	}
}

// laggingProvider lists nothing the first time and the launch's machine the second time, as a provider whose list lags the create does.
type laggingProvider struct {
	*stubProvider
	lists int
}

func (l *laggingProvider) List(context.Context) ([]Instance, error) {
	l.lists++
	if l.lists == 1 {
		return nil, nil
	}
	return []Instance{{ID: "late", Name: "coral-1", Tags: []string{Tag, l.spec.Tags[1]}}}, nil
}

func TestLaunchTimedOutCreateLooksOnceMoreAndDeletesTheLateMachine(t *testing.T) {
	base := &stubProvider{createErr: context.DeadlineExceeded}
	l := &laggingProvider{stubProvider: base}
	o, d, _ := setup(base, &stubHub{})
	d.Provider, o.RetryListAfter = l, time.Millisecond
	_, err := Launch(context.Background(), o, d)
	if err == nil || l.lists != 2 || !strings.Contains(strings.Join(base.calls, ","), "delete:late") {
		t.Fatalf("lists %d, err %v, calls %v", l.lists, err, base.calls)
	}
}

func TestLaunchCreateFailureThatIsNotATimeoutListsOnlyOnce(t *testing.T) {
	base := &stubProvider{createErr: errors.New("422 unprocessable")}
	l := &laggingProvider{stubProvider: base}
	o, d, _ := setup(base, &stubHub{})
	d.Provider, o.RetryListAfter = l, time.Millisecond
	if _, err := Launch(context.Background(), o, d); err == nil || l.lists != 1 {
		t.Fatalf("lists %d, err %v", l.lists, err)
	}
}
