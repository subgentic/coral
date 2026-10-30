package netbindtest

import "testing"

func TestAllowed(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	cases := []struct {
		goos string
		env  map[string]string
		want bool
	}{
		{"windows", nil, false},
		{"windows", map[string]string{"CORAL_TEST_NETWORK_BIND": "0"}, false},
		{"windows", map[string]string{"CORAL_TEST_NETWORK_BIND": "1"}, true},
		{"windows", map[string]string{"CI": "true"}, true},
		{"linux", nil, true},
		{"darwin", nil, true},
	}
	for _, c := range cases {
		if got := allowed(c.goos, env(c.env)); got != c.want {
			t.Errorf("%s %v: allowed = %v, want %v", c.goos, c.env, got, c.want)
		}
	}
}
