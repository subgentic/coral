package tunnel

import (
	"net/http"
	"sync"
)

// The streams this process is forwarding for a Hub person, across every link (#20581 b, Security B4). A grant that is revoked or expires, a link that ends, or a cap that falls must close a stream that is already open, within a
// moment: a check made only when a stream opens would let a terminal run on after its grant ended. Each long stream (a WebSocket, an event stream or another long request) of a named Hub person records which link and person it is
// for, the tier its route needs, and how to end it; the server's sweeper asks Coral's own grant table about each and ends the ones that no longer pass. Nothing here decides anything.
type openStream struct {
	link, user   string
	need         Tier
	method, path string
	end          func()
}

var openStreams = struct {
	mu sync.Mutex
	m  map[*openStream]struct{}
}{m: map[*openStream]struct{}{}}

// RegisterOpenStream records an open stream of a Hub person and returns what removes it. A stream with no person (the owner's own) is not recorded: grants never decide it.
func RegisterOpenStream(link, user string, need Tier, method, path string, end func()) (unregister func()) {
	if user == "" {
		return func() {}
	}
	e := &openStream{link: link, user: user, need: need, method: method, path: path, end: end}
	openStreams.mu.Lock()
	openStreams.m[e] = struct{}{}
	openStreams.mu.Unlock()
	return func() {
		openStreams.mu.Lock()
		delete(openStreams.m, e)
		openStreams.mu.Unlock()
	}
}

// OpenStreamKey is one kind of open stream: a person on a link, the tier their route needs, and the route itself (its method and decoded path, which carry the board), so a sweep decides it exactly as a new request is decided:
// revoking the grant for board A ends the streams on A while a grant for board B keeps B's.
type OpenStreamKey struct {
	Link, User   string
	Need         Tier
	Method, Path string
}

// OpenStreamKeys lists the distinct (link, person, tier) of the streams open now.
func OpenStreamKeys() []OpenStreamKey {
	openStreams.mu.Lock()
	defer openStreams.mu.Unlock()
	seen := map[OpenStreamKey]bool{}
	var out []OpenStreamKey
	for e := range openStreams.m {
		k := OpenStreamKey{e.link, e.user, e.need, e.method, e.path}
		if !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

// EndOpenStreams ends every open stream of that key and reports how many. The ends run outside the lock.
func EndOpenStreams(k OpenStreamKey) int {
	openStreams.mu.Lock()
	var ending []*openStream
	for e := range openStreams.m {
		if (OpenStreamKey{e.link, e.user, e.need, e.method, e.path}) == k {
			ending = append(ending, e)
		}
	}
	openStreams.mu.Unlock()
	for _, e := range ending {
		e.end()
	}
	return len(ending)
}

// streamNeed is the tier a long stream's route needs, read from the table the way a request is.
func streamNeed(method, dec, query string) Tier {
	if method == "" {
		method = http.MethodGet
	}
	return Classify(method, dec, query)
}
