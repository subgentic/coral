package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #21703: --to with several names tells each of them, from one message. Three ways agents write the list.
func TestPostToSeveralNamesMentionsEachInOneMessage(t *testing.T) {
	for name, args := range map[string][]string{
		"one comma list":          {"post", "--to", "Dev A,Dev B,Dev C", "the result is ready"},
		"spaces after the commas": {"post", "--to", "Dev A, Dev B, Dev C", "the result is ready"},
		"the flag repeated":       {"post", "--to", "Dev A", "--to", "Dev B", "--to", "Dev C", "the result is ready"},
	} {
		srv := newRecordingServer(t)
		res := runBoard(t, srv.URL, subscribedDataDir(t, srv.URL), args...)
		require.Equal(t, 0, res.code, "%s: %q", name, res.stderr)
		reqs := srv.requests()
		require.Len(t, reqs, 1, "%s: one message, not one per name", name)
		for _, who := range []string{"@Dev A", "@Dev B", "@Dev C"} {
			assert.Contains(t, reqs[0], who, "%s: %s is told", name, who)
		}
	}
}
