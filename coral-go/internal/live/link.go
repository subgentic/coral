package live

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/subgentic/coral/pkg/redact"
)

// The link state kept on this computer (#21014 slice 3, design v4 section 14). This computer is the only authority: a Hub reply never changes what is in here except to turn a link off.
// The Manager has no network and no route; the routes call it, and the pusher (a later slice) asks it CanPush before every frame.

// State is a link's place in its life: draft -> live -> (paused | stopped); a paused link goes live again only by a person's resume here.
type State string

const (
	StateDraft   State = "draft"
	StateLive    State = "live"
	StatePaused  State = "paused"
	StateStopped State = "stopped"
)

// Paused reasons, a closed set (the "paused by the computer" message carries the first three).
const (
	ReasonNotReconfirmed = "not_reconfirmed"
	ReasonOwner          = "owner"
	ReasonRestart        = "restart"
	ReasonHub            = "hub"
)

// The re-confirm clock (design 14.1): one per link. With chat on the period is 7 days with 24 h of grace; without, the owner's period (1 to 90 days, 90 by default) with 14 days of grace.
const (
	ChatPeriod   = 7 * 24 * time.Hour
	ChatGrace    = 24 * time.Hour
	MaxPeriod    = 90
	NoChatGrace  = 14 * 24 * time.Hour
	StaleSilence = 7 * 24 * time.Hour // no frame for this long pauses the link (design 2)
)

// Errors the routes turn into their closed code set.
var (
	ErrNotFound        = errors.New("not_found")
	ErrBadHash         = errors.New("bad_hash")
	ErrState           = errors.New("bad_state")
	ErrChatUnavailable = errors.New("chat_unavailable")
	ErrBadPeriod       = errors.New("bad_period")
	ErrBadHubLink      = errors.New("bad_hub_link")
	ErrNotRead         = errors.New("not_read")
	ErrBadViews        = errors.New("bad_views")
	ErrNotAllowed      = errors.New("not_allowed")
)

// Views is the draft the owner edits. It changes nothing that is pushed (MUST A) until a new go-live names the hash of what was previewed.
type Views struct {
	ChatKey    string `json:"chat_key"` // the agent whose chat is shown, "" for none
	PeriodDays int    `json:"period_days"`
	ExpiresIn  string `json:"expires_in"` // none | 24h | 7d
	DelayS     int    `json:"delay_s"`    // 30 | 60 | 300
}

// Approved is the snapshot taken at go-live: the only thing a frame is built from (MUST A).
type Approved struct {
	Hash       string    `json:"hash"`
	AgentKeys  []string  `json:"agent_keys"` // the agents shown, as they were at go-live: one that joins later is not in it
	ChatKey    string    `json:"chat_key"`
	ChatGen    string    `json:"chat_gen"` // the session generation the chat pick is bound to (MUST B)
	ExpiresIn  string    `json:"expires_in"`
	DelayS     int       `json:"delay_s"`
	PeriodDays int       `json:"period_days"`
	At         time.Time `json:"at"`
}

// Link is one live link. The Hub's link URL is never here (coral-hub's rule): HubLink is the id the owner copied from the Hub page.
type Link struct {
	ID           string    `json:"id"`
	HubLink      string    `json:"hub"`
	Team         string    `json:"team"`
	CreatedBy    string    `json:"created_by"`
	State        State     `json:"state"`
	PausedReason string    `json:"paused_reason"`
	Views        Views     `json:"views"`
	ChatGen      string    `json:"chat_gen"` // generation bound to Views.ChatKey when it was picked
	Approved     *Approved `json:"approved,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	ConfirmedAt  time.Time `json:"confirmed_at"`
	LiveSince    time.Time `json:"live_since"`
	ChatSince    time.Time `json:"chat_since"`
	ExpiresAt    time.Time `json:"expires_at"`
	ChatOffWhy   string    `json:"chat_off_why,omitempty"`
	LastViewedS  *int64    `json:"last_viewed_age_s,omitempty"` // as the Hub reports; never used for a decision
	HubStops     int       `json:"hub_stops"`
}

// Clock is this computer's wall clock; tests set it.
type Clock interface{ Now() time.Time }

// SystemClock is the real one.
type SystemClock struct{}

func (SystemClock) Now() time.Time { return time.Now() }

// Store keeps the links across a restart.
type Store interface {
	Load() ([]Link, error)
	Save([]Link) error
}

// MemStore is a Store in memory.
type MemStore struct {
	mu    sync.Mutex
	links []Link
}

func (m *MemStore) Load() ([]Link, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, _ := json.Marshal(m.links)
	var out []Link
	_ = json.Unmarshal(b, &out)
	return out, nil
}

func (m *MemStore) Save(l []Link) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, _ := json.Marshal(l)
	m.links = nil
	return json.Unmarshal(b, &m.links)
}

// Message is one thing to tell the Hub, made here and sent by the pusher; each is a closed shape (design 14.2 and 14.3).
type Message struct {
	Kind         string // "confirm" | "paused"
	HubLink      string
	Chat         bool
	ChatSince    int64
	ReconfirmDue int64
	Reason       string
}

// Config is what the Manager needs from outside.
type Config struct {
	Clock Clock
	Store Store
	// Source gives a team's agents and posts. Hide is unused by the frame; it is how the owner's choice is applied.
	Source func(team string) LiveSource
	// ChatAvailable says whether chat can be shown for this agent (a CLI with tested fixtures, a generation known). Nil: never (the chat slice is later).
	ChatAvailable func(a AgentRow) bool
	Redactor      redact.Redactor
	NewID         func() string
}

// Manager holds the links.
type Manager struct {
	mu    sync.Mutex
	cfg   Config
	links map[string]*Link
	order []string
	out   []Message
}

var hubLinkRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// NewManager loads the stored links. A link that was live with chat on comes back paused (reason restart) until a person resumes it; the message for the Hub is queued.
func NewManager(cfg Config) (*Manager, error) {
	if cfg.Clock == nil {
		cfg.Clock = SystemClock{}
	}
	if cfg.NewID == nil {
		cfg.NewID = randomID
	}
	m := &Manager{cfg: cfg, links: map[string]*Link{}}
	if cfg.Store != nil {
		ls, err := cfg.Store.Load()
		if err != nil {
			return nil, err
		}
		for i := range ls {
			l := ls[i]
			m.links[l.ID] = &l
			m.order = append(m.order, l.ID)
			if l.State == StateLive && l.Approved != nil && l.Approved.ChatKey != "" {
				m.pause(&l, ReasonRestart)
				m.links[l.ID] = &l
			}
		}
		if err := m.saveLocked(); err != nil {
			return nil, err
		}
	}
	return m, nil
}

func randomID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (m *Manager) saveLocked() error {
	if m.cfg.Store == nil {
		return nil
	}
	ls := make([]Link, 0, len(m.order))
	for _, id := range m.order {
		ls = append(ls, *m.links[id])
	}
	return m.cfg.Store.Save(ls)
}

// Drain returns the messages waiting for the Hub and clears the queue.
func (m *Manager) Drain() []Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	o := m.out
	m.out = nil
	return o
}

// List returns every link, oldest first.
func (m *Manager) List() []Link {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Link
	for _, id := range m.order {
		out = append(out, *m.links[id])
	}
	return out
}

// Get returns one link.
func (m *Manager) Get(id string) (Link, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.links[id]
	if !ok {
		return Link{}, ErrNotFound
	}
	return *l, nil
}

// Create makes a draft for one Hub link and one team. Every agent is shown, chat is off, no expiry, a 30 s delay and the longest re-confirm period. A Hub link that has a link here already (not stopped) is refused.
func (m *Manager) Create(hubLink, team, by string) (Link, error) {
	hubLink = strings.ToLower(strings.TrimSpace(hubLink))
	if !hubLinkRE.MatchString(hubLink) {
		return Link{}, ErrBadHubLink
	}
	if strings.TrimSpace(team) == "" {
		return Link{}, ErrBadViews
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, l := range m.links {
		if l.HubLink == hubLink && l.State != StateStopped {
			return Link{}, ErrBadHubLink
		}
	}
	now := m.cfg.Clock.Now()
	l := &Link{ID: m.cfg.NewID(), HubLink: hubLink, Team: team, CreatedBy: by, State: StateDraft, CreatedAt: now,
		Views: Views{PeriodDays: MaxPeriod, ExpiresIn: "none", DelayS: 30}}
	m.links[l.ID] = l
	m.order = append(m.order, l.ID)
	return *l, m.saveLocked()
}

// SetViews replaces the draft. Any change voids a preview (the hash changes) and nothing is pushed differently until a new go-live (MUST A).
func (m *Manager) SetViews(ctx context.Context, id string, v Views) (Link, error) {
	if v.PeriodDays == 0 {
		v.PeriodDays = MaxPeriod
	}
	if v.PeriodDays < 1 || v.PeriodDays > MaxPeriod {
		return Link{}, ErrBadPeriod
	}
	switch v.ExpiresIn {
	case "", "none":
		v.ExpiresIn = "none"
	case "24h", "7d":
	default:
		return Link{}, ErrBadViews
	}
	switch v.DelayS {
	case 0:
		v.DelayS = 30
	case 30, 60, 300:
	default:
		return Link{}, ErrBadViews
	}
	m.mu.Lock()
	l, ok := m.links[id]
	m.mu.Unlock()
	if !ok {
		return Link{}, ErrNotFound
	}
	gen := ""
	if v.ChatKey != "" {
		rows, err := m.cfg.Source(l.Team).Agents(ctx)
		if err != nil {
			return Link{}, err
		}
		found := false
		for _, r := range rows {
			if r.Key == v.ChatKey && r.Key != "" && !r.Archived && r.Generation != "" && m.cfg.ChatAvailable != nil && m.cfg.ChatAvailable(r) {
				found, gen = true, r.Generation
			}
		}
		if !found {
			return Link{}, ErrChatUnavailable
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok = m.links[id]
	if !ok {
		return Link{}, ErrNotFound
	}
	if l.State == StateStopped {
		return Link{}, ErrState
	}
	l.Views, l.ChatGen = v, gen
	return *l, m.saveLocked()
}

// Preview is what the owner reads before going live.
type Preview struct {
	Hash  string `json:"hash"`
	Frame Frame  `json:"frame"`
}

func hashOf(keys []string, v Views, gen string) string {
	k := append([]string(nil), keys...)
	sort.Strings(k)
	b, _ := json.Marshal(struct {
		Keys []string
		V    Views
		Gen  string
	}{k, v, gen})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func agentKeys(rows []AgentRow) []string {
	var keys []string
	for _, r := range rows {
		if r.Key != "" {
			keys = append(keys, r.Key)
		}
	}
	sort.Strings(keys)
	return keys
}

func shownSet(keys []string) ViewChoice {
	c := ViewChoice{Shown: map[string]bool{}}
	for _, k := range keys {
		c.Shown[k] = true
	}
	return c
}

// Preview builds the exact frame for the draft (every agent shown) and the hash that go-live must name.
func (m *Manager) Preview(ctx context.Context, id string) (Preview, error) {
	m.mu.Lock()
	l, ok := m.links[id]
	if !ok {
		m.mu.Unlock()
		return Preview{}, ErrNotFound
	}
	cp := *l
	m.mu.Unlock()
	src := m.cfg.Source(cp.Team)
	rows, err := src.Agents(ctx)
	if err != nil {
		return Preview{}, err
	}
	keys := agentKeys(rows)
	in, err := Gather(ctx, src, shownSet(keys))
	if err != nil {
		return Preview{}, err
	}
	return Preview{Hash: hashOf(keys, cp.Views, cp.ChatGen), Frame: Build(in, Options{}, m.cfg.Redactor)}, nil
}

// Deadlines gives a link's re-confirm times: due (the owner should re-confirm by), and pauseAt (the end of grace, the instant it pauses and what the Hub is told).
func Deadlines(l Link) (due, pauseAt time.Time) {
	if l.ConfirmedAt.IsZero() {
		return time.Time{}, time.Time{}
	}
	if l.Approved != nil && l.Approved.ChatKey != "" {
		due = l.ConfirmedAt.Add(ChatPeriod)
		return due, due.Add(ChatGrace)
	}
	days := MaxPeriod
	if l.Approved != nil && l.Approved.PeriodDays > 0 {
		days = l.Approved.PeriodDays
	}
	due = l.ConfirmedAt.Add(time.Duration(days) * 24 * time.Hour)
	return due, due.Add(NoChatGrace)
}

// NoticeAt is when the Needs-you notice starts: 24 h before due with chat, 7 days before for a long period, a tenth of a short one (at least an hour).
func NoticeAt(l Link) time.Time {
	due, _ := Deadlines(l)
	if due.IsZero() {
		return time.Time{}
	}
	if l.Approved != nil && l.Approved.ChatKey != "" {
		return due.Add(-24 * time.Hour)
	}
	lead := 7 * 24 * time.Hour
	if span := due.Sub(l.ConfirmedAt); span < 30*24*time.Hour {
		lead = span / 10
		if lead < time.Hour {
			lead = time.Hour
		}
	}
	return due.Add(-lead)
}

func (m *Manager) confirmMsg(l *Link) Message {
	_, pauseAt := Deadlines(*l)
	chat := l.Approved != nil && l.Approved.ChatKey != "" && !l.ChatSince.IsZero()
	msg := Message{Kind: "confirm", HubLink: l.HubLink, Chat: chat, ReconfirmDue: pauseAt.Unix()}
	if chat {
		msg.ChatSince = l.ChatSince.Unix()
	}
	return msg
}

// GoLive turns a draft live. The request names the hash of the preview the person read; anything changed since refuses it (MUST A). The snapshot of what was approved is taken here.
func (m *Manager) GoLive(ctx context.Context, id, hash string, read bool) (Link, error) {
	if !read {
		return Link{}, ErrNotRead
	}
	p, err := m.Preview(ctx, id)
	if err != nil {
		return Link{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.links[id]
	if !ok {
		return Link{}, ErrNotFound
	}
	if l.State != StateDraft {
		return Link{}, ErrState
	}
	if hash == "" || hash != p.Hash {
		return Link{}, ErrBadHash
	}
	rows, err := m.cfg.Source(l.Team).Agents(ctx)
	if err != nil {
		return Link{}, err
	}
	m.approve(l, agentKeys(rows), p.Hash)
	return *l, m.saveLocked()
}

func (m *Manager) approve(l *Link, keys []string, hash string) {
	now := m.cfg.Clock.Now()
	l.Approved = &Approved{Hash: hash, AgentKeys: keys, ChatKey: l.Views.ChatKey, ChatGen: l.ChatGen, ExpiresIn: l.Views.ExpiresIn, DelayS: l.Views.DelayS, PeriodDays: l.Views.PeriodDays, At: now}
	l.State, l.PausedReason, l.ChatOffWhy = StateLive, "", ""
	l.ConfirmedAt, l.LiveSince = now, now
	l.ChatSince = time.Time{}
	if l.Views.ChatKey != "" {
		l.ChatSince = now
	}
	l.ExpiresAt = time.Time{}
	switch l.Views.ExpiresIn {
	case "24h":
		l.ExpiresAt = now.Add(24 * time.Hour)
	case "7d":
		l.ExpiresAt = now.Add(7 * 24 * time.Hour)
	}
	m.out = append(m.out, m.confirmMsg(l))
}

// Reconfirm restarts the clock of a live link. A paused or stopped link is resumed or made anew, never re-confirmed.
func (m *Manager) Reconfirm(id string) (Link, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.links[id]
	if !ok {
		return Link{}, ErrNotFound
	}
	if l.State != StateLive {
		return Link{}, ErrState
	}
	now := m.cfg.Clock.Now()
	if _, pauseAt := Deadlines(*l); !now.Before(pauseAt) {
		return Link{}, ErrState // the grace is over: Tick pauses it, and resume is the way back
	}
	l.ConfirmedAt = now
	m.out = append(m.out, m.confirmMsg(l))
	return *l, m.saveLocked()
}

func (m *Manager) pause(l *Link, reason string) {
	l.State, l.PausedReason = StatePaused, reason
	m.out = append(m.out, Message{Kind: "paused", HubLink: l.HubLink, Reason: reason})
}

// Pause is the owner's pause.
func (m *Manager) Pause(id string) (Link, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.links[id]
	if !ok {
		return Link{}, ErrNotFound
	}
	if l.State != StateLive {
		return Link{}, ErrState
	}
	m.pause(l, ReasonOwner)
	return *l, m.saveLocked()
}

// Resume makes a paused link live again, naming the hash of the preview just read; it is a confirm and takes a new snapshot.
func (m *Manager) Resume(ctx context.Context, id, hash string) (Link, error) {
	p, err := m.Preview(ctx, id)
	if err != nil {
		return Link{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.links[id]
	if !ok {
		return Link{}, ErrNotFound
	}
	if l.State != StatePaused {
		return Link{}, ErrState
	}
	if hash == "" || hash != p.Hash {
		return Link{}, ErrBadHash
	}
	rows, err := m.cfg.Source(l.Team).Agents(ctx)
	if err != nil {
		return Link{}, err
	}
	m.approve(l, agentKeys(rows), p.Hash)
	return *l, m.saveLocked()
}

// Stop ends a link here, at once. It tells the Hub nothing: the Hub learns by the next frame's absence and by the owner's own stop there.
func (m *Manager) Stop(id string) (Link, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.links[id]
	if !ok {
		return Link{}, ErrNotFound
	}
	l.State, l.PausedReason = StateStopped, ""
	return *l, m.saveLocked()
}

// HubReply applies the one thing a frame reply may carry that this side uses: a stop or pause only turns things off (design 1), and the last-viewed age is shown, never decided on.
func (m *Manager) HubReply(id string, stop, pause bool, lastViewedS *int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.links[id]
	if !ok || l.State == StateStopped {
		return
	}
	if lastViewedS != nil && *lastViewedS >= 0 && *lastViewedS <= 31*24*3600 {
		v := *lastViewedS
		l.LastViewedS = &v
	}
	switch {
	case stop:
		l.State, l.PausedReason = StateStopped, ""
		l.HubStops++
	case pause && l.State == StateLive:
		l.State, l.PausedReason = StatePaused, ReasonHub
		l.HubStops++
	}
	_ = m.saveLocked()
}

// Tick applies the clock: expiry stops a link, the end of grace (or a clock set back before the confirm) pauses it with reason not_reconfirmed, and chat turns off for an agent whose generation changed (MUST B).
func (m *Manager) Tick(ctx context.Context) error {
	m.mu.Lock()
	ids := append([]string(nil), m.order...)
	m.mu.Unlock()
	for _, id := range ids {
		m.mu.Lock()
		l := m.links[id]
		m.mu.Unlock()
		if l == nil || l.State != StateLive {
			continue
		}
		var rows []AgentRow
		if l.Approved != nil && l.Approved.ChatKey != "" {
			var err error
			if rows, err = m.cfg.Source(l.Team).Agents(ctx); err != nil {
				rows = nil // an unreadable roster cannot keep chat on: it is treated as the agent gone
			}
		}
		m.mu.Lock()
		l = m.links[id]
		now := m.cfg.Clock.Now()
		if l.State == StateLive && l.Approved != nil && l.Approved.ChatKey != "" && !chatStillBound(l, rows) {
			l.Approved.ChatKey, l.Approved.ChatGen = "", ""
			l.Views.ChatKey, l.ChatGen, l.ChatSince = "", "", time.Time{}
			l.ChatOffWhy = "the agent restarted"
		}
		if l.State == StateLive {
			_, pauseAt := Deadlines(*l)
			switch {
			case !l.ExpiresAt.IsZero() && !now.Before(l.ExpiresAt):
				l.State, l.PausedReason = StateStopped, ""
			case !now.Before(pauseAt) || now.Before(l.ConfirmedAt):
				m.pause(l, ReasonNotReconfirmed)
			}
		}
		m.mu.Unlock()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.saveLocked()
}

func chatStillBound(l *Link, rows []AgentRow) bool {
	for _, r := range rows {
		if r.Key == l.Approved.ChatKey {
			return r.Generation != "" && r.Generation == l.Approved.ChatGen && !r.Archived
		}
	}
	return false
}

// CanPush is the pusher's check before every frame (MUST D): the link is live, the Hub link is the stored one and well formed, the clock is before the end of grace (and not set back before the confirm), and it has not expired.
func (m *Manager) CanPush(id, hubLink string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.links[id]
	if !ok {
		return ErrNotFound
	}
	if l.State != StateLive || l.Approved == nil {
		return ErrState
	}
	if !hubLinkRE.MatchString(hubLink) || hubLink != l.HubLink {
		return ErrBadHubLink
	}
	now := m.cfg.Clock.Now()
	_, pauseAt := Deadlines(*l)
	if !now.Before(pauseAt) || now.Before(l.ConfirmedAt) || (!l.ExpiresAt.IsZero() && !now.Before(l.ExpiresAt)) {
		return ErrState
	}
	return nil
}

// Frame builds what would be pushed now from the approved snapshot only (MUST A): the draft and an agent that joined later play no part.
func (m *Manager) Frame(ctx context.Context, id string, seq uint64) (Frame, error) {
	m.mu.Lock()
	l, ok := m.links[id]
	if !ok {
		m.mu.Unlock()
		return Frame{}, ErrNotFound
	}
	cp := *l
	m.mu.Unlock()
	if cp.State != StateLive || cp.Approved == nil {
		return Frame{}, ErrState
	}
	in, err := Gather(ctx, m.cfg.Source(cp.Team), shownSet(cp.Approved.AgentKeys))
	if err != nil {
		return Frame{}, err
	}
	return Build(in, Options{Seq: seq}, m.cfg.Redactor), nil
}

var _ = ErrNotAllowed
