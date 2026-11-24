// Package live builds Coral Live's public frame (#21014, design note v2): a closed type made from named fields, never from a session row. Nothing
// here touches the network, a file or a database; the gate that sends a frame is a later slice and ships shut.
package live

// Status is the closed set of words the public sees for an agent.
type Status string

const (
	StatusWorking Status = "working"
	StatusIdle    Status = "idle"
	StatusWaiting Status = "waiting"
	StatusAsleep  Status = "asleep"
)

// Frame is what leaves this computer. It is a closed list: a field added here fails TestFrameFieldCensus until the list, the design note and
// Security's read are changed too. It has no map, no interface and no embedded row.
type Frame struct {
	V      int     `json:"v"`
	Seq    uint64  `json:"seq"`
	Agents []Agent `json:"agents"`
	Posts  []Post  `json:"posts"`
}

// Agent is one agent the owner chose to show. Label is the owner's public label, else the role, else "Agent N"; the real name is never here.
type Agent struct {
	Label  string `json:"label"`
	Role   string `json:"role"`
	CLI    string `json:"cli"`
	Status string `json:"status"`
	Task   string `json:"task"`
}

// Post is a board post, or the one fixed marker that stands for a run of withheld ones (no author, no time, no count).
type Post struct {
	Author   string `json:"author"`
	Text     string `json:"text"`
	At       int64  `json:"at"`
	Withheld bool   `json:"withheld"`
}

// MarkerMessage is the only text a withheld post carries. The computer sends no count and no dropped text.
const MarkerMessage = "... (message withheld) ..."
