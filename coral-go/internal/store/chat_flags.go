package store

import (
	"context"
	"encoding/json"
	"fmt"
)

// activeChatSQL uses the live record's lifecycle, not the transcript's last-write time.
// Matching the CLI too prevents a coincident history id from marking another CLI active.
func activeChatSQL(id, source string) string {
	return fmt.Sprintf(`EXISTS(SELECT 1 FROM live_sessions ls WHERE ls.session_id = %s AND ls.agent_type = %s AND ls.status = 'active' AND ls.is_sleeping = 0 AND ls.is_archived = 0 AND ls.pid > 0)`, id, source)
}
func notesChatSQL(id string) string {
	return `EXISTS(SELECT 1 FROM session_meta sm WHERE sm.session_id = ` + id + ` AND (COALESCE(sm.notes_md,'') <> '' OR COALESCE(sm.auto_summary,'') <> ''))`
}

type ChatFlags struct {
	Starred  bool `db:"starred" json:"starred"`
	Archived bool `db:"archived" json:"archived"`
	Active   bool `db:"active" json:"active"`
}

// UpdateChatFlags changes only supplied fields in one atomic write. These flags do
// not sleep, stop or archive the agent itself.
// archivedChatSQL is whether the chat of the session id (an SQL expression) is archived, as 1 or 0: its own mailbox flag, or its agent being archived (the sidebar's Archived section). One answer for the folder
// counts, the list's Archived filter and each row's flag, so Archived (n) in the sidebar and Inbox > Archived agree (#10086). cf is the chat_flags join of the query it is in.
func archivedChatSQL(id string) string {
	return "(CASE WHEN COALESCE(cf.archived,0)=1 OR EXISTS(SELECT 1 FROM live_sessions als WHERE als.session_id=" + id + " AND als.status='active' AND als.is_archived=1) THEN 1 ELSE 0 END)"
}

func (s *SessionStore) UpdateChatFlags(ctx context.Context, id string, starred, archived *bool) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO chat_flags(session_id,starred,archived) VALUES(?,COALESCE(?,0),COALESCE(?,0))
 ON CONFLICT(session_id) DO UPDATE SET starred=COALESCE(?,chat_flags.starred),archived=COALESCE(?,chat_flags.archived)`, id, starred, archived, starred, archived)
	return err
}

// DeleteBoardChatFlags keeps a new board from inheriting a deleted board's mailbox flags.
func (s *SessionStore) DeleteBoardChatFlags(ctx context.Context, project string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM chat_flags WHERE session_id = ?", "board:"+project)
	return err
}

// ChatFlagsForBoards batches group metadata; no query per group or folder.
func (s *SessionStore) ChatFlagsForBoards(ctx context.Context, boards []string) (map[string]ChatFlags, error) {
	raw, err := json.Marshal(boards)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		ID string `db:"id"`
		ChatFlags
	}
	err = s.reader().SelectContext(ctx, &rows, `SELECT b.value AS id, COALESCE(cf.starred,0) AS starred, COALESCE(cf.archived,0) AS archived,
 EXISTS(SELECT 1 FROM live_sessions ls WHERE ls.board_name=b.value AND ls.status='active' AND ls.is_sleeping=0 AND ls.is_archived=0 AND ls.pid>0) AS active
 FROM json_each(?) b LEFT JOIN chat_flags cf ON cf.session_id='board:'||b.value`, string(raw))
	out := map[string]ChatFlags{}
	for _, r := range rows {
		out[r.ID] = r.ChatFlags
	}
	return out, err
}

type ChatFolderTag struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
	Count int    `json:"count"`
}
type ChatFolderCounts struct {
	All         int             `json:"all"`
	Group       int             `json:"group"`
	Notes       int             `json:"notes"`
	Active      int             `json:"active"`
	Starred     int             `json:"starred"`
	Archived    int             `json:"archived"`
	ByAgentType map[string]int  `json:"by_agent_type"`
	Tags        []ChatFolderTag `json:"tags"`
}

// CountChatFolders aggregates all folders in one query of the history database. Each count is its list's total: All, Notes,
// Active now and Archived are agent chats (Archived counts the archived ones, the others the visible ones); Group chats is
// every board, an archived board included; Starred is the visible chats of both kinds.
// The board ids come from the board database's existing project listing; json_each
// folds them into the same aggregate without an IN limit or a request per folder.
func (s *SessionStore) CountChatFolders(ctx context.Context, boards []string) (*ChatFolderCounts, error) {
	raw, err := json.Marshal(boards)
	if err != nil {
		return nil, err
	}
	query := `WITH chats AS MATERIALIZED (
 SELECT si.session_id AS id, si.source_type AS cli, 0 AS is_group,
 COALESCE(cf.starred,0) AS starred, ` + archivedChatSQL("si.session_id") + ` AS archived, ` + activeChatSQL("si.session_id", "si.source_type") + ` AS active, ` + notesChatSQL("si.session_id") + ` AS notes
 FROM session_index si LEFT JOIN chat_flags cf ON cf.session_id=si.session_id
 UNION ALL
 SELECT 'board:'||b.value,'board',1,COALESCE(cf.starred,0),COALESCE(cf.archived,0),
 EXISTS(SELECT 1 FROM live_sessions ls WHERE ls.board_name=b.value AND ls.status='active' AND ls.is_sleeping=0 AND ls.is_archived=0 AND ls.pid>0),0
 FROM json_each(?) b LEFT JOIN chat_flags cf ON cf.session_id='board:'||b.value
 ), visible AS (SELECT * FROM chats WHERE archived=0)
 SELECT 'folder' AS kind,'all' AS name,'' AS color,0 AS id,COUNT(*) AS n FROM visible WHERE is_group=0
 UNION ALL SELECT 'folder','group','',0,COUNT(*) FROM chats WHERE is_group=1
 UNION ALL SELECT 'folder','notes','',0,COUNT(*) FROM visible WHERE notes=1 AND is_group=0
 UNION ALL SELECT 'folder','active','',0,COUNT(*) FROM visible WHERE active=1 AND is_group=0
 UNION ALL SELECT 'folder','starred','',0,COUNT(*) FROM visible WHERE starred=1
 UNION ALL SELECT 'folder','archived','',0,COUNT(*) FROM chats WHERE archived=1 AND is_group=0
 UNION ALL SELECT 'cli',cli,'',0,COUNT(*) FROM visible WHERE is_group=0 GROUP BY cli
 UNION ALL SELECT 'tag',t.name,t.color,t.id,COUNT(v.id) FROM tags t LEFT JOIN session_tags st ON st.tag_id=t.id LEFT JOIN visible v ON v.id=st.session_id AND v.is_group=0 GROUP BY t.id,t.name,t.color`
	var rows []struct {
		Kind  string `db:"kind"`
		Name  string `db:"name"`
		Color string `db:"color"`
		ID    int64  `db:"id"`
		N     int    `db:"n"`
	}
	if err = s.reader().SelectContext(ctx, &rows, query, string(raw)); err != nil {
		return nil, err
	}
	out := &ChatFolderCounts{ByAgentType: map[string]int{}, Tags: []ChatFolderTag{}}
	folders := map[string]*int{"all": &out.All, "group": &out.Group, "notes": &out.Notes, "active": &out.Active, "starred": &out.Starred, "archived": &out.Archived}
	for _, r := range rows {
		switch r.Kind {
		case "folder":
			*folders[r.Name] = r.N
		case "cli":
			out.ByAgentType[r.Name] = r.N
		case "tag":
			out.Tags = append(out.Tags, ChatFolderTag{r.ID, r.Name, r.Color, r.N})
		}
	}
	// These CLIs share one history source and the existing list expands either filter.
	shared := out.ByAgentType["gemini"] + out.ByAgentType["agy"] + out.ByAgentType["antigravity"]
	if shared > 0 {
		for _, cli := range []string{"gemini", "agy", "antigravity"} {
			out.ByAgentType[cli] = shared
		}
	}
	return out, nil
}
