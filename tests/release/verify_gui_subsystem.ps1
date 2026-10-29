param([Parameter(Mandatory=$true, ValueFromRemainingArguments=$true)][string[]]$Path)
$ErrorActionPreference = 'Stop'

# Each program Windows starts with no console of its own (the MSI's custom-action helper, the tray, the app) must be a GUI program (PE
# subsystem 2, go build -ldflags "-H windowsgui"): Windows Installer runs a custom action's program as it is, and a console one flashes a
# console window at every install (#345). The build flag is checked by windows_build_census_test.py; this checks the built file.
foreach ($p in $Path) {
  $b = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $p).ProviderPath)
  $pe = [BitConverter]::ToInt32($b, 0x3c)
  if ($b.Length -lt $pe + 94 -or [BitConverter]::ToUInt32($b, $pe) -ne 0x00004550) { throw "$p is not a PE file" }
  $subsystem = [BitConverter]::ToUInt16($b, $pe + 24 + 68)
  if ($subsystem -ne 2) { throw "$p is not a GUI program (PE subsystem $subsystem; build it with -H windowsgui)" }
  Write-Host "ok: $p is a GUI program"
}
