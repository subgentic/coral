package ptymanager

import "context"

// PromptOpenOnScreen is the last look at the screen that a person's chat message takes before it is typed (#14357, Security's INFO on #14345): the same read an automated send makes
// (AutomatedInput.look), asking only whether a prompt or menu the text must not be typed into is open. A screen that cannot be read, or has no prompt, is false (a person's send goes on
// unless a prompt is seen, as DeliverNow's force does); a terminal with no screen to read is false. text is what would be typed: a Claude survey that takes single digits blocks a text
// that starts with one and not another.
func PromptOpenOnScreen(ctx context.Context, term any, name, agentType, sessionID, text string) bool {
	in := AutomatedInput{Term: term, Name: name, AgentType: agentType, SessionID: sessionID, Text: text, force: true}
	return in.look(ctx).skip == SkipPrompt
}
