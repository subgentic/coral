package cloud

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/subgentic/coral/internal/safego"
	"github.com/subgentic/coral/internal/store"
)

// Adding a Hub by its address (#20385, multi-Hub design v2). The person names the Hub and chooses its cap out loud; Coral asks that Hub for a device code, shows it, and polls until the person approves it in the Hub.
// Nothing is stored until then: a pending enrollment is memory only, holds no token, ends on its own with the code, and counts toward the link cap. On approval the token is sealed and written with the row and the
// 'added' event in one transaction (store.AddLink), and the new link gets its own connector. The enrollment of the one legacy Hub is the Manager's own and is not touched here.

// Enrollment states.
const (
	LinkEnrollPending = "pending"
	LinkEnrollLinked  = "linked"
	LinkEnrollDenied  = "denied"
	LinkEnrollExpired = "expired"
	LinkEnrollFailed  = "failed"
)

const (
	linkTextMax      = 80
	maxLinkEnrollLog = 8 // finished entries kept to be read; older ones are dropped
)

// LinkEnrollment is what the person sees of one Hub being added: text only, no token, no device code.
type LinkEnrollment struct {
	Origin          string    `json:"hub"`
	Cap             string    `json:"cap"`
	State           string    `json:"state"`
	UserCode        string    `json:"user_code,omitempty"`
	VerificationURL string    `json:"verification_url,omitempty"`
	Note            string    `json:"note,omitempty"`
	Message         string    `json:"message,omitempty"`
	ExpiresAt       time.Time `json:"expires_at,omitzero"`
}

type linkPending struct {
	LinkEnrollment
	deviceCode string // never leaves this struct
	cancel     context.CancelFunc
	seq        int
}

// cleanLinkText keeps printable text only (no control, format or line characters) and at most max characters: a Hub's words are shown as text, never trusted.
func cleanLinkText(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || unicode.Is(unicode.Zl, r) || unicode.Is(unicode.Zp, r) || unicode.Is(unicode.Co, r) {
			return -1
		}
		return r
	}, s)
	if r := []rune(strings.TrimSpace(s)); len(r) > max {
		return strings.TrimSpace(string(r[:max]))
	}
	return strings.TrimSpace(s)
}

// AddLinkByOrigin asks the Hub at hub for a code and starts waiting for the person to approve it there. Everything that can be refused is refused first, before the Hub is asked for anything: a bad address or cap, a Hub this
// computer is already linked to (said plainly), the gate, and the cap on links, where the pending enrollments count too.
func (m *Manager) AddLinkByOrigin(ctx context.Context, hub, linkCap string) (*LinkEnrollment, error) {
	origin, err := store.CanonicalHubOrigin(hub)
	if err != nil {
		return nil, err
	}
	if linkCap != "view" && linkCap != "interact" && linkCap != "launch" {
		return nil, errors.New("choose what this Hub may do here: view, interact or launch")
	}
	if m.o.Store == nil {
		return nil, ErrNotConfigured
	}
	select {
	case <-m.loaded:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	m.mu.Lock()
	root := m.root
	m.mu.Unlock()
	if root == nil {
		return nil, errors.New("cloud connector is not running")
	}
	if l, err := m.o.Store.LinkByOrigin(ctx, origin); err == nil && l != nil || m.o.Store.AddedLinkAt(ctx, origin) {
		return nil, store.ErrLinkExists
	}
	if primary, perr := store.CanonicalHubOrigin(m.o.HubURL); perr == nil && primary == origin {
		return nil, errors.New("this is the Hub this computer connects to by default: use Connect for it")
	}
	if err := m.o.Store.CheckCanAddLink(ctx); err != nil {
		return nil, err
	}
	links, err := m.o.Store.ListLinks(ctx)
	if err != nil {
		return nil, err
	}
	// A second Add for the same Hub ends the first; the pending ones of other Hubs count with the links.
	m.cancelPending(origin)
	if len(links)+m.pendingCount() >= store.MaxCloudLinks {
		return nil, store.ErrTooManyLinks
	}
	// The token must be storable here before the Hub enrolls this computer (#3693).
	if err := m.o.Store.CheckSecrets(ctx); err != nil {
		return nil, fmt.Errorf("the token can't be stored here: %w", err)
	}
	now := m.o.Now()
	host, _ := os.Hostname()
	dc, err := StartEnrollment(ctx, m.hc, origin, now, EnrollInfo{Hostname: host, CoralVersion: m.o.CoralVersion})
	if err != nil {
		return nil, err
	}
	note := ""
	if dc.OffSite {
		note = "The Hub named a link on another site; Coral does not show it. Open the Hub at its own address and enter the code."
	}
	pctx, cancel := context.WithCancel(root)
	m.pmu.Lock()
	if m.pending == nil {
		m.pending = map[string]*linkPending{}
	}
	seq := 1
	if old := m.pending[origin]; old != nil {
		seq = old.seq + 1
	}
	p := &linkPending{LinkEnrollment: LinkEnrollment{Origin: origin, Cap: linkCap, State: LinkEnrollPending, UserCode: cleanLinkText(dc.UserCode, 16),
		VerificationURL: dc.VerificationURL, Note: note, ExpiresAt: dc.ExpiresAt}, deviceCode: dc.DeviceCode, cancel: cancel, seq: seq}
	m.pending[origin] = p
	m.pruneFinishedLocked()
	view := p.LinkEnrollment
	m.pmu.Unlock()
	go func() {
		defer safego.Recover("cloud/manager:m.pollLinkEnrollment")
		m.pollLinkEnrollment(pctx, p, dc.Interval)
	}()
	return &view, nil
}

// LinkEnrollments lists the Hubs being added and the recent ends, in address order.
func (m *Manager) LinkEnrollments() []LinkEnrollment {
	m.pmu.Lock()
	defer m.pmu.Unlock()
	out := make([]LinkEnrollment, 0, len(m.pending))
	for _, p := range m.pending {
		out = append(out, p.LinkEnrollment)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Origin < out[j].Origin })
	return out
}

// CancelLinkEnrollment ends the enrollment of one Hub and forgets it; an approval that comes later links nothing, because nothing asks the Hub again. It reports whether there was one.
func (m *Manager) CancelLinkEnrollment(origin string) bool {
	m.pmu.Lock()
	p := m.pending[origin]
	delete(m.pending, origin)
	m.pmu.Unlock()
	if p == nil {
		return false
	}
	p.cancel()
	return true
}

// LinkRemoved drops the pending enrollment of a Hub whose link was removed.
func (m *Manager) LinkRemoved(origin string) { m.CancelLinkEnrollment(origin) }

func (m *Manager) cancelPending(origin string) { m.CancelLinkEnrollment(origin) }

func (m *Manager) pendingCount() int {
	m.pmu.Lock()
	defer m.pmu.Unlock()
	n := 0
	for _, p := range m.pending {
		if p.State == LinkEnrollPending {
			n++
		}
	}
	return n
}

func (m *Manager) pruneFinishedLocked() {
	var done []*linkPending
	for _, p := range m.pending {
		if p.State != LinkEnrollPending {
			done = append(done, p)
		}
	}
	if len(done) <= maxLinkEnrollLog {
		return
	}
	sort.Slice(done, func(i, j int) bool { return done[i].seq < done[j].seq })
	for _, p := range done[:len(done)-maxLinkEnrollLog] {
		delete(m.pending, p.Origin)
	}
}

// finishLinkEnroll ends p with a state and a plain message, unless it was cancelled or replaced meanwhile.
func (m *Manager) finishLinkEnroll(p *linkPending, state, msg string) {
	m.pmu.Lock()
	defer m.pmu.Unlock()
	if m.pending[p.Origin] != p {
		return
	}
	p.State, p.Message, p.UserCode, p.VerificationURL, p.Note, p.deviceCode = state, msg, "", "", "", ""
}

func (m *Manager) pollLinkEnrollment(ctx context.Context, p *linkPending, interval time.Duration) {
	failures := 0
	if m.o.PollInterval > 0 {
		interval = m.o.PollInterval
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
		if !m.o.Now().Before(p.ExpiresAt) {
			m.finishLinkEnroll(p, LinkEnrollExpired, "The code expired before it was approved. Add the Hub again for a new code.")
			return
		}
		en, err := PollEnrollment(ctx, m.hc, p.Origin, p.deviceCode)
		switch {
		case err == nil:
			m.completeLinkEnroll(ctx, p, en)
			return
		case errors.Is(err, ErrAuthorizationPending):
			failures = 0
		case errors.Is(err, ErrSlowDown):
			interval += 5 * time.Second
		case errors.Is(err, ErrEnrollmentExpired):
			m.finishLinkEnroll(p, LinkEnrollExpired, "The code expired before it was approved. Add the Hub again for a new code.")
			return
		case errors.Is(err, ErrAccessDenied):
			m.finishLinkEnroll(p, LinkEnrollDenied, "The request was denied in the Hub.")
			return
		default:
			if failures++; failures >= 10 {
				m.finishLinkEnroll(p, LinkEnrollFailed, "The Hub is not answering; adding it stopped.")
				return
			}
		}
	}
}

// completeLinkEnroll stores the approved link. The token goes only into AddLink (sealed, one transaction with the row and the event): no message, log line or list answer carries it.
func (m *Manager) completeLinkEnroll(ctx context.Context, p *linkPending, en *Enrolled) {
	const orphan = " Remove this computer in the Hub, then add it again."
	if ctx.Err() != nil {
		return // cancelled while the answer was in flight: nothing is stored
	}
	if en.TeamOrg != "" {
		m.finishLinkEnroll(p, LinkEnrollFailed, "That Hub enrolled this computer as a team's, which can't be added as a second Hub yet."+orphan)
		return
	}
	_, err := m.o.Store.AddLink(ctx, p.Origin, en.ServerID, cleanLinkText(en.Label, linkTextMax), en.Token, p.Cap)
	switch {
	case err == nil && ctx.Err() != nil:
		// Cancelled while AddLink was storing: the Operator said stop, so the link is not kept (no tunnel, no token at rest). The Hub may still list this computer.
		m.undoCancelledLink(p.Origin)
	case err == nil:
		m.finishLinkEnroll(p, LinkEnrollLinked, "Linked.")
		m.LinksChanged(ctx)
	case errors.Is(err, store.ErrLinkExists):
		m.finishLinkEnroll(p, LinkEnrollFailed, store.ErrLinkExists.Error())
	case errors.Is(err, store.ErrTooManyLinks), errors.Is(err, store.ErrSecondLinkNotYet):
		m.finishLinkEnroll(p, LinkEnrollFailed, err.Error()+"."+orphan)
	default:
		// The error is about the key or the database, never the token.
		m.finishLinkEnroll(p, LinkEnrollFailed, "The Hub approved this computer, but the link could not be stored here."+orphan)
	}
}

// undoCancelledLink removes the link an enrollment stored after it was cancelled. It uses its own context (the enrollment's is cancelled) and ends as dropped: the Hub was not asked to revoke.
func (m *Manager) undoCancelledLink(origin string) {
	ctx, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	l, err := m.o.Store.LinkByOrigin(ctx, origin)
	if err != nil || l == nil || l.Source != store.LinkSourceAdded {
		return
	}
	if m.o.Store.BeginRemoveLink(ctx, l.LinkID) == nil {
		_ = m.o.Store.FinishRemoveLink(ctx, l.LinkID, store.LinkEventDropped)
	}
}
