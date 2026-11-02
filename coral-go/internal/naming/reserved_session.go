package naming

import "strings"

// PersonPictureSessionID is the id the person's own pictures are kept under when no agent's team can hold them (a marked-up picture, a goal's picture on a team with no agent: #12176). It is no session of Coral's: it is
// spelled "person" and "pictur" in hex: it is no test's made-up id (00000000-...-0000000000a1 and its like are everywhere in the tests) and no random id of a real session. It is
// refused wherever a session id is registered, resumed or bound (IsReservedSessionID), so an agent's session can never be this id and read or replace what is kept under it.
const PersonPictureSessionID = "70657273-6f6e-4000-8000-706963747572"

// IsReservedSessionID says whether id is one no session may have, however it is written (case, white space around it).
func IsReservedSessionID(id string) bool {
	return strings.EqualFold(strings.TrimSpace(id), PersonPictureSessionID)
}
