// Package machinelaunch launches a Coral machine on a cloud provider (#9974, the joint note with coral-hub): it reads the person's provider token and Coral Hub key from files, asks the Hub for a
// one-time machine credential, creates the instance through a Provider and tells the person how to approve it. Secrets live in memory for the calls and nowhere else: never in argv, never in the
// environment, never in a log line or an error.
package machinelaunch

import "errors"

// maxSecretFile is the most a token or key file may hold: provider tokens and Coral Hub keys are a few dozen bytes.
const maxSecretFile = 4096

// ErrUnsafeSecretFile is the one error for a file that may not be read as a secret. Its text says what to fix and never holds the path's content or any part of the secret.
var ErrUnsafeSecretFile = errors.New("secret file is not safe to read")

// ErrEmptySecret is a file (or standard input) with nothing in it.
var ErrEmptySecret = errors.New("secret file is empty")
