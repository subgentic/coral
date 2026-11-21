package routes

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"

	"github.com/subgentic/coral/internal/board"
)

// #20346: the log line for an action through a Hub carries the link id, the Hub's address from the stored link and the validated hub-user pseudonym; a link nobody knows still logs its id and no address.
func TestHubActionLogLineNamesLinkHubAndPseudonym(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	oldLookup := linkOriginOf
	linkOriginOf = func(_ context.Context, id string) string {
		if id == "lnk-0000000a" {
			return "https://hub-a.example.com"
		}
		return ""
	}
	t.Cleanup(func() { slog.SetDefault(old); linkOriginOf = oldLookup })

	ctx := board.WithActionVia(context.Background(), board.ActionVia{LinkID: "lnk-0000000a", HubUser: "hub-user-1234abcd"})
	recordHubOperatorAction(ctx, nil, "hub-user-1234abcd", "POST", "/api/x", "", 200)
	line := buf.String()
	for _, want := range []string{"link=lnk-0000000a", "hub=https://hub-a.example.com", "hub-user-1234abcd"} {
		assert.Contains(t, line, want)
	}
	buf.Reset()
	recordHubOperatorAction(board.WithActionVia(context.Background(), board.ActionVia{LinkID: "lnk-0000000z"}), nil, "hub-user-1234abcd", "POST", "/api/x", "", 200)
	assert.Contains(t, buf.String(), "link=lnk-0000000z")
	assert.NotContains(t, buf.String(), "hub=https")
	buf.Reset()
	recordHubOperatorAction(context.Background(), nil, "hub-user-1234abcd", "POST", "/api/x", "", 200)
	assert.False(t, strings.Contains(buf.String(), "link="), "a local action names no link")
}
