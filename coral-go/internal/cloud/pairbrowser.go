package cloud

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base32"
	"errors"
	"net/url"
	"sync"
	"time"

	"github.com/subgentic/coral/internal/devicekey"
	"github.com/subgentic/coral/pkg/tunnel"
)

// Pair a browser to a computer that is already connected (#21880; design note design-21880.md, Security's OK with four MUSTs and the Orchestrator's mode choice). The person at this computer starts it (local only, never
// tunneled); the secret rides only in the link's fragment; the browser answers through the Hub with a MAC over that secret; the key is listed only after the person at this computer allows it (label, key fingerprint and
// a mode they choose, view by default). No unlink, no clearing of the device list.
const (
	pairBrowserLife    = 10 * time.Minute // the secret's own life (SecretHold)
	pairBrowserPending = 2 * time.Minute  // how long an answer waits for the person's Allow
)

var (
	ErrPairBrowserNotLinked = errors.New("this computer is not connected to Coral Hub")
	ErrPairBrowserNoKey     = errors.New("this computer has no device key of its own yet")
	ErrPairBrowserNothing   = errors.New("no browser is waiting to be trusted")
	ErrPairBrowserModeAbove = errors.New("that mode is above what this computer allows Coral Hub")
	ErrPairBrowserBadMode   = errors.New("mode must be view, interact or launch")
)

type pendingBrowser struct {
	userCode string
	label    string
	kid      string
	mac      string
	pk       []byte
	asked    time.Time
	state    string // "waiting" | "allowed" | "denied"
	reply    []byte
	mode     string
}

type pairBrowser struct {
	mu      sync.Mutex
	hold    *devicekey.SecretHold
	link    string // the Hub link this was started for: an answer through another is refused
	code    string
	url     string // shown only while the hold lives; memory only
	started time.Time
	pend    *pendingBrowser
	last    string // the last end, for the screen ("trusted", or why not); never a key or a secret
}

// PairBrowserView is what the person at this computer sees. Link is set only while the secret is held.
type PairBrowserView struct {
	Active      bool            `json:"active"`
	Code        string          `json:"code,omitempty"`
	Link        string          `json:"link,omitempty"`
	Fingerprint string          `json:"fingerprint,omitempty"` // this computer's own, as the browser shows it
	ExpiresAt   time.Time       `json:"expires_at,omitzero"`
	Pending     *PairBrowserAsk `json:"pending,omitempty"`
	MaxMode     string          `json:"max_mode,omitempty"` // the most a mode chosen at Allow may be
	Last        string          `json:"last,omitempty"`
}

// PairBrowserAsk is the browser waiting for Allow: its label and the fingerprint of its own key, so the person can compare it with what the browser shows.
type PairBrowserAsk struct {
	Label       string    `json:"label"`
	Fingerprint string    `json:"fingerprint"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// PairAnswerResult is what the Hub-relayed route replies to the browser.
type PairAnswerResult struct {
	State    string // "pending" | "ok" | "refused"
	Reply    []byte // the reply MAC, on "ok"
	Computer string // this computer's key id, on "ok"
}

func (pb *pairBrowser) endLocked(why string) {
	if pb.hold != nil {
		pb.hold.Wipe()
	}
	pb.hold, pb.pend, pb.url, pb.code, pb.link = nil, nil, "", "", ""
	if why != "" {
		pb.last = why
	}
}

// liveLocked ends what has run out and reports whether a pairing is still open.
func (pb *pairBrowser) liveLocked(now time.Time) bool {
	if pb.hold == nil {
		return false
	}
	if pb.pend != nil && pb.pend.state != "waiting" { // answered: open until the browser reads it or the time is up
		if now.Sub(pb.started) > pairBrowserLife {
			pb.endLocked("The pairing timed out.")
			return false
		}
		return true
	}
	if !pb.hold.Alive(now) {
		pb.endLocked("The pairing timed out. Start it again.")
		return false
	}
	if pb.pend != nil && now.Sub(pb.pend.asked) > pairBrowserPending {
		pb.pend = nil
		pb.last = "Nobody answered the browser in time. It can ask again."
	}
	return true
}

// StartPairBrowser begins a pairing for the Hub link this computer is on. A start replaces an earlier one.
func (m *Manager) StartPairBrowser(ctx context.Context) (PairBrowserView, error) {
	if m.o.ComputerKey == nil {
		return PairBrowserView{}, ErrPairBrowserNoKey
	}
	link, err := m.linkForTunnel(ctx)
	if err != nil {
		return PairBrowserView{}, ErrPairBrowserNotLinked
	}
	raw := devicekey.NewPairingSecret()
	secret, _ := devicekey.ParsePairingSecret(raw)
	code := pairBrowserCode()
	now := m.o.Now()
	q := url.Values{"c": {code}, "computer": {m.ComputerID()}}
	pb := &m.pb
	pb.mu.Lock()
	defer pb.mu.Unlock()
	pb.endLocked("")
	pb.hold = devicekey.NewSecretHold(secret, now)
	pb.link, pb.code, pb.started, pb.last = link.LinkID, code, now, ""
	pb.url = m.o.HubURL + "/pair?" + q.Encode() + "#p=" + raw
	m.o.Logger.Info("cloud: pairing a browser was started here", "link", link.LinkID)
	return m.pairBrowserViewLocked(now), nil
}

// pairBrowserCode is 8 characters of base32: the code the person reads on the Hub's page.
func pairBrowserCode() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)
}

// PairBrowserState is the person's view: nothing secret beyond the link they started.
func (m *Manager) PairBrowserState() PairBrowserView {
	pb := &m.pb
	pb.mu.Lock()
	defer pb.mu.Unlock()
	return m.pairBrowserViewLocked(m.o.Now())
}

func (m *Manager) pairBrowserViewLocked(now time.Time) PairBrowserView {
	pb := &m.pb
	v := PairBrowserView{MaxMode: m.currentMode().String()}
	if !pb.liveLocked(now) {
		v.Last = pb.last
		return v
	}
	v.Last = pb.last
	v.Active, v.Code, v.Fingerprint = true, pb.code, m.DisplayFingerprint()
	if !pb.hold.QRExpiresAt(now).IsZero() {
		v.Link = pb.url
	}
	v.ExpiresAt = pb.started.Add(pairBrowserLife)
	if p := pb.pend; p != nil && p.state == "waiting" {
		v.Pending = &PairBrowserAsk{Label: p.label, Fingerprint: devicekey.DisplayFingerprint(p.pk), ExpiresAt: p.asked.Add(pairBrowserPending)}
	}
	return v
}

// CancelPairBrowser ends it at once (the person pressed Cancel, or the screen was left).
func (m *Manager) CancelPairBrowser() {
	m.pb.mu.Lock()
	m.pb.endLocked("Pairing was cancelled.")
	m.pb.mu.Unlock()
}

// AnswerPairBrowser is the browser's answer, relayed by the Hub (the unsigned route: the MAC over the secret is its only authority). Every failure is one error, ErrPairingMAC, whatever the cause (no hold, another link, a bad
// MAC or key), so the route cannot be used to learn which. A good answer waits for Allow; the same answer asked again reads the state.
func (m *Manager) AnswerPairBrowser(arrivedLink, userCode, label string, a devicekey.PairingAnswer) (PairAnswerResult, error) {
	pb := &m.pb
	pb.mu.Lock()
	defer pb.mu.Unlock()
	now := m.o.Now()
	if !pb.liveLocked(now) || arrivedLink == "" || arrivedLink != pb.link {
		return PairAnswerResult{}, devicekey.ErrPairingMAC
	}
	if p := pb.pend; p != nil && p.state != "waiting" { // answered: only the same asker may read it, once
		same := subtle.ConstantTimeCompare([]byte(p.mac), []byte(a.MAC)) == 1 && p.kid == a.KID && p.label == label && p.userCode == userCode
		if !same {
			return PairAnswerResult{}, devicekey.ErrPairingMAC
		}
		res := PairAnswerResult{State: "refused"}
		if p.state == "allowed" {
			res = PairAnswerResult{State: "ok", Reply: p.reply, Computer: m.ComputerID()}
		}
		pb.endLocked("") // read once: the pairing is over
		return res, nil
	}
	pk, err := pb.hold.Check(userCode, label, a, now)
	if err != nil {
		if !pb.hold.Alive(now) {
			pb.endLocked("Pairing ended after wrong answers. Start it again.")
		}
		return PairAnswerResult{}, devicekey.ErrPairingMAC
	}
	if p := pb.pend; p != nil { // one browser at a time: the same one asking again is still waiting
		if p.kid != a.KID || p.label != label {
			return PairAnswerResult{}, devicekey.ErrPairingMAC
		}
		return PairAnswerResult{State: "pending"}, nil
	}
	pb.pend = &pendingBrowser{userCode: userCode, label: label, kid: a.KID, mac: a.MAC, pk: pk, asked: now, state: "waiting"}
	m.o.Logger.Info("cloud: a browser asked to be trusted", "link", arrivedLink, "kid", short(a.KID), "label", label, "fingerprint", devicekey.DisplayFingerprint(pk))
	return PairAnswerResult{State: "pending"}, nil
}

func short(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

// AllowPairBrowser is the person at this computer trusting the waiting browser at mode ("" is view; never above this computer's own cap). The key is listed as a `pairing` device, owner pair, and a key already listed as bootstrap
// or noproof is promoted without a change of mode. The secret is wiped and the reply is kept for the browser's next ask.
func (m *Manager) AllowPairBrowser(ctx context.Context, mode string) error {
	pb := &m.pb
	pb.mu.Lock()
	defer pb.mu.Unlock()
	now := m.o.Now()
	if !pb.liveLocked(now) || pb.pend == nil || pb.pend.state != "waiting" {
		return ErrPairBrowserNothing
	}
	if mode == "" {
		mode = "view"
	}
	md, ok := tunnel.ParseMode(mode)
	if !ok || md < tunnel.TierView || md > tunnel.TierLaunch {
		return ErrPairBrowserBadMode
	}
	if md > m.currentMode() {
		return ErrPairBrowserModeAbove
	}
	if m.o.Devices == nil || m.o.ComputerKey == nil {
		return ErrPairBrowserNoKey
	}
	p := pb.pend
	reply, err := pb.hold.Reply(p.userCode, p.pk, m.o.ComputerKey.Pub(), now)
	if err != nil {
		return ErrPairBrowserNothing
	}
	if err := devicekey.AddPairedKey(ctx, m.o.Devices, p.kid, p.pk, p.label, md.String(), now); err != nil {
		return err
	}
	p.state, p.reply, p.mode = "allowed", reply, md.String()
	pb.hold.Wipe() // the secret is not needed any more: the reply is made
	pb.last = "Trusted " + p.label + "."
	m.o.Logger.Info("cloud: a browser was trusted here", "link", pb.link, "kid", short(p.kid), "label", p.label, "fingerprint", devicekey.DisplayFingerprint(p.pk), "mode", md.String())
	return nil
}

// DenyPairBrowser is the person refusing the waiting browser.
func (m *Manager) DenyPairBrowser() error {
	pb := &m.pb
	pb.mu.Lock()
	defer pb.mu.Unlock()
	if !pb.liveLocked(m.o.Now()) || pb.pend == nil || pb.pend.state != "waiting" {
		return ErrPairBrowserNothing
	}
	pb.pend.state = "denied"
	pb.hold.Wipe()
	pb.last = "Refused " + pb.pend.label + "."
	m.o.Logger.Info("cloud: a browser was refused here", "link", pb.link, "kid", short(pb.pend.kid))
	return nil
}
