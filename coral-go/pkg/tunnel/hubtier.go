package tunnel

import "context"

// The Coral Hub viewer's tier (#3958, the operator's decision): a viewer who can type
// (Interact or Launch) gets what the computer answers as it is; a viewer who can only look
// (View) gets it with tokens hidden. The hub decides each member's tier; the connector caps it
// at the computer's own mode.
//
// It travels as a field of the stream (Header.HubTier), set from the context the hub's
// embedder gives the request (WithHubTier) after authenticating its member, never from an
// HTTP header a browser could send (Security's #3964 finding 3). The connector reads only the
// field: an X-Coral-Hub-Tier header in the request is not on its allowlist and never reaches
// the Coral server either.

type hubTierKey struct{}

// WithHubTier returns ctx carrying the viewer's effective tier, "view", "interact" or
// "launch" (exactly, lower case). Session.RoundTrip and Session.DialWS send it with the
// stream. An empty tier is no tier: the stream carries none (an older hub) and only the
// computer's mode holds it, as before. A tier that is there but is not exactly one of the three
// is carried as "view", never dropped: a dropped one would arrive as no tier, which is the
// highest ceiling, so a misspelling ("Launch") fails closed, for requests, terminal frames and
// redaction alike (#7278).
func WithHubTier(ctx context.Context, tier string) context.Context {
	if tier == "" {
		return ctx
	}
	if _, ok := parseHubTier(tier); !ok {
		tier = "view"
	}
	return context.WithValue(ctx, hubTierKey{}, tier)
}

func hubTierFrom(ctx context.Context) string {
	t, _ := ctx.Value(hubTierKey{}).(string)
	return t
}

// parseHubTier reads a stream's HubTier exactly: "view", "interact" or "launch". ok is false
// for anything else, empty included.
func parseHubTier(s string) (Tier, bool) {
	switch s {
	case "view":
		return TierView, true
	case "interact":
		return TierInteract, true
	case "launch":
		return TierLaunch, true
	}
	return TierView, false
}

// viewerTier is a stream's viewer tier: its HubTier when exact, else View (an older hub, or a
// value this connector doesn't know, stays redacted).
func viewerTier(h Header) Tier {
	t, _ := parseHubTier(h.HubTier)
	return t
}

// viewerCeiling is the highest tier the stream's viewer may use (#7076): its HubTier when exact, View for a value that is there but is not one (as viewerTier reads it), and Launch for a
// stream that carries none (an older hub, or one that does not name the viewer's tier), which stays held only by the computer's own mode, as before. A viewer's tier used to decide only
// what is redacted; the requests and terminal frames of a viewer who can only look are now refused here too, so "View never sends input" holds on this computer and not only in the hub.
func viewerCeiling(h Header) Mode {
	if h.HubTier == "" {
		return TierLaunch
	}
	t, _ := parseHubTier(h.HubTier)
	return t
}

// viewerMayUse reports whether the stream's viewer may make this request: the route's tier is known and no higher than the viewer's ceiling. The computer's mode is checked separately
// (AllowRequest), so the lower of the two applies.
func viewerMayUse(h Header, method, decodedPath string) bool {
	ceiling := viewerCeiling(h)
	if ceiling >= TierLaunch {
		return true
	}
	t := Classify(method, decodedPath, h.Query)
	return t != TierNever && t <= ceiling
}

// redactFor reports, each time it is called, whether what a viewer of this tier is sent is
// redacted: the owner's switch (RedactTokens) is on and the viewer can only look, the lower of
// its tier and the computer's current mode being View. A stream calls it for every frame, so
// lowering the computer's mode to View redacts from the next frame on.
func (l *LocalHandler) redactFor(viewer Tier) func() bool {
	return func() bool {
		return l.redacting() && Lower(viewer, currentMode(l.MaxMode)) <= TierView
	}
}
