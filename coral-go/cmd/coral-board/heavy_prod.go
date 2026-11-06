//go:build !dev

package main

import "github.com/subgentic/coral/internal/heavy"

// heavyTransportOverride: none in a product build. The destination is the Operator's ssh alias and nothing an environment variable can change.
func heavyTransportOverride() (heavy.Transport, bool) { return nil, false }
