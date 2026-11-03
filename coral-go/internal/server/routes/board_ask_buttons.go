package routes

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/httputil"
)

// checkAskButtons validates the buttons an agent declares on a question (#11643) before anything is posted, and writes the refusal itself. Buttons go only on an ask to @Operator alone, from a verified agent of
// the team (never the Operator, a guide or a script); every button is checked against the grammar and against this team (a task, an artifact, a member), and the agent may have a few such asks open at once.
func (h *BoardHandler) checkAskButtons(w http.ResponseWriter, r *http.Request, project string, body postMessageBody, asked []string) ([]board.AskButton, bool) {
	refuse := func(msg string) ([]board.AskButton, bool) {
		writeError(w, http.StatusBadRequest, "bad_buttons", "not posted: "+msg)
		return nil, false
	}
	if _, guide := guideOf(r); guide || body.Guide != "" || !body.Ask {
		return refuse("buttons go on a question to @Operator (post --ask)")
	}
	if len(asked) != 1 || !strings.EqualFold(asked[0], "Operator") {
		var others []string
		for _, a := range asked {
			if !strings.EqualFold(a, "Operator") {
				others = append(others, "@"+clitext.CleanName(a))
			}
		}
		why := "buttons go on a question to @Operator alone: ask only the Operator"
		if len(others) > 0 { // the usual cause of a wake button refused: the text tags the very agent it would wake (#12600)
			why += "; this text also @mentions " + strings.Join(others, ", ") + ": write the name without the @ (a wake button names who to wake)"
		}
		return refuse(why)
	}
	poster := body.SubscriberID
	if name, verified := actorName(callerActor(r)); verified {
		poster = name
	}
	if poster == "" || strings.EqualFold(poster, "Operator") || humanInputCaller(r) {
		return refuse("only an agent of the team attaches buttons to a question")
	}
	buttons, err := board.ParseAskButtons(body.Buttons, hasSignInLink)
	if err != nil {
		return refuse(err.Error())
	}
	ctx := r.Context()
	for _, b := range buttons {
		switch b.Action {
		case board.ActionOpenTask:
			id, _ := strconv.ParseInt(b.Arg, 10, 64)
			if t, err := h.bs.GetTask(ctx, project, id); err != nil || t == nil {
				return refuse("button " + strconv.Itoa(b.Pos) + " (" + b.Label + "): this team has no task " + b.Arg)
			}
		case board.ActionOpenArtifact:
			if _, ok := h.teamManagedArtifact(ctx, project, b.Arg); !ok {
				return refuse("button " + strconv.Itoa(b.Pos) + " (" + b.Label + "): this team has no such artifact the Operator can open")
			}
		case board.ActionWake:
			sub, err := h.bs.GetProjectSubscription(ctx, project, b.Arg)
			if err != nil || sub == nil || strings.EqualFold(b.Arg, "Operator") {
				why := b.Arg + " is not a member of this team"
				if board.ValidMemberName(b.Arg) != nil { // no member can have such a name (#11687): say so, and what was probably meant
					why += " (a member's name starts and ends with a letter or a digit; did you mean " + strconv.Quote(board.ValidMemberNameNear(b.Arg)) + "?)"
				}
				return refuse("button " + strconv.Itoa(b.Pos) + " (" + b.Label + "): " + why)
			}
		}
	}
	if n, err := h.bs.OpenButtonAsks(ctx, project, poster); err == nil && n >= board.AskButtonsOpenMax {
		httputil.WriteActionLimit(w, 0, "too_many_button_asks", board.ErrTooManyButtonAsks.Error()) // a per-action limit, marked as one (no Retry-After: it clears when a question is answered, not at a time)
		return nil, false
	}
	return buttons, true
}
