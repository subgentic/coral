// Posting, reading, listing and deleting messages (moved out of board.go, #4998; no behaviour change).

package routes

import (
	"encoding/json"
	"fmt"
	"github.com/subgentic/coral/internal/claudeartifact"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/subgentic/coral/internal/board"
	"github.com/subgentic/coral/internal/clitext"
	"github.com/subgentic/coral/internal/cloud"
	"github.com/subgentic/coral/pkg/tunnel"
)

// unescapeLineBreaks turns literal "\n" sequences into line breaks in a
// message that has none. Agents posting through a shell often pass a
// single-quoted string with \n escapes, which arrives as one long line with
// the escapes shown verbatim. Two or more are required so a one-line message
// that mentions "\n" (e.g. strings.Split(s, "\n")) is left alone.
func unescapeLineBreaks(content string) string {
	if strings.ContainsAny(content, "\r\n") || strings.Count(content, `\n`) < 2 {
		return content
	}
	return strings.NewReplacer(`\r\n`, "\n", `\n`, "\n", `\t`, "\t").Replace(content)
}

// MarkRead moves a subscriber's read position forward to through_id after
// they looked at the newest messages (coral-board read --last N), so the
// unread count and nudges no longer include what they saw. from_id is the
// oldest message shown; the response counts unread messages before it that
// were skipped.
// POST /api/board/{project}/messages/mark-read {subscriber_id, through_id, from_id}
func (h *BoardHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	var body struct {
		SubscriberID string `json:"subscriber_id"`
		ThroughID    int64  `json:"through_id"`
		FromID       int64  `json:"from_id"`
	}
	derr := decodeJSON(r, &body)
	if derr == nil {
		attrWho, attrOK := attributedTo(w, r, body.SubscriberID)
		if !attrOK {
			return
		}
		body.SubscriberID = attrWho
	}
	if derr != nil || body.SubscriberID == "" || body.ThroughID <= 0 {
		errBadRequest(w, "subscriber_id and through_id are required")
		return
	}
	if body.FromID <= 0 || body.FromID > body.ThroughID {
		body.FromID = body.ThroughID
	}
	skipped, first, last, err := h.bs.MarkReadThrough(r.Context(), project, body.SubscriberID, body.ThroughID, body.FromID)
	if err != nil {
		errBadRequest(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"skipped": skipped, "first_skipped_id": first, "last_skipped_id": last})
}

// PostMessage posts a message to a board.
// POST /api/board/{project}/messages
func (h *BoardHandler) PostMessage(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	var body postMessageBody
	derr := decodeJSON(r, &body)
	var answer *taskReply
	if derr == nil && len(body.TaskID) > 0 && string(body.TaskID) != "null" {
		id, perr := strconv.ParseInt(strings.TrimSpace(string(body.TaskID)), 10, 64)
		if perr != nil || id <= 0 {
			errBadRequest(w, "invalid task_id")
			return
		}
		task, err := h.bs.GetTask(r.Context(), project, id) // the task is looked up by the URL's board first: a task of another board is a 404 before anything is written
		if err != nil || task == nil {
			errNotFound(w, "Task not found")
			return
		}
		answer = &taskReply{taskID: task.ID} // no creator: no mention is added, and the post is stored with its task_id
	}
	// An ask (post --ask, #7794) needs someone to ask, and a reply_to a message of this board: both are checked before anything is posted.
	var asked []string
	if derr == nil && body.Ask {
		to, err := h.bs.AskTargets(r.Context(), project, body.SubscriberID, clitext.Clean(unescapeLineBreaks(body.Content)))
		if err != nil {
			errBadRequest(w, err.Error())
			return
		}
		asked = to
	}
	if derr == nil && body.ReplyTo != 0 {
		if body.ReplyTo < 0 || h.bs.CheckReplyTo(r.Context(), project, body.ReplyTo) != nil {
			errBadRequest(w, "reply_to is not a message of this board")
			return
		}
	}
	msg, ok := h.postMessageCore(w, r, project, derr, body, answer)
	if !ok {
		return
	}
	if len(asked) > 0 {
		// The sender is known now (the request proved it): who is asked is decided again from what was stored, so the asker is never among them.
		if to, err := h.bs.AskTargets(r.Context(), project, msg.SubscriberID, msg.Content); err == nil {
			if err := h.bs.RecordAsk(r.Context(), project, msg, to); err != nil {
				slog.Warn("board ask not recorded", "board", project, "message", msg.ID, "error", err)
			}
		}
	}
	if body.ReplyTo > 0 {
		if err := h.bs.RecordReply(r.Context(), project, msg.ID, body.ReplyTo); err != nil {
			slog.Warn("board reply not recorded", "board", project, "message", msg.ID, "error", err)
		}
	}
	if len(asked) > 0 || body.ReplyTo > 0 {
		if filled, err := h.bs.GetMessageByID(r.Context(), project, msg.ID); err == nil {
			msg = filled // the answer carries ask and reply_to
		}
	}
	writeJSON(w, http.StatusOK, msg)
}

// postMessageBody is the body of a board post.
type postMessageBody struct {
	SubscriberID  string  `json:"subscriber_id"`
	Content       string  `json:"content"`
	TargetGroupID *string `json:"target_group_id,omitempty"`
	As            string  `json:"as,omitempty"` // display name for auto-subscribe (e.g. "Operator")
	// TaskID makes the post an answer on that task (#7703): the agent's reply to a person's reply, listed with it by GET .../messages?task_id=N. The task must be on this board;
	// no mention is added (the person reads the task's page), the sender is the one the request proves, exactly as for any post.
	// Ask makes the post a question to the members it @mentions (#7794), open until each has answered; ReplyTo makes it an answer to that message of the board.
	Ask bool `json:"ask,omitempty"`
	// DryRun checks the post (size, mentions) and answers {"ok": true, "dry_run": true} without storing anything: "post --assign" asks before it creates the task, so a refused post leaves nothing behind (#9047).
	DryRun  bool            `json:"dry_run,omitempty"`
	ReplyTo int64           `json:"reply_to,omitempty"`
	TaskID  json.RawMessage `json:"task_id,omitempty"` // raw, so a task_id that is not a whole number is answered as that (invalid task_id), not as a body that failed to decode ("content required")
}

// taskReply makes a post a reply to a task (#5463): the task's id and creator in, and what the server did with the creator's mention out.
type taskReply struct {
	taskID  int64
	creator string
	// Out: the mention the reply started with ("" when the creator could not be tagged exactly) and who it notifies.
	prefix   string
	notified []string
}

// postMessageCore is the one place a board message is posted: the post route and the reply-to-task route both end here, with the same caps, cleaning, board-name rule,
// hub-user and Operator rules, stamping, waits and notification. reply is nil for a plain post. It writes the error answer itself and returns ok=false; on success the
// caller writes the reply. A mention that names no member is refused before anything is stored (#9047).
func (h *BoardHandler) postMessageCore(w http.ResponseWriter, r *http.Request, project string, derr error, body postMessageBody, reply *taskReply) (*board.Message, bool) {
	if derr == nil && !cloud.Tunneled(r) {
		attrWho, attrOK := attributedTo(w, r, body.SubscriberID)
		if !attrOK {
			return nil, false
		}
		body.SubscriberID = attrWho
		// A reply names no sender in its body (#5463): the sender is whoever the request proves it is. In log mode attributedTo returns the claim, which a reply does not have, so
		// the verified actor's own name stands in (the dashboard's Operator, an agent's token member), in either identity mode; never a name the body gives (#5779).
		if reply != nil && body.SubscriberID == "" {
			if name, verified := actorName(callerActor(r)); verified {
				body.SubscriberID = name
			}
		}
	}
	if derr != nil || body.Content == "" {
		errBadRequest(w, "content required")
		return nil, false
	}
	// A post is a message, not a document: reports and logs go to artifacts. The 4 MiB body cap alone let one post be 4 MiB in the
	// database and in every agent's terminal (#4602).
	if len(body.Content) > maxBoardPostContent {
		msg := fmt.Sprintf("a board post is at most %d KiB (this one is %d KiB): put the long text in an artifact (coral-agent artifact upload) and post its link", maxBoardPostContent>>10, len(body.Content)>>10)
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]any{
			"error":     msg,
			"message":   msg, // coral-board prints "message" before the code (serverError): the way to fix it, not just "content_too_large"
			"code":      "content_too_large",
			"max_bytes": maxBoardPostContent,
			"not_sent":  true,
		})
		return nil, false
	}
	if refuseIfDiskLow(w) {
		return nil, false
	}
	if reply != nil {
		// A reply needs text of its own: the creator's mention is not text, so the emptiness a post is refused for is checked before it is added.
		if strings.TrimSpace(clitext.Clean(unescapeLineBreaks(body.Content))) == "" {
			errBadRequest(w, "content required")
			return nil, false
		}
		// The mention of the task's creator goes first, before the text is cleaned and before a hub operator's own prefix is added, so both survive (#5463).
		m := h.bs.TaskReplyMention(r.Context(), project, reply.creator)
		reply.prefix, reply.notified = m.Prefix, m.Notified
		body.Content = m.Prefix + body.Content
	}
	body.Content = unescapeLineBreaks(body.Content)
	// Terminal control goes before anything reads the text (#3580): mentions, links and the
	// stored post all see what readers will see.
	if body.Content = clitext.Clean(body.Content); strings.TrimSpace(body.Content) == "" {
		errBadRequest(w, "content required")
		return nil, false
	}
	if h.refuseShortArtifactRefs(w, r, &body.Content) { // a shortened coral://artifacts link is made whole, or the post is refused (#9841)
		return nil, false
	}
	if refuseNewBoardName(w, r, h.bs, project) {
		return nil, false
	}
	if problems := h.bs.UnknownMentions(r.Context(), project, body.Content); len(problems) > 0 {
		msg := "not posted: " + strings.Join(problems, "; ") + ". Mention a member of this board (coral-board targets lists them), or take the @ out of the text"
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":    msg,
			"message":  msg,
			"code":     "unknown_mention",
			"mentions": problems,
			"not_sent": true,
		})
		return nil, false
	}
	if body.DryRun {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dry_run": true})
		return nil, false
	}

	subscriberID := body.SubscriberID
	if subscriberID == "" && !cloud.Tunneled(r) {
		// A post names its sender (#3743: the session_id fallback is gone, and a post with
		// neither went out with an empty sender). Through Coral Hub the Hub user is the sender.
		if reply != nil {
			errBadRequest(w, "a reply needs a verified sender (an agent's token, the dashboard or Coral Hub)")
		} else {
			errBadRequest(w, "subscriber_id required")
		}
		return nil, false
	}

	// Through Coral Hub, a chat post's sender is the Coral Hub user named by the
	// connector-forwarded X-Coral-Hub-User header, never a name from the body (#3377).
	// It's marked with a server-set origin for the dashboard's badge. A post that asks
	// to be the Operator is sent as the Operator unless the owner turned on "Don't let
	// Coral Hub act as the Operator" (#3404): origin hub_operator, attributed to the Hub user, and its
	// text says so, so an agent can tell it from the local Operator. Without the header
	// it is never the Operator.
	origin, hubUser, hubOperator := "", "", false
	if cloud.Tunneled(r) {
		user, hubOrigin, status, msg := h.tunnelChatSender(r, project)
		if status != 0 {
			writeJSON(w, status, map[string]any{"error": msg, "code": "hub_user_required"})
			return nil, false
		}
		asksOperator := strings.EqualFold(strings.TrimSpace(subscriberID), operatorIdentity) || strings.EqualFold(strings.TrimSpace(body.As), operatorIdentity)
		if hubOrigin == board.OriginHubUser && asksOperator && h.hubOperatorAllowed != nil && h.hubOperatorAllowed(r) {
			subscriberID, origin, hubUser, hubOperator = operatorIdentity, board.OriginHubOperator, user, true
			body.Content = HubOperatorPrefix(user) + body.Content
		} else {
			subscriberID, origin = user, hubOrigin
			if hubOrigin == board.OriginHubUser {
				hubUser = user
			}
		}
		// Neither a Coral Hub user nor the Operator is subscribed by a post through the
		// tunnel: the Operator's own subscription is the local dashboard's.
		body.As = ""
	}

	// Auto-subscribe the poster if 'as' is provided and they aren't subscribed yet
	if body.As != "" && subscriberID != "" {
		sub, _ := h.bs.GetProjectSubscription(r.Context(), project, subscriberID)
		if sub == nil {
			// Through Coral Hub the auto-subscribe gets the default mode (mentions), not
			// every message (#3377).
			mode := "all"
			if cloud.Tunneled(r) {
				mode = ""
			}
			h.bs.Subscribe(r.Context(), project, subscriberID, body.As, "", nil, mode)
		}
	}

	// An agent's own post (its verified token, already bound to subscriber_id by the
	// identity middleware) may link fresh local images and Markdown: they are stored as
	// artifacts and the links point at them (#3515). Never through the tunnel.
	if owner, ok := VerifiedSession(r.Context()); ok && owner != nil && !cloud.Tunneled(r) && h.autoAttach != nil {
		body.Content = h.autoAttach.Rewrite(r.Context(), project, owner.SessionID, owner.SessionName, body.Content)
	}

	var msg *board.Message
	var err error
	var taskID *int64
	if reply != nil {
		taskID = &reply.taskID
	}
	if hubUser != "" {
		msg, err = h.bs.PostHubMessageForTask(r.Context(), project, hubUser, body.Content, body.TargetGroupID, hubOperator, taskID)
	} else {
		msg, err = h.bs.PostMessageForTask(r.Context(), project, subscriberID, body.Content, body.TargetGroupID, origin, taskID)
	}
	if err != nil {
		errInternalServer(w, err.Error())
		return nil, false
	}
	if cloud.Tunneled(r) {
		// Every board write through the tunnel is recorded, not only the Operator's (#3428).
		recordHubOperatorAction(r.Context(), h.bs, hubUser, r.Method, r.URL.Path, project, http.StatusOK)
	}
	// A message from an assignee is evidence of progress on its active task.
	// Keep this separate from task state so posting never completes work.
	_ = h.bs.TouchActiveTask(r.Context(), project, subscriberID)
	// An agent that posts is not parked on a wait (#7765): the awaited event is no longer what it is waiting for. Only a member agent's own post (its token), never the Operator's or the Hub's.
	if _, member := callerActor(r).Member(); member && !cloud.Tunneled(r) {
		h.endOwnWaits(r.Context(), project, subscriberID)
	}

	// A claude.ai artifact link in an agent's own post reminds that agent once; in anyone else's it is only recorded as seen (#6583).
	if h.artifactNudge != nil && !cloud.Tunneled(r) {
		if ids := claudeartifact.LinkIDs(body.Content); len(ids) > 0 {
			owner, _ := VerifiedSession(r.Context())
			h.artifactNudge.FromLinks(r.Context(), owner, ids)
		}
	}

	// Trigger immediate board notification so subscribers get nudged right away
	if h.notifyFn != nil {
		h.notifyFn(project)
	}

	// Resolve any active registered waits for this message
	h.goBG(func() { h.resolveMessageWaits(project, subscriberID, body.Content) })

	return msg, true
}

// hubUserRe is the X-Coral-Hub-User value coral-hub sends (#3377).
var hubUserRe = regexp.MustCompile(`^hub-user-[0-9a-f]{8}$`)

// tunnelChatSender returns the Coral Hub user for a tunnel chat post, or an HTTP
// status and message: 400 when the header is malformed or repeated (never a fallback
// to the Operator), 409 when the name is already a member or a role on this board. A post with
// no header is 400 too (#3743: the release that accepted one as "Coral Hub" for older hubs is
// past).
func (h *BoardHandler) tunnelChatSender(r *http.Request, project string) (user, origin string, status int, msg string) {
	user, present, status, msg := tunnelHubUser(r, h.bs, project)
	if !present {
		return "", "", http.StatusBadRequest, "A board write through Coral Hub needs exactly one Coral Hub user (" + tunnel.HubUserHeader + ": hub-user-<8 hex>)"
	}
	if status != 0 {
		return "", "", status, msg
	}
	return user, board.OriginHubUser, 0, ""
}

// tunnelHubUser reads the Coral Hub user of a tunnel board write from the header the
// connector forwards (#3377, #3404). present is false when there is no header. Otherwise
// status is 400 when the header is malformed or repeated, 409 when the name is already a
// member or a role on this board, and 0 for a valid user.
func tunnelHubUser(r *http.Request, bs *board.Store, project string) (user string, present bool, status int, msg string) {
	values, present := r.Header[http.CanonicalHeaderKey(tunnel.HubUserHeader)]
	if !present {
		return "", false, 0, ""
	}
	if len(values) == 1 {
		user = values[0]
	}
	if len(user) > 32 || !hubUserRe.MatchString(user) {
		return "", true, http.StatusBadRequest, "A board write through Coral Hub needs exactly one Coral Hub user (" + tunnel.HubUserHeader + ": hub-user-<8 hex>)"
	}
	subs, err := bs.ListSubscribers(r.Context(), project)
	if err != nil {
		return "", true, http.StatusInternalServerError, "could not read the board's members"
	}
	for _, s := range subs {
		if s.SubscriberID == user && s.JobTitle == hubSubscriberTitle {
			continue // the Hub user's own subscription, made through Coral Hub (#3942)
		}
		if strings.EqualFold(s.SubscriberID, user) || strings.EqualFold(strings.TrimSpace(s.JobTitle), user) {
			return "", true, http.StatusConflict, "That Coral Hub user's name is already a member or role on this board"
		}
	}
	return user, true, 0, ""
}

// ReadMessages reads new messages (cursor-based).
// GET /api/board/{project}/messages
func (h *BoardHandler) ReadMessages(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	h.setBoardIdentity(w, r, project)
	if h.isPaused(project) {
		writeJSON(w, http.StatusOK, []board.Message{})
		return
	}
	if cloud.Tunneled(r) {
		// A read through Coral Hub never moves a member's read position (#3428): whoever
		// the request names, it is served as the board's latest messages, with no cursor
		// (only the limit is read, so the tunnel's allowlist of query parameters is unchanged).
		tunnelLimit := clampLimit(queryInt(r, "limit", 50), 50, 500)
		messages, err := h.bs.ListMessages(r.Context(), project, tunnelLimit, 0, 0)
		if err != nil {
			errInternalServer(w, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, emptyIfNil(messages))
		return
	}
	subscriberID, attrOK := attributedTo(w, r, r.URL.Query().Get("subscriber_id"))
	if !attrOK {
		return
	}
	limit := clampLimit(queryInt(r, "limit", 50), 50, 500)
	allParam := r.URL.Query().Get("all")
	readAll := allParam == "true" || allParam == "1"
	messages, err := h.bs.ReadMessages(r.Context(), project, subscriberID, limit, readAll)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, emptyIfNil(messages))
}

// ListAllMessages returns all messages (no cursor advancement).
// GET /api/board/{project}/messages/all
// Pass ?id=N to fetch a single message by ID (does not advance cursor).
func (h *BoardHandler) ListAllMessages(w http.ResponseWriter, r *http.Request) {
	h.setBoardIdentity(w, r, urlParam(r, "project"))
	// Single message lookup by ID
	if idStr := r.URL.Query().Get("id"); idStr != "" {
		msgID, err := parseID(idStr) // canonical decimal only (#7261); 0 is a canonical id that is not there: 404 below, as before
		if err != nil {
			errBadRequest(w, "invalid message id")
			return
		}
		// Only this board's message: another board's id is "not found" like a missing one.
		msg, err := h.bs.GetMessageByID(r.Context(), urlParam(r, "project"), msgID)
		if err != nil {
			errNotFound(w, "message not found")
			return
		}
		writeJSON(w, http.StatusOK, []board.Message{*msg})
		return
	}

	project := urlParam(r, "project")
	limit := clampLimit(queryInt(r, "limit", 200), 200, 500)
	// ?task_id=N: the replies to that task (#5463), oldest first, always inside the board of the URL.
	// A task_id the query parser dropped (a semicolon) is refused too, never read as "no filter".
	if r.URL.Query().Has("task_id") || strings.Contains(r.URL.RawQuery, "task_id") {
		taskID, err := parseID(r.URL.Query().Get("task_id"))
		if err != nil || taskID <= 0 {
			errBadRequest(w, "invalid task_id")
			return
		}
		replies, err := h.bs.ListTaskReplies(r.Context(), project, taskID, limit)
		if err != nil {
			errInternalServer(w, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, emptyIfNil(replies))
		return
	}
	// ?for_subscriber=NAME: the messages that member's read would deliver (#8484), taken from the whole board and paged as below (the dock's Board tab of an agent). One rule, the store's selectRead.
	if r.URL.Query().Has("for_subscriber") {
		h.listMessagesFor(w, r, project, limit)
		return
	}
	offset := clampOffset(queryInt(r, "offset", 0))
	beforeID := int64(queryInt(r, "before_id", 0))
	format := r.URL.Query().Get("format")
	// Keyset paging: before_id returns the page just before that message and
	// after_id what arrived after it. Both seek the (project, id) index, while
	// OFFSET (kept for older clients and remotes) steps over every skipped
	// row. after_id=0 is meaningful (from the start), so its presence counts.
	query := r.URL.Query()
	keyset := offset == 0 && (beforeID > 0 || query.Has("after_id"))
	var messages []board.Message
	var err error
	switch {
	case keyset && query.Has("after_id"):
		messages, err = h.bs.ListMessagesAfter(r.Context(), project, int64(queryInt(r, "after_id", 0)), limit)
	case keyset:
		messages, err = h.bs.ListMessagesBefore(r.Context(), project, beforeID, limit)
	default:
		messages, err = h.bs.ListMessages(r.Context(), project, limit, offset, beforeID)
	}
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if format == "dashboard" {
		total, _ := h.bs.CountMessages(r.Context(), project)
		resp := map[string]any{
			"messages": messages,
			"total":    total,
			"limit":    limit,
			"offset":   offset,
		}
		// For keyset requests and the latest page, say how many older
		// messages remain so the dashboard can page by id. Older servers
		// omit "paging"; the dashboard then keeps using offsets.
		if keyset || (offset == 0 && beforeID == 0) {
			resp["paging"] = "keyset"
			// Older than the first returned message, or than the requested
			// boundary when the page is empty.
			var anchor int64
			switch {
			case len(messages) > 0:
				anchor = messages[0].ID
			case query.Has("after_id"):
				anchor = int64(queryInt(r, "after_id", 0)) + 1
			default:
				anchor = beforeID
			}
			before := 0
			if anchor > 0 {
				before, _ = h.bs.CountMessagesBefore(r.Context(), project, anchor)
			}
			resp["before_count"] = before
		}
		// A page of what arrived after a message the dashboard holds: the older questions these posts may have answered come with their
		// state now (ask_updates), so the dashboard replaces their ask and never works out "answered" itself (#8200).
		if query.Has("after_id") && len(messages) > 0 {
			updates, uerr := h.bs.AskUpdates(r.Context(), project, int64(queryInt(r, "after_id", 0)), messages)
			if uerr != nil {
				slog.Warn("could not read the answers to the board's questions", "board", project, "error", uerr)
			} else if len(updates) > 0 {
				resp["ask_updates"] = updates
			}
		}
		writeJSON(w, http.StatusOK, resp)
	} else {
		// Default: bare array for CLI consumers
		writeJSON(w, http.StatusOK, emptyIfNil(messages))
	}
}

// listMessagesFor answers ListAllMessages for ?for_subscriber=: the same replies as the board's own list (a bare array, or the dashboard's page with its counts), holding only what that
// subscriber's read would deliver.
func (h *BoardHandler) listMessagesFor(w http.ResponseWriter, r *http.Request, project string, limit int) {
	query := r.URL.Query()
	who := strings.TrimSpace(query.Get("for_subscriber"))
	if who == "" || len(who) > 200 {
		errBadRequest(w, "invalid for_subscriber")
		return
	}
	page := board.ForPage{Limit: limit, BeforeID: int64(queryInt(r, "before_id", 0)), HasAfter: query.Has("after_id")}
	if page.HasAfter {
		page.AfterID = int64(queryInt(r, "after_id", 0))
	}
	messages, page, err := h.bs.ListMessagesFor(r.Context(), project, who, page)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if query.Get("format") != "dashboard" {
		writeJSON(w, http.StatusOK, emptyIfNil(messages))
		return
	}
	boardTotal, _ := h.bs.CountMessages(r.Context(), project) // "12 of 184 messages": the whole board's count beside this reader's
	resp := map[string]any{"messages": emptyIfNil(messages), "total": page.Scanned, "board_total": boardTotal, "limit": limit, "offset": 0, "paging": "keyset", "before_count": page.Remaining}
	if page.HasAfter && len(messages) > 0 {
		if updates, uerr := h.bs.AskUpdates(r.Context(), project, page.AfterID, messages); uerr != nil {
			slog.Warn("could not read the answers to the board's questions", "board", project, "error", uerr)
		} else if len(updates) > 0 {
			resp["ask_updates"] = updates
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// CheckUnread returns the unread message count.
// GET /api/board/{project}/messages/check
func (h *BoardHandler) CheckUnread(w http.ResponseWriter, r *http.Request) {
	project := urlParam(r, "project")
	if h.isPaused(project) {
		writeJSON(w, http.StatusOK, map[string]any{"unread": 0})
		return
	}
	subscriberID, attrOK := attributedTo(w, r, r.URL.Query().Get("subscriber_id"))
	if !attrOK {
		return
	}
	count, err := h.bs.CheckUnread(r.Context(), project, subscriberID)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"unread": count})
}

// DeleteMessage deletes a single message.
// DELETE /api/board/{project}/messages/{messageID}
func (h *BoardHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	msgID, perr := parseID(chi.URLParam(r, "messageID"))
	if perr != nil {
		errBadRequest(w, "invalid message id")
		return
	}
	found, err := h.bs.DeleteMessage(r.Context(), urlParam(r, "project"), msgID)
	if err != nil {
		errInternalServer(w, err.Error())
		return
	}
	if !found {
		errNotFound(w, "message not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
