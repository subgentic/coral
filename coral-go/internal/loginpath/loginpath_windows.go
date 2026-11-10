//go:build windows

package loginpath

// Off is the environment variable that turns the widening off (unused: Windows has no login shell to ask).
const Off = "CORAL_NO_LOGIN_PATH"

// Widen does nothing on Windows: its PATH is the registry's, whoever started the process.
func Widen() int { return 0 }
