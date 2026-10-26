package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io"
	"log"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/subgentic/coral/internal/config"
	"github.com/subgentic/coral/internal/license"
	"github.com/subgentic/coral/internal/testguard"
	"github.com/subgentic/coral/internal/tracking"
)

// #8304 (Security's ask on #8272): the steps main was split into are functions now, so what the command line says over the configuration is tested
// directly: parse arguments into a serverFlags (on a fresh standard flag set, as main does with the real one) and look at the config the step leaves.

// serverFlagsFor defines the server flags on a fresh flag.CommandLine and parses args into them; the real command line is put back afterwards.
func serverFlagsFor(t *testing.T, args ...string) *serverFlags {
	t.Helper()
	old := flag.CommandLine
	flag.CommandLine = flag.NewFlagSet("coral", flag.ContinueOnError)
	flag.CommandLine.SetOutput(io.Discard)
	t.Cleanup(func() { flag.CommandLine = old })
	sf := defineServerFlags()
	require.NoError(t, flag.CommandLine.Parse(args))
	return sf
}

// isolateConfig gives the test an empty home and data folder and none of the Coral variables a developer's shell may hold, and puts the log writer
// and flags back after the step (loadServerConfig starts crash logging into the data folder).
func isolateConfig(t *testing.T) (home string) {
	t.Helper()
	for _, k := range []string{"CORAL_HUB", "CORAL_CLOUD_URL", "CORAL_CLOUD_MAX_MODE", "CORAL_CLOUD_CONNECT", "CORAL_NO_AUTO_LOOPBACK", "CORAL_HOST",
		"CORAL_PORT", "CORAL_DATA_DIR", "CORAL_DIR", "CORAL_ALLOW_SHARED_DATA_DIR", "CORAL_TLS_CERT", "CORAL_TLS_KEY"} {
		t.Setenv(k, "")
	}
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	out, flags := log.Writer(), log.Flags()
	t.Cleanup(func() { log.SetOutput(out); log.SetFlags(flags) })
	return home
}

func TestLoadServerConfigAppliesTheFlagsOverTheConfig(t *testing.T) {
	home := isolateConfig(t)
	dataDir := t.TempDir()

	cfg, _ := loadServerConfig(serverFlagsFor(t, "--home", dataDir))
	assert.False(t, cfg.HubMode, "no --hub and no saved setting: not a hub")
	assert.False(t, cfg.HubModeForced)
	assert.False(t, cfg.CloudURLExplicit, "no --cloud-url: the tier default stands")
	assert.Empty(t, cfg.BootstrapFile)
	assert.Empty(t, cfg.ProofFile)
	defaultMax := cfg.CloudMaxMode

	cfg, _ = loadServerConfig(serverFlagsFor(t, "--home", dataDir, "--hub"))
	assert.True(t, cfg.HubMode, "--hub forces hub mode on")
	assert.True(t, cfg.HubModeForced, "and says it was forced: the saved setting no longer decides")

	t.Setenv("CORAL_HUB", "1")
	cfg, _ = loadServerConfig(serverFlagsFor(t, "--home", dataDir))
	assert.True(t, cfg.HubMode, "CORAL_HUB=1 forces it too")
	assert.True(t, cfg.HubModeForced)
	t.Setenv("CORAL_HUB", "")

	cfg, _ = loadServerConfig(serverFlagsFor(t, "--home", dataDir, "--cloud-url", "https://hub.example.test"))
	assert.Equal(t, "https://hub.example.test", cfg.CloudURL, "--cloud-url wins over the tier default")
	assert.True(t, cfg.CloudURLExplicit)
	cfg, _ = loadServerConfig(serverFlagsFor(t, "--home", dataDir, "--cloud-url", ""))
	assert.Empty(t, cfg.CloudURL, `--cloud-url "" turns the connector off`)
	assert.False(t, cfg.CloudURLExplicit, "and an empty URL is not an explicit one")

	cfg, _ = loadServerConfig(serverFlagsFor(t, "--home", dataDir, "--bootstrap-file", "/tmp/enroll.json", "--proof-file", "/tmp/proof.json"))
	assert.Equal(t, "/tmp/enroll.json", cfg.BootstrapFile)
	assert.Equal(t, "/tmp/proof.json", cfg.ProofFile)

	cfg, mode := loadServerConfig(serverFlagsFor(t, "--home", dataDir, "--cloud-url", "https://hub.example.test", "--cloud-connect", " Auto "))
	assert.Equal(t, "auto", cfg.CloudConnect, "--cloud-connect is trimmed and lower-cased")
	want, err := cloudStartupMode(cfg.EffectiveCloudConnect(), true, false)
	require.NoError(t, err)
	assert.Equal(t, want, mode, "the mode returned to main is the one for the connect setting, the URL and no terminal")

	for _, m := range []string{"view", "interact", "launch"} {
		cfg, _ = loadServerConfig(serverFlagsFor(t, "--home", dataDir, "--cloud-max-mode", m))
		assert.Equal(t, m, cfg.CloudMaxMode, "--cloud-max-mode %s", m)
	}
	cfg, _ = loadServerConfig(serverFlagsFor(t, "--home", dataDir))
	assert.Equal(t, defaultMax, cfg.CloudMaxMode, "without the flag the configured maximum stands")
	t.Setenv("CORAL_CLOUD_MAX_MODE", "view")
	cfg, _ = loadServerConfig(serverFlagsFor(t, "--home", dataDir))
	assert.Equal(t, "view", cfg.CloudMaxMode, "CORAL_CLOUD_MAX_MODE is read too")
	cfg, _ = loadServerConfig(serverFlagsFor(t, "--home", dataDir, "--cloud-max-mode", "launch"))
	assert.Equal(t, "launch", cfg.CloudMaxMode, "and the flag wins over it")
	_ = home
}

func TestParseServerFlagsSetsTheSharedDataDirPermission(t *testing.T) {
	isolateConfig(t)
	oldArgs := os.Args
	t.Cleanup(func() { os.Args = oldArgs; config.SetAllowSharedDataDir(false) })
	for _, c := range []struct {
		args []string
		want bool
	}{{[]string{"coral", "--no-browser"}, false}, {[]string{"coral", "--allow-shared-data-dir", "--no-browser"}, true}} {
		config.SetAllowSharedDataDir(!c.want) // the opposite first, so the step has to set it
		os.Args = c.args
		old := flag.CommandLine
		flag.CommandLine = flag.NewFlagSet("coral", flag.ContinueOnError)
		sf := defineServerFlags()
		parseServerFlags(sf)
		flag.CommandLine = old
		assert.Equal(t, c.want, config.AllowSharedDataDir(), "%v", c.args)
		assert.Equal(t, c.want, *sf.allowSharedDataDir)
	}
}

// configureServerCfg is a loaded config of an isolated data folder, with the Terms accepted so the gate lets the step through.
func configureServerCfg(t *testing.T) *config.Config {
	t.Helper()
	isolateConfig(t)
	t.Cleanup(func() { tracking.SetCoralDir("") })
	if config.EULARequired() {
		require.NoError(t, license.WriteEULAMarker())
	}
	return config.Load(t.TempDir())
}

func TestConfigureServerAppliesTheListenFlags(t *testing.T) {
	cfg := configureServerCfg(t)
	defaultHost, defaultPort := cfg.Host, cfg.Port
	configureServer(cfg, serverFlagsFor(t))
	assert.Equal(t, defaultHost, cfg.Host, "no --host: the default stands")
	assert.False(t, cfg.HostExplicit, "and no host was asked for")
	assert.Equal(t, defaultPort, cfg.Port, "no --port: the default port")
	assert.False(t, cfg.NoAutoLoopback)

	cfg = configureServerCfg(t)
	configureServer(cfg, serverFlagsFor(t, "--host", "10.1.2.3", "--port", "9123", "--no-auto-loopback"))
	assert.Equal(t, "10.1.2.3", cfg.Host)
	assert.True(t, cfg.HostExplicit, "a --host is an explicit one: the privacy gate treats it as asked for")
	assert.Equal(t, 9123, cfg.Port)
	assert.True(t, cfg.NoAutoLoopback)

	t.Setenv("CORAL_NO_AUTO_LOOPBACK", "1")
	cfg = configureServerCfg(t) // isolateConfig clears the variable: set it after
	t.Setenv("CORAL_NO_AUTO_LOOPBACK", "1")
	configureServer(cfg, serverFlagsFor(t))
	assert.True(t, cfg.NoAutoLoopback, "CORAL_NO_AUTO_LOOPBACK is the flag's default")
}

// The Terms gate: with the Terms accepted the step returns; without them (and nobody to ask) the process exits 0 saying so, before anything is
// served. The refusal exits, so it runs in a child process. A tier that skips the Terms (the dev build) has no gate to test.
func TestConfigureServerStopsWithoutAcceptedTerms(t *testing.T) {
	if os.Getenv("CORAL_TEST_CONFIGURE_SERVER") == "1" {
		// the guard learns the real ~/.coral from HOME at its first check: take that first, then point HOME at the temp folder
		testguard.CheckDataPath("/nonexistent")
		os.Setenv("HOME", os.Getenv("CORAL_TEST_TEMP_HOME"))
		os.Setenv("USERPROFILE", os.Getenv("CORAL_TEST_TEMP_HOME"))
		if os.Getenv("CORAL_TEST_ACCEPT_TERMS") == "1" {
			if err := license.WriteEULAMarker(); err != nil {
				os.Stderr.WriteString(err.Error() + "\n")
				os.Exit(3)
			}
		}
		cfg := config.Load(os.Getenv("CORAL_DATA_DIR"))
		flag.CommandLine = flag.NewFlagSet("coral", flag.ContinueOnError)
		sf := defineServerFlags()
		configureServer(cfg, sf)
		os.Stdout.WriteString("passed the gate\n")
		return
	}
	if !config.EULARequired() {
		t.Skip("this tier skips the Terms")
	}
	run := func(accepted bool) (int, string, string) {
		home, dataDir := t.TempDir(), t.TempDir()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestConfigureServerStopsWithoutAcceptedTerms$")
		env := cleanEnv()
		cmd.Env = append(env, "CORAL_TEST_CONFIGURE_SERVER=1", "CORAL_DATA_DIR="+dataDir, "HOME="+os.Getenv("HOME"), "CORAL_TEST_TEMP_HOME="+home, "CORAL_PORT="+strconv.Itoa(closedPort(t)))
		if accepted {
			cmd.Env = append(cmd.Env, "CORAL_TEST_ACCEPT_TERMS=1")
		}
		var stdout, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
		err := cmd.Run()
		code := 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		} else {
			require.NoError(t, err)
		}
		return code, stdout.String(), stderr.String()
	}
	code, out, errs := run(false)
	assert.Equal(t, 0, code, errs)
	assert.NotContains(t, out, "passed the gate", "the step must not return without accepted Terms")
	assert.Contains(t, errs, "Terms of Service must be accepted to use Coral.")
	code, out, errs = run(true)
	assert.Equal(t, 0, code, errs)
	assert.Contains(t, out, "passed the gate", "accepted Terms: the step returns")
}
