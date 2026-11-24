package live

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// The pusher (#21064, design v4 sections 1, 5 and 14): it sends the approved frame to the Hub link a live link is bound to, and the confirm and paused messages the Manager queues.
// It is the only code that talks to the Hub for Live, through one Transport (the tunnel's "live" kind, live_push/1). Nothing the Hub answers widens anything: stop and pause turn things off,
// not_live stops frames until a person confirms again, and a reply outside the closed set (reply.go) blocks that link until a person confirms.

// Transport sends one live request through the tunnel of the Hub link via (the id of one of this computer's own Hub links, never another) and returns the reply body, whatever the HTTP status.
// An error is a transport failure: no tunnel for that id (it must never fall back to another Hub link), a closed stream, a timeout.
type Transport func(ctx context.Context, via, path string, body []byte) ([]byte, error)

const (
	minFrameGap    = 2 * time.Second  // the Hub's rate: at most one push per 2 s per link
	keepAlive      = 60 * time.Second // an unchanged picture is sent again so the Hub does not read silence (7 days of it pauses a link)
	messageRetry   = 10 * time.Minute // a confirm or paused message is retried with backoff for this long
	maxFrameBytes  = 64 << 10
	maxSmallBytes  = 256
	maxBackoff     = time.Minute
	defaultDelayS  = 30
	maxFrameAge    = 120 * time.Second // coral-hub Security: no frame is pushed more than this after it was built; an older one is dropped and a fresh one built
	MaxDelayS      = 90                // the longest delay a link may ask for: a frame waits its delay and must still go out inside maxFrameAge
	protocolStrike = 3
)

// Pusher drives one Manager.
type Pusher struct {
	m    *Manager
	send Transport

	mu     sync.Mutex
	st     map[string]*pushState // by link id; memory only (MUST 5): the picture and its delay buffer, wiped with Wipe
	out    []*outMsg
	hub    map[string]*hubState // by Hub link uuid
	Counts Counts
}

// Counts are totals only, never text.
type Counts struct {
	FramesSent, MessagesSent, Protocol, BadFrame, TooBig, TransportErr, RateLimited int
}

type pushState struct {
	seq      uint64
	lastSent time.Time
	lastKey  string
	buf      []buffered
	retryAt  time.Time
	backoff  time.Duration
}

type buffered struct {
	at  time.Time
	key string
	f   Frame
}

type hubState struct{ notLive, blocked bool }

type outMsg struct {
	hub      string
	via      string
	path     string
	body     []byte
	next     time.Time
	deadline time.Time
	backoff  time.Duration
}

// NewPusher makes a pusher for m that sends through send.
func NewPusher(m *Manager, send Transport) *Pusher {
	return &Pusher{m: m, send: send, st: map[string]*pushState{}, hub: map[string]*hubState{}}
}

type confirmBody struct {
	Link         string `json:"link"`
	Chat         bool   `json:"chat"`
	ChatSince    int64  `json:"chat_since"`
	ReconfirmDue int64  `json:"reconfirm_due"`
}

type pausedBody struct {
	Link   string `json:"link"`
	Reason string `json:"reason"`
}

type frameBody struct {
	Link  string `json:"link"`
	Frame Frame  `json:"frame"`
}

// encode turns a Manager message into a request: closed structs only, within the size the Hub reads.
func encode(msg Message) (path string, body []byte, ok bool) {
	if !hubLinkRE.MatchString(msg.HubLink) {
		return "", nil, false
	}
	var err error
	switch msg.Kind {
	case "confirm":
		path = PathConfirm
		body, err = json.Marshal(confirmBody{Link: msg.HubLink, Chat: msg.Chat, ChatSince: msg.ChatSince, ReconfirmDue: msg.ReconfirmDue})
	case "paused":
		if msg.Reason != ReasonNotReconfirmed && msg.Reason != ReasonOwner && msg.Reason != ReasonRestart {
			return "", nil, false
		}
		path = PathPaused
		body, err = json.Marshal(pausedBody{Link: msg.HubLink, Reason: msg.Reason})
	default:
		return "", nil, false
	}
	if err != nil || len(body) > maxSmallBytes {
		return "", nil, false
	}
	return path, body, true
}

func (p *Pusher) hubOf(h string) *hubState {
	s := p.hub[h]
	if s == nil {
		s = &hubState{}
		p.hub[h] = s
	}
	return s
}

// queue takes the Manager's messages. A later message for the same Hub link replaces a queued one (a confirm cancels a queued paused, and the other way round); a confirm is a person's act, so it also
// clears what blocked that link's frames.
func (p *Pusher) queue(now time.Time, msgs []Message) {
	for _, msg := range msgs {
		path, body, ok := encode(msg)
		if !ok {
			continue
		}
		kept := p.out[:0]
		for _, o := range p.out {
			if o.hub != msg.HubLink {
				kept = append(kept, o)
			}
		}
		p.out = append(kept, &outMsg{hub: msg.HubLink, via: msg.Via, path: path, body: body, next: now, deadline: now.Add(messageRetry), backoff: time.Second})
		if msg.Kind == "confirm" && msg.Person { // only a person's act lets a blocked link push again, not the confirm Tick sends when chat drops
			*p.hubOf(msg.HubLink) = hubState{}
		}
		if msg.Kind == "paused" {
			p.wipeHub(msg.HubLink)
		}
	}
}

func (p *Pusher) wipeHub(hub string) {
	for _, l := range p.m.List() {
		if l.HubLink == hub {
			delete(p.st, l.ID)
		}
	}
}

// Wipe forgets every picture and delay buffer (a closed tunnel, shutdown).
func (p *Pusher) Wipe() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.st = map[string]*pushState{}
}

func nextBackoff(b time.Duration) time.Duration {
	if b *= 2; b > maxBackoff {
		return maxBackoff
	}
	return b
}

// Step is one pass: apply the clock, send the queued messages, then each live link's frame. Call it about once a second.
func (p *Pusher) Step(ctx context.Context) {
	p.mu.Lock()
	defer p.mu.Unlock()
	_ = p.m.Tick(ctx)
	now := p.m.cfg.Clock.Now()
	p.queue(now, p.m.Drain())
	p.flush(ctx, now)
	links := p.m.List()
	live := map[string]bool{}
	for _, l := range links {
		if l.State == StateLive {
			live[l.ID] = true
		}
	}
	for id := range p.st {
		if !live[id] {
			delete(p.st, id) // paused, stopped or gone: nothing held (MUST 5)
		}
	}
	for _, l := range links {
		if l.State == StateLive {
			p.frame(ctx, now, l)
		}
	}
}

func (p *Pusher) flush(ctx context.Context, now time.Time) {
	kept := p.out[:0]
	for _, o := range p.out {
		if now.Before(o.next) {
			kept = append(kept, o)
			continue
		}
		raw, err := p.send(ctx, o.via, o.path, o.body)
		if err != nil {
			p.Counts.TransportErr++
			o.backoff = nextBackoff(o.backoff)
			o.next = now.Add(o.backoff)
			if o.next.Before(o.deadline) {
				kept = append(kept, o)
			}
			continue
		}
		p.Counts.MessagesSent++
		r, err := DecodeReply(o.path, raw)
		switch {
		case err != nil:
			p.Counts.Protocol++
			p.hubOf(o.hub).blocked = true
		case r.NotLive:
			p.hubOf(o.hub).notLive = true
		case r.BadFrame:
			p.Counts.BadFrame++ // a bug here: counted, the link keeps its state
		case r.RateLimited:
			p.Counts.RateLimited++
			o.next = now.Add(5 * time.Second)
			if o.next.Before(o.deadline) {
				kept = append(kept, o)
			}
		}
	}
	p.out = kept
}

func (p *Pusher) frame(ctx context.Context, now time.Time, l Link) {
	h := p.hubOf(l.HubLink)
	if h.notLive || h.blocked || l.Approved == nil {
		return
	}
	s := p.st[l.ID]
	if s == nil {
		s = &pushState{}
		p.st[l.ID] = s
	}
	if now.Before(s.retryAt) {
		return
	}
	// MUST D: the link and the deadline are checked here, and again after the frame is built, before anything is sent.
	if p.m.CanPush(l.ID, l.HubLink) != nil {
		delete(p.st, l.ID)
		return
	}
	f, err := p.m.Frame(ctx, l.ID, 0)
	if err != nil {
		return
	}
	p.dropOld(s, now) // frames held across a failure backoff are too old to send: only a fresh one goes
	key := frameKey(f)
	if n := len(s.buf); n == 0 || s.buf[n-1].key != key {
		s.buf = append(s.buf, buffered{at: now, key: key, f: f})
	}
	delay := time.Duration(min(l.Approved.DelayS, MaxDelayS)) * time.Second
	if l.Approved.DelayS == 0 {
		delay = defaultDelayS * time.Second
	}
	rel := -1
	for i, b := range s.buf {
		if !now.Before(b.at.Add(delay)) {
			rel = i
		}
	}
	if rel < 0 {
		return
	}
	out := s.buf[rel]
	s.buf = append([]buffered(nil), s.buf[rel:]...)
	if now.Sub(out.at) > maxFrameAge { // checked again right before sending
		s.buf = nil
		return
	}
	if now.Sub(s.lastSent) < minFrameGap || (out.key == s.lastKey && now.Sub(s.lastSent) < keepAlive) {
		return
	}
	if p.m.CanPush(l.ID, l.HubLink) != nil {
		delete(p.st, l.ID)
		return
	}
	out.f.Seq = s.seq + 1
	body, err := json.Marshal(frameBody{Link: l.HubLink, Frame: out.f})
	if err != nil || len(body) > maxFrameBytes {
		p.Counts.TooBig++
		return
	}
	raw, err := p.send(ctx, l.Via, PathFrame, body)
	if err != nil {
		p.Counts.TransportErr++
		s.backoff = nextBackoff(max(s.backoff, time.Second/2))
		s.retryAt = now.Add(s.backoff)
		return
	}
	s.seq++
	s.lastSent, s.lastKey = now, "" // the picture counts as delivered only on an ok reply
	p.Counts.FramesSent++
	r, derr := DecodeReply(PathFrame, raw)
	switch {
	case derr != nil:
		p.Counts.Protocol++
		h.blocked = true
		delete(p.st, l.ID)
	case r.OK:
		s.backoff, s.lastKey = 0, out.key
		p.m.HubReply(l.ID, false, false, r.LastViewedS)
	case r.Stop:
		p.m.HubReply(l.ID, true, false, nil)
		delete(p.st, l.ID)
	case r.Pause:
		p.m.HubReply(l.ID, false, true, nil)
		delete(p.st, l.ID)
	case r.NotLive:
		h.notLive = true
		delete(p.st, l.ID)
	case r.RateLimited:
		p.Counts.RateLimited++
		s.backoff = nextBackoff(max(s.backoff, time.Second))
		s.retryAt = now.Add(s.backoff)
	case r.BadFrame:
		p.Counts.BadFrame++
		s.retryAt = now.Add(30 * time.Second)
	}
}

// dropOld forgets the held frames built more than maxFrameAge ago.
func (p *Pusher) dropOld(s *pushState, now time.Time) {
	kept := s.buf[:0:0]
	for _, b := range s.buf {
		if now.Sub(b.at) <= maxFrameAge {
			kept = append(kept, b)
		}
	}
	s.buf = kept
}

// frameKey is the picture without its sequence number.
func frameKey(f Frame) string {
	f.Seq = 0
	b, _ := json.Marshal(f)
	return string(b)
}
