<#
.SYNOPSIS
  Unit test of ConvertTo-MsiVersion (tools/msi_version.ps1, #365). Needs no msiexec, no build and no installed Coral: it only dot-sources the function.
  Run: powershell -NoProfile -ExecutionPolicy Bypass -File tests/release/msi_version_test.ps1   (exit 0 = all cases passed)
#>
$ErrorActionPreference = "Stop"
. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) "tools\msi_version.ps1")

$failed = 0
function Check([string]$what, [bool]$ok) { if ($ok) { Write-Host "  ok    $what" } else { Write-Host "  FAIL  $what" -ForegroundColor Red; $script:failed++ } }

# The MSI carries X.Y.Z only: the text after it is Coral's own version, not Windows Installer's.
$carried = [ordered]@{
    "1.4.167"      = "1.4.167"
    "1.4.167-rc1"  = "1.4.167"   # an -rc build and its release carry the same MSI version
    "1.4.167-rc2"  = "1.4.167"
    "1.4.167-dev"  = "1.4.167"
    "0.0.1-rc1"    = "0.0.1"     # the rehearsal identity's versions
    "0.0.0-ci"     = "0.0.0"     # a CI build with no release tag
    "2.0.3+build5" = "2.0.3"
    "255.255.65535" = "255.255.65535"   # the largest Windows Installer takes
}
foreach ($k in $carried.Keys) {
    $got = $null
    try { $got = ConvertTo-MsiVersion $k } catch { $got = "threw: $($_.Exception.Message)" }
    Check "'$k' -> '$($carried[$k])' (got '$got')" ($got -eq $carried[$k])
}

# What cannot be a Windows Installer version is refused, never rounded or guessed.
$refused = @("", "v1.4.167", "1.4", "1.4.x", "1.4.167.1", "rc1", "abc", "1.4.-rc1", "256.0.0", "0.256.0", "0.0.65536", "-1.0.0", " 1.4.167", "1.4.167 ")
foreach ($v in $refused) {
    $threw = $false
    try { $null = ConvertTo-MsiVersion $v } catch { $threw = $true }
    Check "'$v' is refused" $threw
}

# The result is always three numbers: the property Windows Installer compares on (the first three fields).
foreach ($k in $carried.Keys) { Check "'$k' gives exactly three numeric fields" ((ConvertTo-MsiVersion $k) -match '^\d+\.\d+\.\d+$') }

if ($failed -gt 0) { Write-Host "$failed case(s) failed" -ForegroundColor Red; exit 1 }
Write-Host "all cases passed"
