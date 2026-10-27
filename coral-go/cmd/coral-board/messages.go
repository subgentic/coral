package main

import (
	"encoding/json"
	"fmt"
	"github.com/subgentic/coral/internal/clierr"
	"github.com/subgentic/coral/internal/clitext"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
)

func cmdJoin() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "Usage: coral-board join <project> --as <role>")
		clierr.Exit1()
	}
	project := os.Args[2]
	jobTitle := "Agent"
	for i, arg := range os.Args {
		if arg == "--as" && i+1 < len(os.Args) {
			jobTitle = os.Args[i+1]
		}
	}

	subscriberID := resolveSubscriberID()
	sessionName := resolveSessionName()
	if sessionName == "" {
		fmt.Fprintln(os.Stderr, "coral-board: not in a Coral agent session (CORAL_SESSION_NAME is not set and Coral doesn't know this process), so there is nothing to join the board with")
		clierr.Exit1()
	}
	result, status, err := apiCall("POST", "/"+url.PathEscape(project)+"/subscribe", map[string]string{
		"subscriber_id": subscriberID,
		"session_name":  sessionName,
		"job_title":     jobTitle,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	// Any non-2xx exits non-zero and names the status (a 401 from a key-protected Coral, a 500),
	// never a silent success; a refusal that has extra guidance (an ambiguous board name, a
	// client error) prints that too (#3589).
	if e := serverError(status, result); e != nil {
		fmt.Fprintln(os.Stderr, e)
		if msg := joinProblem(project, result); msg != "" {
			fmt.Fprint(os.Stderr, msg)
		}
		clierr.Exit1()
	}
	// The server answers with the board's id (#3536): a name that is a board's label joins
	// that board, and the state file keeps its id, so a later rename or another board taking
	// the same name never moves this agent.
	boardID := project
	if id, _ := result["project"].(string); id != "" {
		boardID = id
	}
	goals, goalsSeq := openGoalsAndSeq(boardID, 9)
	saveState(&boardState{Project: boardID, JobTitle: jobTitle, ServerURL: serverURL, GoalsSeq: goalsSeq})
	if boardID != project {
		fmt.Printf("Joined '%s' (board %s) as '%s' (subscriber: %s)\n", project, boardID, jobTitle, subscriberID)
	} else {
		fmt.Printf("Joined '%s' as '%s' (subscriber: %s)\n", project, jobTitle, subscriberID)
	}
	printGoalBriefing(goals)
}

// joinProblem is what join prints when the server refused it ("" when it didn't): a name
// several boards share lists them by id (#3536), and a new name that breaks the naming
// rule says why (#3534).
// joinProblem is the extra guidance join prints for a refusal that has it (an ambiguous board
// name, or a client error with a message); "" when the result carries no error code. It is shown
// in addition to the status line (#3589).
func joinProblem(project string, result map[string]any) string {
	code, _ := result["error"].(string)
	if code == "" {
		return ""
	}
	var b strings.Builder
	switch code {
	case "ambiguous_board":
		fmt.Fprintf(&b, "More than one board is named '%s'. Join one by its id:\n", project)
		cands, _ := result["candidates"].([]any)
		for _, c := range cands {
			m, _ := c.(map[string]any)
			members, _ := m["members"].(float64)
			fmt.Fprintf(&b, "  coral-board join %v   (%v, created %v, %d members)\n", m["board_id"], m["board_label"], m["created_at"], int(members))
		}
	default:
		msg, _ := result["message"].(string)
		if msg == "" {
			msg = code
		}
		fmt.Fprintf(&b, "Error: %s\n", msg)
	}
	return b.String()
}

func cmdPost() {
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board. Run: coral-board join <project> --as <role>")
		clierr.Exit1()
	}
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, commandUsage("post", nil))
		clierr.Exit1()
	}

	// Parse --to flag and collect remaining args as the message
	var toNames, filePath, taskArg, assignArg, goalArg, titleArg, priorityArg, replyArg string
	ask := false
	var msgParts []string
	literal := false
	for i := 2; i < len(os.Args); i++ {
		if os.Args[i] == "--" { // everything after is message text
			msgParts = append(msgParts, os.Args[i+1:]...)
			literal = true
			break
		}
		opt := foldOpt(os.Args[i], postFlags) // --TO is --to
		if opt == "--to" && i+1 < len(os.Args) {
			toNames = os.Args[i+1]
			i++ // skip the value
		} else if opt == "--file" && i+1 < len(os.Args) {
			filePath = os.Args[i+1]
			i++
		} else if opt == "--task" && i+1 < len(os.Args) {
			taskArg = os.Args[i+1]
			i++
		} else if opt == "--ask" {
			ask = true
		} else if opt == "--reply-to" && i+1 < len(os.Args) {
			replyArg = os.Args[i+1]
			i++
		} else if (opt == "--assign" || opt == "--goal" || opt == "--title" || opt == "--priority") && i+1 < len(os.Args) {
			switch opt {
			case "--assign":
				assignArg = os.Args[i+1]
			case "--goal":
				goalArg = os.Args[i+1]
			case "--title":
				titleArg = os.Args[i+1]
			case "--priority":
				priorityArg = os.Args[i+1]
			}
			i++
		} else if isPostValueOption(opt) {
			fmt.Fprintf(os.Stderr, "Error: %s needs a value\n", os.Args[i])
			os.Exit(2)
		} else {
			msgParts = append(msgParts, os.Args[i])
		}
	}
	var message string
	if filePath != "" {
		if len(msgParts) > 0 {
			fmt.Fprintln(os.Stderr, "Error: --file can't be combined with message text")
			os.Exit(2)
		}
		text, err := readFileText(filePath, "message")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(2)
		}
		message = text
	} else if !literal && len(msgParts) == 1 && msgParts[0] == "-" {
		message = stdinTextOrExit("message")
	} else {
		message = strings.Join(msgParts, " ")
		if err := checkShellSyntax(os.Stderr, "post", message); err != nil {
			fmt.Fprintln(os.Stderr, err)
			clierr.Exit1()
		}
	}

	if assignArg == "" && (goalArg != "" || titleArg != "" || priorityArg != "") {
		fmt.Fprintln(os.Stderr, "Error: --goal, --title and --priority are for --assign: post --assign \"Name\" [--goal N] [--title T] [--priority P] \"text\"")
		os.Exit(2)
	}
	if ask && assignArg != "" {
		fmt.Fprintln(os.Stderr, "Error: --ask is a question (no work to produce); --assign makes work a task: use one of them")
		os.Exit(2)
	}
	var assigned *postAssignment
	if assignArg != "" {
		if taskArg != "" {
			fmt.Fprintln(os.Stderr, "Error: --assign makes a task of the post; it can't also be an answer on one (--task)")
			os.Exit(2)
		}
		assigned = prepareAssignment(st, message, assignArg, toNames, goalArg, titleArg, priorityArg) // refuses, creating nothing
		message = assigned.message
	}

	// Prepend @mentions if --to was provided
	if toNames != "" {
		var mentions []string
		for _, name := range strings.Split(toNames, ",") {
			name = strings.TrimSpace(name)
			if name != "" {
				mentions = append(mentions, "@"+name)
			}
		}
		if len(mentions) > 0 {
			message = strings.Join(mentions, " ") + " " + message
		}
	}

	subscriberID := resolveSubscriberID()

	body := map[string]any{"subscriber_id": subscriberID, "content": message}
	if ask {
		body["ask"] = true // a question to the members it @mentions, open until each has answered (#7794)
	}
	if replyArg != "" { // --reply-to N: an answer to message N, which closes a question asked of the sender
		n, convErr := strconv.ParseInt(replyArg, 10, 64)
		if convErr != nil || n <= 0 {
			fmt.Fprintf(os.Stderr, "Error: --reply-to needs a message number (got %q)\n", replyArg)
			os.Exit(2)
		}
		body["reply_to"] = n
	}
	if assigned != nil { // --assign: the task is made now, and the post carries its link (#7791)
		n := assigned.create(st, subscriberID)
		body["task_id"] = n
		body["content"] = strings.TrimSpace(message) + fmt.Sprintf("\n\n-> Task #%d, assigned to %s.", n, assignArg)
	} else if taskArg != "" { // --task N: an answer on task N, listed with the person's replies on its page (#7703)
		n, convErr := strconv.ParseInt(taskArg, 10, 64)
		if convErr != nil || n <= 0 {
			fmt.Fprintf(os.Stderr, "Error: --task needs a task number (got %q)\n", taskArg)
			os.Exit(2)
		}
		body["task_id"] = n
	}
	result, status, err := apiCall("POST", "/"+url.PathEscape(st.Project)+"/messages", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if e := serverError(status, result); e != nil {
		fmt.Fprintln(os.Stderr, e)
		clierr.Exit1()
	}
	if id, ok := result["id"]; ok {
		fmt.Printf("Message #%.0f posted to '%s'\n", id, st.Project)
		if a, ok := result["ask"].(map[string]any); ok {
			fmt.Printf("  A question to %s: open until each has answered (they answer with  coral-board post --reply-to %.0f \"...\"  or a post that @mentions you).\n", joinAnyStrings(a["to"]), id)
		}
	} else {
		fmt.Fprintln(os.Stderr, "Error: Coral accepted the request but returned no message id")
		clierr.Exit1()
	}
}

// readArgs is a read command line: one message by id, the newest N, or the unread (all of them with --all), as
// text or one JSON object per line.
type readArgs struct {
	messageID       int
	useLast         bool
	lastN           int
	readAll, asJSON bool
}

// parseReadArgs reads read's flags anywhere on the command line: --id N, --last N, --all (-a), --json. A later flag
// overrides an earlier one, and a value that is not a number leaves what it had (0), as fmt.Sscanf does.
func parseReadArgs(args []string) readArgs {
	var r readArgs
	for i := range args {
		if v, ok := optionValue(args, i, "--id"); ok {
			fmt.Sscanf(v, "%d", &r.messageID)
		}
	}
	for i := range args {
		if v, ok := optionValue(args, i, "--last"); ok {
			r.useLast = true
			fmt.Sscanf(v, "%d", &r.lastN)
		}
	}
	for _, arg := range args {
		if arg == "--all" || arg == "-a" {
			r.readAll = true
		}
		if arg == "--json" {
			r.asJSON = true
		}
	}
	return r
}

// optionValue is the value of the option args[i] names (--last N or --last=N), if args[i] is that option.
func optionValue(args []string, i int, name string) (string, bool) {
	if args[i] == name && i+1 < len(args) {
		return args[i+1], true
	}
	if v, ok := strings.CutPrefix(args[i], name+"="); ok {
		return v, true
	}
	return "", false
}

// readPath is the request for r on project: the message by id, the newest N, or the subscriber's unread (50; all of
// them, read or not, with --all).
func readPath(r readArgs, project, subscriberID string) string {
	switch {
	case r.messageID > 0:
		return fmt.Sprintf("/%s/messages/all?id=%d", url.PathEscape(project), r.messageID)
	case r.useLast:
		return fmt.Sprintf("/%s/messages/all?limit=%d", url.PathEscape(project), r.lastN)
	case r.readAll:
		return fmt.Sprintf("/%s/messages?subscriber_id=%s&limit=50&all=true", url.PathEscape(project), url.QueryEscape(subscriberID))
	}
	return fmt.Sprintf("/%s/messages?subscriber_id=%s&limit=50", url.PathEscape(project), url.QueryEscape(subscriberID))
}

func cmdRead() {
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board.")
		clierr.Exit1()
	}
	r := parseReadArgs(os.Args)
	subscriberID := resolveSubscriberID()
	data, err := getBoard(readPath(r, st.Project, subscriberID))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	var messages []map[string]any
	json.Unmarshal(data, &messages)

	if len(messages) == 0 {
		if r.messageID > 0 {
			fmt.Fprintf(os.Stderr, "Message #%d not found.\n", r.messageID)
			clierr.Exit1()
		}
		fmt.Println("No new messages.")
		if !r.asJSON {
			goalsNoticeOnRead(st)
		}
		return
	}
	// --json: one message object per line, exactly as the server returned it (scripts read
	// subscriber_id from it, which the text form doesn't show; #3487).
	if r.asJSON {
		for _, m := range messages {
			line, _ := json.Marshal(m)
			fmt.Println(string(line))
		}
		return
	}
	printMessages(messages)
	if r.useLast && r.messageID == 0 {
		markSkippedRead(st.Project, subscriberID, messages)
	}
	if r.messageID == 0 {
		goalsNoticeOnRead(st)
	}
}

// goalsNoticeOnRead tells an agent about the board's goals when they changed since it last heard: an agent that is already subscribed never runs join, so read is where it hears (#7296). One short block (the
// same lines join prints), once per change of the board's goals counter; nothing when the board has no goals. It is saved in the agent's state so the next read is quiet.
func goalsNoticeOnRead(st *boardState) {
	goals, seq := openGoalsAndSeq(st.Project, 9)
	if seq == st.GoalsSeq || (seq == 0 && len(goals) == 0) {
		return
	}
	printGoalBriefing(goals)
	st.GoalsSeq = seq
	saveState(st)
}

// printMessages prints each message as "[YYYY-MM-DDTHH:MM] role: content" (the poster's title, else its id).
func printMessages(messages []map[string]any) {
	for _, m := range messages {
		ts, _ := m["created_at"].(string)
		if len(ts) > 16 {
			ts = ts[:16]
		}
		role, _ := m["job_title"].(string)
		if role == "" {
			role, _ = m["subscriber_id"].(string)
		}
		content, _ := m["content"].(string)
		fmt.Printf("[%s] %s: %s\n", ts, role, content)
		printAskLines(m)
		if n, ok := m["task_id"].(float64); ok && n > 0 { // a person's reply on a task (#7703): say how the answer reaches the person
			fmt.Printf("  (a reply on task #%.0f: answer it on the task with  coral-board post --task %.0f \"...\")\n", n, n)
		}
	}
}

// markSkippedRead: --last shows the newest messages rather than reading in order; it marks the board read up to them
// so the unread count (and the nudges about it) covers only what arrives next, and says what was passed over.
func markSkippedRead(project, subscriberID string, messages []map[string]any) {
	var fromID, throughID float64
	for _, m := range messages {
		id, _ := m["id"].(float64)
		if fromID == 0 || id < fromID {
			fromID = id
		}
		if id > throughID {
			throughID = id
		}
	}
	result, _, err := apiCall("POST", "/"+url.PathEscape(project)+"/messages/mark-read", map[string]any{
		"subscriber_id": subscriberID,
		"through_id":    int64(throughID),
		"from_id":       int64(fromID),
	})
	if err != nil {
		return
	}
	if n, _ := result["skipped"].(float64); n > 0 {
		first, _ := result["first_skipped_id"].(float64)
		last, _ := result["last_skipped_id"].(float64)
		plural := "s"
		if n == 1 {
			plural = ""
		}
		fmt.Printf("\n(%.0f earlier unread message%s, #%.0f–#%.0f, skipped and marked read. Read one with: coral-board read --id <id>)\n", n, plural, first, last)
	}
}

func cmdPeek() {
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board.")
		clierr.Exit1()
	}

	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "Usage: coral-board peek \"<agent-name>\" [--lines N]")
		clierr.Exit1()
	}

	target := os.Args[2]
	lines := 30
	for i, arg := range os.Args {
		if arg == "--lines" && i+1 < len(os.Args) {
			fmt.Sscanf(os.Args[i+1], "%d", &lines)
		}
	}

	subscriberID := resolveSubscriberID()
	path := fmt.Sprintf("/%s/peek?target=%s&subscriber_id=%s&lines=%d",
		url.PathEscape(st.Project), url.QueryEscape(target), url.QueryEscape(subscriberID), lines)

	resp, err := http.Get(serverURL + "/api/board" + path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	defer resp.Body.Close()

	data, _ := clitext.ReadReply(resp.Body, rawOutput)

	if resp.StatusCode == http.StatusForbidden {
		var errResp map[string]string
		json.Unmarshal(data, &errResp)
		fmt.Fprintf(os.Stderr, "Permission denied: %s\n", errResp["error"])
		clierr.Exit1()
	}
	if resp.StatusCode != http.StatusOK {
		var errResp map[string]string
		json.Unmarshal(data, &errResp)
		fmt.Fprintf(os.Stderr, "Error: %s\n", errResp["error"])
		clierr.Exit1()
	}

	var result map[string]any
	json.Unmarshal(data, &result)
	output, _ := result["output"].(string)
	if output == "" {
		fmt.Println("(no output captured)")
	} else {
		fmt.Print(output)
	}
}

func cmdCheck() {
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board.")
		clierr.Exit1()
	}
	subscriberID := resolveSubscriberID()
	result, status, err := apiCall("GET", fmt.Sprintf("/%s/messages/check?subscriber_id=%s", url.PathEscape(st.Project), url.QueryEscape(subscriberID)), nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if e := serverError(status, result); e != nil {
		fmt.Fprintln(os.Stderr, e)
		clierr.Exit1()
	}
	unread, _ := result["unread"].(float64)

	quiet := false
	for _, arg := range os.Args {
		if arg == "--quiet" {
			quiet = true
		}
	}
	if quiet {
		fmt.Printf("%.0f\n", unread)
	} else {
		fmt.Printf("%.0f unread message(s) on '%s'\n", unread, st.Project)
	}
}

func cmdProjects() {
	data, err := getBoard("/projects")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	var projects []map[string]any
	json.Unmarshal(data, &projects)

	st := loadState()
	for _, p := range projects {
		name, _ := p["project"].(string)
		marker := "  "
		if st != nil && st.Project == name {
			marker = "* "
		}
		subs, _ := p["subscriber_count"].(float64)
		msgs, _ := p["message_count"].(float64)
		fmt.Printf("%s%s (%0.f subscribers, %0.f messages)\n", marker, name, subs, msgs)
	}
}

func cmdSubscribers() {
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board.")
		clierr.Exit1()
	}

	data, err := getBoard("/" + url.PathEscape(st.Project) + "/subscribers")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	var subs []map[string]any
	json.Unmarshal(data, &subs)

	subscriberID := resolveSubscriberID()
	for _, s := range subs {
		role, _ := s["job_title"].(string)
		sid, _ := s["subscriber_id"].(string)
		marker := ""
		if sid == subscriberID {
			marker = " (you)"
		}
		fmt.Printf("  %s (%s)%s\n", role, sid, marker)
	}
}

func cmdLeave() {
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board.")
		clierr.Exit1()
	}
	subscriberID := resolveSubscriberID()
	result, status, err := apiCall("DELETE", "/"+url.PathEscape(st.Project)+"/subscribe", map[string]string{
		"subscriber_id": subscriberID,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if e := serverError(status, result); e != nil {
		fmt.Fprintln(os.Stderr, e)
		clierr.Exit1()
	}
	deleteState()
	fmt.Printf("Left '%s'\n", st.Project)
}

func cmdDelete() {
	st := loadState()
	if st == nil {
		fmt.Fprintln(os.Stderr, "Not subscribed to any board.")
		clierr.Exit1()
	}
	result, status, err := apiCall("DELETE", "/"+url.PathEscape(st.Project), nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if e := serverError(status, result); e != nil {
		fmt.Fprintln(os.Stderr, e)
		clierr.Exit1()
	}
	deleteState()
	fmt.Printf("Deleted board '%s'\n", st.Project)
}

// joinAnyStrings is a JSON array of names as "A, B", each without terminal controls.
func joinAnyStrings(v any) string {
	list, _ := v.([]any)
	var names []string
	for _, x := range list {
		if s, ok := x.(string); ok && s != "" {
			names = append(names, clitext.CleanName(s))
		}
	}
	return strings.Join(names, ", ")
}

// printAskLines says under a message that it is a question (post --ask, #7794) or an answer to one. The message's id is only shown here: it is what answers it (--reply-to).
func printAskLines(m map[string]any) {
	id, _ := m["id"].(float64)
	if ask, ok := m["ask"].(map[string]any); ok {
		open := joinAnyStrings(ask["open"])
		me := resolveSubscriberID()
		owing := false
		if list, ok := ask["open"].([]any); ok {
			for _, x := range list {
				if s, _ := x.(string); s != "" && strings.EqualFold(s, me) {
					owing = true
				}
			}
		}
		switch {
		case owing:
			fmt.Printf("  (a question for you, message #%.0f, with no answer from you yet: answer it with  coral-board post --reply-to %.0f \"...\")\n", id, id)
		case open == "":
			fmt.Printf("  (a question, message #%.0f: answered)\n", id)
		default:
			fmt.Printf("  (a question, message #%.0f: waiting on %s)\n", id, open)
		}
	}
	if to, ok := m["reply_to"].(float64); ok && to > 0 {
		fmt.Printf("  (a reply to message #%.0f)\n", to)
	}
}
