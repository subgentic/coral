package routes

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/subgentic/coral/internal/board"
)

// HubOperatorPrefix starts the text of a post the Operator made through Coral Hub
// (#3404), so an agent reading it can tell a remote Hub user's post from the local
// Operator's: "[Operator via Coral Hub, hub-user-1a2b3c4d] ".
func HubOperatorPrefix(hubUser string) string {
	return "[Operator via Coral Hub, " + hubUser + "] "
}

// HubUserNoAnswerPrefix starts the text of a post made through a Hub link that may not answer asks (#20413, #20498): the agent that reads it is told whose it is, a Hub person's, and that it is
// not the Operator and answers nothing, so such a post cannot approve in words.
func HubUserNoAnswerPrefix(hubUser string) string {
	return "[Coral Hub user " + hubUser + ", not the Operator: this answers no ask] "
}

type hubOperatorKey struct{}

// withHubOperator marks a request admitted to act as the Operator through Coral Hub,
// on behalf of hubUser (TunnelIdentityGuard).
func withHubOperator(r *http.Request, hubUser string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), hubOperatorKey{}, hubUser))
}

// hubOperatorUser is the Coral Hub user acting as the Operator in this request, or "".
func hubOperatorUser(r *http.Request) string {
	u, _ := r.Context().Value(hubOperatorKey{}).(string)
	return u
}

// recordHubOperatorAction records and logs one use of the Operator identity through
// Coral Hub, attributed to the validated Hub user. (It takes the request's method and
// path, not the request: tools/gen_route_queries.py follows calls that pass r.)
func recordHubOperatorAction(ctx context.Context, bs *board.Store, hubUser, method, path, project string, status int) {
	recordHubOperatorActionAs(ctx, bs, hubUser, "", method, path, project, status)
}

// recordHubOwnerAction is recordHubOperatorAction for an owner route: the person is the one the stamp named, with their stable id when the machine is a team's (#7061), so a renamed or removed
// member never re-attributes the record.
func recordHubOwnerAction(ctx context.Context, bs *board.Store, id callerIdentity, method, path, project string, status int) {
	recordHubOperatorActionAs(ctx, bs, id.pseudo, id.hubUserID, method, path, project, status)
}

// linkOriginOf reads a link's Hub address from the stored link (set with the link store); "" for an unknown link. A log line names the address only from here, never from a header or the Hub's own words.
var linkOriginOf = func(context.Context, string) string { return "" }

func recordHubOperatorActionAs(ctx context.Context, bs *board.Store, hubUser, hubUserID, method, path, project string, status int) {
	attrs := []any{"hub_user", hubUser}
	if hubUserID != "" {
		attrs = append(attrs, "hub_user_id", hubUserID)
	}
	if v, ok := board.ActionViaFrom(ctx); ok && v.LinkID != "" { // the link and the Hub person behind it, as the connector stamped them (#20312): id, address and pseudonym only
		attrs = append(attrs, "link", v.LinkID)
		if o := linkOriginOf(ctx, v.LinkID); o != "" {
			attrs = append(attrs, "hub", o)
		}
		if v.HubUser != "" {
			attrs = append(attrs, "via_hub_user", v.HubUser)
		}
	}
	attrs = append(attrs, "method", method, "path", path, "status", status)
	// logsafe-ok: a request's URL path, not a place on this computer
	slog.Info("[cloud] Coral Hub acted as the Operator", attrs...)
	if bs == nil {
		return
	}
	if err := bs.RecordHubOperatorAction(context.WithoutCancel(ctx), board.HubOperatorAction{
		HubUser: hubUser, HubUserID: hubUserID, Method: method, Path: path, Project: project, Status: status,
	}); err != nil {
		slog.Warn("[cloud] could not record a Coral Hub Operator action", "error", err)
	}
}

// RecordHubSigninAction records what a Coral Hub sign-in did, or happened to it (#3966), in the
// same Operator-actions log: who is "Coral Hub: <name>" or "this computer"; an event has
// method "EVENT" and its text as the path.
func RecordHubSigninAction(ctx context.Context, bs *board.Store, who, method, path string, status int) {
	recordHubOperatorAction(ctx, bs, who, method, path, "", status)
}

// statusRecorder remembers the status a handler wrote.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }
