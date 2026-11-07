package jsonl

import (
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	at "github.com/subgentic/coral/internal/agenttypes"
)

// #14102 (coral-hub's Beta Tester): mergeDuplicateCodexMessage exists for ONE case: Codex wrote the same visible message as an event_msg record and as a response_item record a few milliseconds apart. It
// must not fold two records that are really two messages: a commentary and a final answer that both say "Done" (different phase), or two records of the same format with the same text (each one is its own
// message: the agent said it twice).

func codexAssistantEvent(ts time.Time, text, phase string) map[string]any {
	p := map[string]any{"type": "agent_message", "message": text}
	if phase != "" {
		p["phase"] = phase
	}
	return map[string]any{"type": "event_msg", "timestamp": ts.Format(time.RFC3339Nano), "payload": p}
}

func codexAssistantItem(ts time.Time, text, phase string) map[string]any {
	p := map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text}}}
	if phase != "" {
		p["phase"] = phase
	}
	return map[string]any{"type": "response_item", "timestamp": ts.Format(time.RFC3339Nano), "payload": p}
}

func codexUserEvent(ts time.Time, text string) map[string]any {
	return map[string]any{"type": "event_msg", "timestamp": ts.Format(time.RFC3339Nano), "payload": map[string]any{"type": "user_message", "message": text}}
}

func codexUserItem(ts time.Time, text string) map[string]any {
	return map[string]any{"type": "response_item", "timestamp": ts.Format(time.RFC3339Nano), "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": text}}}}
}

// codexRows runs the records through the same parse-and-merge loop the readers use (tail.go, transcript_window.go) and returns "type:phase:text" for each message that has text.
func codexRows(entries ...map[string]any) []string {
	names := map[string]string{}
	var messages []map[string]any
	for _, entry := range entries {
		for _, m := range parseTranscriptEntry(entry, names, at.Codex) {
			var previous map[string]any
			if len(messages) > 0 {
				previous = messages[len(messages)-1]
			}
			if mergeDuplicateCodexMessage(previous, m) {
				continue
			}
			messages = append(messages, m)
		}
	}
	var out []string
	for _, m := range messages {
		text, _ := m["text"].(string)
		if m["type"] == "user" {
			text, _ = m["content"].(string)
		}
		phase, _ := m["phase"].(string)
		out = append(out, fmt.Sprintf("%v:%s:%s", m["type"], phase, text))
	}
	return out
}

func TestCodexMergeKeepsACommentaryAndAFinalAnswerThatBothSayDone(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	got := codexRows(codexAssistantEvent(t0, "Done", "commentary"), codexAssistantItem(t0.Add(200*time.Millisecond), "Done", "final_answer"))
	assert.Equal(t, []string{"assistant:commentary:Done", "assistant:final_answer:Done"}, got, "two phases are two messages")
}

func TestCodexMergeKeepsTwoRecordsOfTheSameFormatWithTheSameText(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	got := codexRows(codexAssistantEvent(t0, "Checking", "commentary"), codexAssistantEvent(t0.Add(200*time.Millisecond), "Checking", "commentary"))
	assert.Equal(t, []string{"assistant:commentary:Checking", "assistant:commentary:Checking"}, got, "two event_msg records are two messages")
	got = codexRows(codexAssistantItem(t0, "Checking", "commentary"), codexAssistantItem(t0.Add(200*time.Millisecond), "Checking", "commentary"))
	assert.Equal(t, []string{"assistant:commentary:Checking", "assistant:commentary:Checking"}, got, "two response_item records are two messages")
	got = codexRows(codexUserEvent(t0, "ok"), codexUserEvent(t0.Add(100*time.Millisecond), "ok"))
	assert.Len(t, got, 2, "a person who sent the same words twice sent two messages (event_msg)")
	got = codexRows(codexUserItem(t0, "ok"), codexUserItem(t0.Add(100*time.Millisecond), "ok"))
	assert.Len(t, got, 2, "and the same through response_item")
}

// The real duplicate the merge exists for stays merged, in either order, with or without a phase on one copy.
func TestCodexMergeStillFoldsTheEventAndItemCopiesOfOneMessage(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	ms := 5 * time.Millisecond
	assert.Equal(t, []string{"assistant:final_answer:All set"}, codexRows(codexAssistantEvent(t0, "All set", "final_answer"), codexAssistantItem(t0.Add(ms), "All set", "final_answer")), "event then item")
	assert.Equal(t, []string{"assistant:final_answer:All set"}, codexRows(codexAssistantItem(t0, "All set", "final_answer"), codexAssistantEvent(t0.Add(ms), "All set", "final_answer")), "item then event")
	assert.Equal(t, []string{"assistant:final_answer:All set"}, codexRows(codexAssistantEvent(t0, "All set", ""), codexAssistantItem(t0.Add(ms), "All set", "final_answer")), "a copy with no phase takes the other's")
	assert.Equal(t, []string{"user::hello"}, codexRows(codexUserEvent(t0, "hello"), codexUserItem(t0.Add(ms), "hello")), "a user message in both formats")
}

// Two pairs of the same text a moment apart are two messages: the second copy of a pair never folds into the pair before it, in either order.
func TestCodexMergeFoldsEachPairAndKeepsTwoPairsApart(t *testing.T) {
	t0 := time.Date(2026, 11, 7, 10, 0, 0, 0, time.UTC)
	ms := 5 * time.Millisecond
	got := codexRows(codexAssistantEvent(t0, "Checking", "commentary"), codexAssistantItem(t0.Add(ms), "Checking", "commentary"), codexAssistantEvent(t0.Add(300*time.Millisecond), "Checking", "commentary"), codexAssistantItem(t0.Add(305*time.Millisecond), "Checking", "commentary"))
	require.Len(t, got, 2, "event+item, event+item: %v", got)
	got = codexRows(codexAssistantItem(t0, "Checking", "commentary"), codexAssistantEvent(t0.Add(ms), "Checking", "commentary"), codexAssistantItem(t0.Add(300*time.Millisecond), "Checking", "commentary"), codexAssistantEvent(t0.Add(305*time.Millisecond), "Checking", "commentary"))
	require.Len(t, got, 2, "item+event, item+event: %v", got)
}
