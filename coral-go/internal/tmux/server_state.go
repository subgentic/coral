package tmux

import (
	"context"
	"strconv"
	"strings"
)

// ServerState is what one question to Coral's own tmux server found (#12592). Known is false when the answer cannot be told from "the server is gone": a timeout, a client/server
// version mismatch, no tmux to ask. Up is only meaningful when Known.
type ServerState struct {
	PID      int // the server's own process id, when Up
	Sessions int // how many sessions (of any name) it holds, when Up
	Up       bool
	Known    bool
}

// ServerState asks the primary socket's server (never the default socket's) for its pid and how many sessions it holds. No server on the socket, a stale socket file or a refused
// connection is a known "not up": tmux has no server process to answer, which is what the server dying looks like.
func (c *Client) ServerState(ctx context.Context) ServerState {
	if c.SocketPath == "" {
		return ServerState{} // no socket of Coral's own: there is no server of ours to watch
	}
	out, err := c.runOnSocket(ctx, c.SocketPath, "list-sessions", "-F", "#{pid}")
	if err != nil {
		if noServer(execStderr(err)) {
			return ServerState{Known: true}
		}
		return ServerState{}
	}
	lines := strings.Fields(out)
	if len(lines) == 0 {
		return ServerState{} // a server that answered with nothing is not one to report on
	}
	pid, perr := strconv.Atoi(lines[0])
	if perr != nil {
		return ServerState{}
	}
	return ServerState{PID: pid, Sessions: len(lines), Up: true, Known: true}
}
