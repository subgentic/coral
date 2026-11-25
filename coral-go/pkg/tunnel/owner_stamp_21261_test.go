package tunnel

import (
	"net/http"
	"testing"

	"github.com/subgentic/coral/pkg/hubowner"
)

// #21261: the owner stamp is scrubbed like every header off the allowlist, so a Hub that sends one over a tunnel (a hosted Hub's, say) never has it reach the local server; only the in-process key-link bridge, which
// sets AllowOwnerStamp, puts it back, in whatever spelling it came, for the local server to check against the key link's own hub secret.
func TestTheOwnerStampIsScrubbedAndOnlyAKeyBridgeKeepsIt(t *testing.T) {
	in := http.Header{"x-coral-hub-owner": {"stamp-a"}, "Content-Type": {"application/json"}}
	if got := scrub(in, http.MethodPost, "/api/sessions/live/x/answer-prompt"); len(got.Values(hubowner.Header)) != 0 {
		t.Fatalf("scrub kept the owner stamp: %v", got)
	}
	for allow, want := range map[bool]int{false: 0, true: 1} {
		l := &LocalHandler{AllowOwnerStamp: allow}
		out := scrub(in, http.MethodPost, "/api/sessions/live/x/answer-prompt")
		l.keepOwnerStamp(out, in)
		if got := out.Values(hubowner.Header); len(got) != want || want == 1 && got[0] != "stamp-a" {
			t.Errorf("AllowOwnerStamp=%v: stamp values %v, want %d", allow, got, want)
		}
	}
}
