package routes

import (
	"context"
	"net/http"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/board"
)

// The kind of an upload for review (#12144): `coral-agent artifact upload ... --tag "for review" --question "..." --kind done`. No --kind is a plain file, which an agent can never quiet. A non-default kind
// is accepted only when the server can check a fact for it, never on the agent's word, so an agent cannot label its approval request as a release summary to get it muted:
//   done     needs --task N of an OPERATOR task assigned to this agent;
//   release  needs --task N of a task titled exactly "Release vX.Y.Z" assigned to this agent;
//   decided  only from the team's Orchestrator;
//   digest   only Coral writes one: an agent's --kind digest is refused.
// The kind belongs to the series: a later version carries the series' kind or none (and then has it), never a new one.

var releaseTitleRe = regexp.MustCompile(`^Release v[0-9]+\.[0-9]+\.[0-9]+$`)

const kindWords = "kind is one of done, release or decided (no --kind is a plain file)"

// uploadKindFor is the kind an upload asks for, "" for a plain file, or the plain-words reason it is refused. It reads nothing from the file: the facts come from the task rows and the board's roster.
func (h *SessionsHandler) uploadKindFor(ctx context.Context, r *http.Request, taskID int64, forReview bool) (kind, refused string) {
	asked := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("kind")))
	if asked == "" || asked == board.KindFile {
		return "", ""
	}
	if !board.ValidArtifactKind(asked) {
		return "", "--" + kindWords
	}
	if asked == board.KindDigest {
		return "", "a digest is written only by Coral itself: --kind digest is refused (" + kindWords + ")"
	}
	if !forReview {
		return "", "--kind is for a file for review: add --tag \"for review\" and --question"
	}
	owner, ok := VerifiedSession(ctx)
	if !ok || owner == nil || h.bs == nil {
		return "", "--kind can only be set by an agent that is on a team's board"
	}
	sub, err := h.bs.GetSubscriptionBySessionName(ctx, owner.SessionName)
	if err != nil || sub == nil {
		return "", "--kind can only be set by an agent that is on a team's board"
	}
	switch asked {
	case board.KindDecided:
		if h.bs.RequireTaskReviewer(ctx, sub.Project, sub.SubscriberID) != nil {
			return "", "--kind decided is accepted only from the team's Orchestrator"
		}
	case board.KindDone, board.KindRelease:
		if taskID <= 0 {
			return "", "--kind " + asked + " needs --task N: the task this file is for, one of yours on this board"
		}
		task, terr := h.bs.GetTask(ctx, sub.Project, taskID)
		if terr != nil || task == nil || task.AssignedTo == nil || *task.AssignedTo != sub.SubscriberID {
			return "", "--kind " + asked + " needs --task N, a task assigned to you"
		}
		if asked == board.KindDone && !strings.HasPrefix(task.Title, "OPERATOR") {
			return "", "--kind done is for the file that finishes an OPERATOR task: that task's title does not begin with OPERATOR"
		}
		if asked == board.KindRelease && !releaseTitleRe.MatchString(task.Title) {
			return "", "--kind release is for the task titled exactly Release vX.Y.Z"
		}
	}
	return asked, ""
}

// seriesKindFor applies the series rule to a new version: seriesKind is the kind the series already has ("" for a plain file). A version asks for that kind or none (and then has it); a different kind is refused,
// so version 2 cannot silence a request that was loud as version 1, nor turn a plain file into a quieter one.
func seriesKindFor(seriesKind, asked string) (kind, refused string) {
	switch {
	case asked == seriesKind:
		return seriesKind, ""
	case asked == "":
		return seriesKind, "" // a version with no --kind takes the series' kind
	default:
		if seriesKind == "" {
			return "", "this file is a plain file for review: a new version cannot be a " + asked + " (the kind belongs to the series)"
		}
		return "", "this series is a " + seriesKind + " file: a new version cannot be a " + asked + " (the kind belongs to the series)"
	}
}
