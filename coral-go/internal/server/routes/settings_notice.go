package routes

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/secrets"
)

// noteSettingsChange tells the team's Orchestrator what a save changed (#13173): the settings before and after, as the board stores them, diffed by name; one message per save from "Coral Settings", gathered
// with a team's other saves of the next seconds (board.NoteSettingsChange). It never fails the save. Values pass the secret redactor and a setting named like a credential shows no value at all.
func noteSettingsChange(bs *board.Store, r *http.Request, project string, before, after any) {
	changes := board.DiffSettings(before, after)
	if len(changes) == 0 {
		return
	}
	for i := range changes {
		changes[i].Old, changes[i].New = settingShown(changes[i].Name, changes[i].Old), settingShown(changes[i].Name, changes[i].New)
	}
	who, actorID := settingsChanger(r)
	bs.NoteSettingsChange(project, who, actorID, changes)
}

var settingSecretName = regexp.MustCompile(`(?i)token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|_key$|^key$`)

// settingShown is a value as the message shows it: hidden for a setting named like a credential, redacted for anything that looks like one.
func settingShown(name, v string) string {
	if settingSecretName.MatchString(name) {
		return "(hidden)"
	}
	out, err := secrets.Redactor().Text([]byte(v))
	if err != nil {
		return "(not shown)"
	}
	return string(out)
}

// settingsChanger is how the message names whoever made the change, and its member id (so an Orchestrator's own change is not told back to it): the Operator, the Operator through Coral Hub (with the hub user
// when it has one), or a member's own name.
func settingsChanger(r *http.Request) (who, actorID string) {
	a := callerActor(r)
	switch {
	case a.Kind == ActorToken && a.Name != "":
		return a.Name, a.Name
	case a.Kind == ActorHub:
		if id := hubOwnerRequest(r); id.pseudo != "" {
			return "The Operator (through Coral Hub, " + strings.TrimSpace(id.pseudo) + ")", "Operator"
		}
		return "The Operator (through Coral Hub)", "Operator"
	case a.Kind == ActorOperator:
		return "The Operator", "Operator"
	}
	return "The Operator", "Operator"
}
