package agent

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// A worker launched with a task was told, after the task, to wait for the Orchestrator and STOP, and a model that obeys that literally never did the task (#588). With a prompt the text says to start on
// the task and keeps the wait only for a prompt that gives none; with no prompt the worker still waits.
func TestAWorkerWithATaskIsToldToStartOnIt(t *testing.T) {
	for _, postedBefore := range []bool{false, true} {
		got := BuildBoardActionPromptFor("team", "Developer", "Fix the login page.", nil, "", postedBefore)
		assert.True(t, strings.HasPrefix(got, "Fix the login page.\n\n"), "the task comes first")
		assert.NotContains(t, got, "Do not start any actions until you receive instructions", "no wait before the task")
		assert.Contains(t, got, "start on it now", "it is told to start")
		assert.NotContains(t, got, "{introduction}")
		if postedBefore {
			assert.Contains(t, got, "Carry on with the task the message above gives you")
			assert.NotContains(t, got, "short introduction")
		} else {
			assert.Contains(t, got, "then carry on with your task, or STOP if you have none.")
			assert.NotContains(t, got, `(do NOT address it to @all), then STOP.`)
		}
	}
}

func TestAWorkerWithNoPromptStillWaits(t *testing.T) {
	for _, postedBefore := range []bool{false, true} {
		got := BuildBoardActionPromptFor("team", "Developer", "", nil, "", postedBefore)
		assert.Contains(t, got, "Do not start any actions until you receive instructions from the Orchestrator on the message board.")
		assert.NotContains(t, got, "start on it now")
		if !postedBefore {
			assert.Contains(t, got, `(do NOT address it to @all), then STOP.`)
		}
	}
	assert.Equal(t, strings.ReplaceAll(strings.ReplaceAll(DefaultWorkerActionPrompt, "{board_name}", "team"), "{introduction}", firstJoinIntroduction),
		BuildBoardActionPromptFor("team", "Developer", "", nil, "", false), "with no prompt the text is what it was")
}

func TestTheTaskFirstTextLeavesTheRestAlone(t *testing.T) {
	assert.Contains(t, DefaultWorkerActionPrompt, workerWaitSentence+"{introduction}", "the sentence it swaps is in the default text")
	with := BuildBoardActionPromptFor("team", "Developer", "X", nil, "", false)
	without := BuildBoardActionPromptFor("team", "Developer", "", nil, "", false)
	swapped := strings.Replace(strings.Replace(without, workerWaitSentence, workerWorkSentence, 1), firstJoinIntroduction, firstJoinWorkIntroduction, 1)
	assert.Equal(t, "X\n\n"+swapped, with, "only the wait sentence and the introduction change")
	orch := BuildBoardActionPromptFor("team", "Orchestrator", "X", nil, "", false)
	assert.Contains(t, orch, firstJoinIntroduction, "the Orchestrator's text is not changed")
	custom := BuildBoardActionPromptFor("team", "Developer", "X", map[string]string{"default_prompt_worker": "Do not start any actions until you receive instructions from the Orchestrator on the message board. {introduction}"}, "", false)
	assert.Equal(t, "X\n\n"+workerWaitSentence+firstJoinIntroduction, custom, "a worker text the person wrote is used as it is")
}

func TestTheWorkerSystemPromptWaitsOnlyWithoutATask(t *testing.T) {
	assert.Contains(t, DefaultWorkerSystemPrompt, "if your first message gives you a task, start on it; if it gives you none, STOP and wait.")
	assert.NotContains(t, DefaultWorkerSystemPrompt, "your introduction>\" (never to @all); if you have posted here before, do not introduce yourself again. Then STOP and wait.")
}
