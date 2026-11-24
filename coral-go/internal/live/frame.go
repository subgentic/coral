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

// Agent is one agent the owner chose to show. Role is its only display field (the role name, else "Agent N"); the real name and any owner label are
// not on the wire in the first proof (coral-hub's strict decode, #270101). Chat is on the one chosen agent only (at most maxChat messages), and absent otherwise.
type Agent struct {
	Role   string `json:"role"`
	Status string `json:"status"`
	Task   string `json:"task"`
	Chat   []Chat `json:"chat,omitempty"`
}

// Chat is one chat message of the chosen agent, or {w:true} for a withheld one. From is "person" (what a person typed to the agent) or "agent" (its reply): a closed pair.
type Chat struct {
	From string `json:"from,omitempty"`
	Text string `json:"text,omitempty"`
	At   int64  `json:"at,omitempty"`
	W    bool   `json:"w,omitempty"`
}

// Post is a board post, or {w:true} standing for a run of withheld ones: no author, no time, no text, no count. The viewer's fixed words are built by the
// Hub, never sent from here.
type Post struct {
	From string `json:"from,omitempty"`
	Text string `json:"text,omitempty"`
	At   int64  `json:"at,omitempty"`
	W    bool   `json:"w,omitempty"`
}
