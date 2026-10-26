package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/subgentic/coral/internal/clierr"
)

// post --assign "Name" [--goal N] [--title T] [--priority P] "text" (#7791, goal #21): work to produce is a task, so the post that asks for it is made one: the task (title from --title or the
// post's first line, the post text as its body, the assignee, a goal) is created with the poster as its creator, and the post goes out carrying the task's link. The assignee is told by the task's
// own notification, so the post is no second nudge: it does not @mention the assignee (a post that does is refused).

// maxAssignTitle is how much of a post's first line becomes its task's title.
const maxAssignTitle = 100

type postAssignment struct {
	message  string
	title    string
	priority string
	assignee string
	goal     int64
}

// prepareAssignment checks everything a --assign post needs before anything is created: a goal (--goal, else the goal of the poster's own in-progress task, never a guess), a title, a priority
// and that the text does not @mention the assignee. It exits (creating and posting nothing) when any of it fails.
func prepareAssignment(st *boardState, message, assignee, toNames, goalArg, titleArg, priorityArg string) *postAssignment {
	fail := func(format string, a ...any) {
		fmt.Fprintf(os.Stderr, "Error: "+format+"\nNothing was created or posted.\n", a...)
		clierr.Exit1()
	}
	assignee = strings.TrimSpace(assignee)
	if assignee == "" {
		fail("--assign needs the name of the agent who gets the task")
	}
	if strings.TrimSpace(message) == "" {
		fail("--assign needs the post's text: it is the task's body")
	}
	for _, name := range strings.Split(toNames, ",") {
		if strings.EqualFold(strings.TrimSpace(name), assignee) {
			fail("--to %q would nudge the assignee a second time: the task already tells them", name)
		}
	}
	if mentionsName(message, assignee) {
		fail("the text @mentions %s, who is told by the task already: take the @ out (or use a plain post for a question or a heads-up)", assignee)
	}
	a := &postAssignment{message: message, assignee: assignee, priority: "medium"}
	if p := strings.TrimSpace(priorityArg); p != "" {
		switch p {
		case "critical", "high", "medium", "low":
			a.priority = p
		default:
			fail("--priority is one of critical, high, medium, low (got %q)", priorityArg)
		}
	}
	a.title = strings.TrimSpace(titleArg)
	if a.title == "" {
		a.title = firstLine(message)
	}
	if a.title == "" {
		fail("the post has no first line to be the task's title: give --title")
	}
	if utf8.RuneCountInString(a.title) > maxAssignTitle {
		a.title = string([]rune(a.title)[:maxAssignTitle-1]) + "…"
	}
	if g := strings.TrimSpace(goalArg); g != "" {
		n, err := strconv.ParseInt(g, 10, 64)
		if err != nil || n <= 0 {
			fail("--goal needs a goal ID, a whole number of 1 or more (got %q)", goalArg)
		}
		a.goal = n
	} else {
		a.goal = currentTaskGoal(st)
		if a.goal == 0 {
			fail("this post has no goal: --goal N names one (coral-board goal list), or post from a task that is on a goal. A task is never made without knowing what it serves")
		}
	}
	return a
}

// currentTaskGoal is the goal of the poster's own in-progress task, 0 with no task or a task on no goal.
func currentTaskGoal(st *boardState) int64 {
	data, status, err := apiCallRaw("POST", "/"+url.PathEscape(st.Project)+"/tasks/current", map[string]string{"subscriber_id": resolveSubscriberID()})
	if err != nil || status != http.StatusOK {
		clierr.Note(clierr.Other) // "no task in progress" is an answer, not a failure: the refusal that follows is a plain error
		return 0
	}
	var task struct {
		GoalID *int64 `json:"goal_id"`
	}
	if json.Unmarshal(data, &task) != nil || task.GoalID == nil {
		return 0
	}
	return *task.GoalID
}

// create makes the task and returns its id; it exits when the board refuses it.
func (a *postAssignment) create(st *boardState, subscriberID string) int64 {
	body := map[string]any{"title": a.title, "body": a.message, "priority": a.priority, "subscriber_id": subscriberID, "assigned_to": a.assignee, "goal_id": a.goal}
	data, status, err := apiCallRaw("POST", "/"+url.PathEscape(st.Project)+"/tasks", body)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		clierr.Exit1()
	}
	if status != http.StatusCreated && status != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Error creating the task: %s\nNothing was posted.\n", clierr.Describe(nil, status, data))
		clierr.Exit1()
	}
	var task struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal(data, &task) != nil || task.ID <= 0 {
		fmt.Fprintln(os.Stderr, "Error: Coral created the task but returned no task id")
		clierr.Exit1()
	}
	fmt.Printf("Created Task #%d: %s (goal #%d, assigned to %s)\n", task.ID, a.title, a.goal, a.assignee)
	return task.ID
}

// firstLine is the first non-empty line of text, trimmed.
func firstLine(text string) string {
	for _, l := range strings.Split(text, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			return l
		}
	}
	return ""
}

// mentionsName reports whether text @mentions name (an @ right before it, not inside a longer word).
func mentionsName(text, name string) bool {
	re, err := regexp.Compile(`(?i)(^|[^\w])@` + regexp.QuoteMeta(name) + `($|[^\w-])`)
	return err == nil && re.MatchString(text)
}
