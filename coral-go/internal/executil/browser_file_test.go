package executil

import (
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBrowserFileCommands(t *testing.T) {
	for _, tc := range []struct{ os, id, path, base string }{
		{"darwin", "com.apple.Safari", `/project/a &; '"$(touch nope)%#?é.html`, ""},
		{"linux", "firefox.desktop", `/project/a &; '"$(touch nope)%#?é.html`, ""},
		{"windows", "ChromeHTML", `C:\project\a &; '"$(touch nope)%#?é.html`, `C:\Program Files`},
	} {
		t.Run(tc.os, func(t *testing.T) {
			u, err := browserFileURL(tc.os, tc.path)
			require.NoError(t, err)
			parsed, err := url.Parse(u)
			require.NoError(t, err)
			require.Empty(t, parsed.RawQuery)
			require.Empty(t, parsed.Fragment)
			require.Contains(t, u, "%23")
			require.Contains(t, u, "%25")
			require.Contains(t, u, "%20")
			require.Contains(t, u, "%C3%A9")
			argv, err := browserFileCommand(tc.os, tc.id, u, tc.base)
			require.NoError(t, err)
			switch tc.os {
			case "darwin":
				require.Equal(t, []string{"/usr/bin/open", "-b", "com.apple.Safari", u}, argv)
			case "linux":
				require.Equal(t, []string{"gtk-launch", "firefox.desktop", u}, argv)
			case "windows":
				require.Equal(t, []string{filepath.Join(tc.base, filepath.FromSlash("Google/Chrome/Application/chrome.exe")), u}, argv)
			}
			require.Equal(t, u, argv[len(argv)-1])
			require.Equal(t, 1, strings.Count(strings.Join(argv, "\n"), "file:///"))
			for _, arg := range argv[:len(argv)-1] {
				require.NotContains(t, arg, "$(")
				require.NotContains(t, arg, "cmd /c")
				require.NotContains(t, arg, "sh -c")
			}
			_, err = browserFileCommand(tc.os, "evil; sh -c launch", u, tc.base)
			require.ErrorIs(t, err, ErrUnknownBrowser)
		})
	}
	for _, p := range []string{`\\host\share\a.html`, `\\?\C:\a.html`, `//host/share/a.html`, `relative.html`, "/x\n.html"} {
		_, err := browserFileURL("windows", p)
		require.Error(t, err)
	}
}
