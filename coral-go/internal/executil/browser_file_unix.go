//go:build !windows && (!darwin || !cgo)

package executil

import (
	"context"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

func defaultBrowserID() (string, error) {
	if runtime.GOOS != "linux" {
		return "", ErrUnknownBrowser
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	b, err := exec.CommandContext(ctx, "xdg-settings", "get", "default-web-browser").Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}
