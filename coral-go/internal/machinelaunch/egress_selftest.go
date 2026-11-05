package machinelaunch

// The egress self-test (#13575): an opt-in way to run #10944's real-machine egress check on a launched machine, whose finish step has already closed SSH. As its LAST act the finish step starts
// coral-egress-selftest.service, which runs the checks on the machine itself and writes PASS/FAIL lines to selftestResultPath; the machine's Coral reports them (a closed shape, owner-only) and nothing
// opens: the test makes outbound requests only, to the fixed targets below (none from the user-data, the Hub or an environment variable), and it is EVIDENCE, not a control: a machine that is already
// compromised can write PASS, so nothing may be gated on it.

const (
	selftestScriptPath = "/usr/local/sbin/coral-egress-selftest"
	selftestUnitPath   = "/etc/systemd/system/coral-egress-selftest.service"
	selftestUnitName   = "coral-egress-selftest.service"
	// SelftestResultPath is what the machine's Coral reads: root-owned, 0644, in a folder the coral user can enter. Lines of "PASS name" or "FAIL name", nothing else.
	SelftestResultPath = "/var/lib/coral-selftest/egress-selftest"
)

// EgressSelfTestUnit runs the self-test once per phase: the first start after the finish step, and the first start after the next boot (the rule must be there again after a reboot). The script keeps its own
// marker per phase, so a third start does nothing.
func EgressSelfTestUnit() string {
	return `[Unit]
Description=Coral: the egress self-test (evidence only, #13575)
After=network-online.target coral-egress.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=` + selftestScriptPath + `

[Install]
WantedBy=multi-user.target
`
}

// EgressSelfTestScript is the test, run as root. Targets are fixed here. The throwaway user is removed by a trap on every path (a failed check, a kill), and the report is written after that. A FAIL opens
// nothing and retries nothing.
func EgressSelfTestScript() string {
	return `#!/bin/sh
# Coral machine egress self-test (#13575). EVIDENCE, NOT A CONTROL: a machine that is already compromised can write PASS. Outbound requests only, to the fixed targets below; nothing is opened.
set -u
meta=http://169.254.169.254/metadata/v1/id
public=http://1.1.1.1/
state=/var/lib/coral-selftest
out=` + SelftestResultPath + `
user=coral-egresstest
install -d -m 0755 "$state"
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
if [ ! -e "$state/first-done" ]; then phase=first
elif [ ! -e "$state/reboot-done" ] && [ "$(cat "$state/first-boot" 2>/dev/null)" != "$boot" ]; then phase=reboot
else exit 0; fi
tmp=$(mktemp "$state/run.XXXXXX") || exit 1
cleanup() {
  userdel -f "$user" >/dev/null 2>&1 || true
  # the report comes after the clean-up, and only when the run got to its end
  if [ -e "$tmp.done" ]; then
    touch "$out"; chmod 0644 "$out"
    cat "$tmp" >> "$out"
    if [ "$phase" = first ]; then echo "$boot" > "$state/first-boot"; : > "$state/first-done"; else : > "$state/reboot-done"; fi
  fi
  rm -f "$tmp" "$tmp.done"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
pass() { echo "PASS $1" >> "$tmp"; }
fail() { echo "FAIL $1" >> "$tmp"; }
useradd --system --no-create-home --shell /usr/sbin/nologin "$user" >/dev/null 2>&1 || true
as_user() { setpriv --reuid="$(id -u "$user")" --regid="$(id -g "$user")" --clear-groups "$@"; }
if [ "$phase" = first ]; then p=""; else p="reboot_"; fi
if systemctl is-active --quiet coral-egress.service; then pass "${p}unit_active"; else fail "${p}unit_active"; fi
if [ "$(nft list table inet coral_egress 2>/dev/null | grep -c 'meta skuid != 0')" -ge 2 ]; then pass "${p}rules_present"; else fail "${p}rules_present"; fi
if as_user curl -sS -m 6 -o /dev/null "$meta" >/dev/null 2>&1; then fail "${p}metadata_blocked_nonroot"; else pass "${p}metadata_blocked_nonroot"; fi
if curl -sS -m 6 "$meta" 2>/dev/null | grep -Eq '^[0-9]+$'; then pass "${p}metadata_open_root"; else fail "${p}metadata_open_root"; fi
if as_user curl -sS -m 8 -o /dev/null "$public" >/dev/null 2>&1; then pass "${p}public_open_nonroot"; else fail "${p}public_open_nonroot"; fi
priv=$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1)
if [ -n "$priv" ]; then
  if as_user curl -sS -m 6 -o /dev/null "http://$priv:22/" >/dev/null 2>&1; then fail "${p}private_blocked_nonroot"; else pass "${p}private_blocked_nonroot"; fi
fi
: > "$tmp.done"
exit 0
`
}

// EgressSelfTestFiles are the script and its unit, written to the user-data only when the launch asked for the self-test.
func EgressSelfTestFiles() []EgressFile {
	return []EgressFile{
		{selftestScriptPath, "0700", EgressSelfTestScript()},
		{selftestUnitPath, "0644", EgressSelfTestUnit()},
	}
}
