<#
.SYNOPSIS
  The version the MSI carries (#365). Dot-source this file; it defines ConvertTo-MsiVersion.

  A tag such as v1.4.167-rc1 is Coral's own version, and the programs carry it whole (internal/config.Version). The MSI's ProductVersion is not that string: Windows
  Installer reads it as up to four numbers, major.minor.build.revision, and compares only the first three (it ignores the fourth when it decides an upgrade). A version
  with text in it, "1.4.167-rc1", is not valid; Windows Installer packs it to a number whose high bit is set, and that sorts above every real version, so an installed -rc
  build refused every later release ("A newer version of Coral is already installed").

  So the MSI gets X.Y.Z, the three numbers at the front of the tag: an -rc build and its final release carry the same MSI version, and tools/coral.wxs sets
  AllowSameVersionUpgrades so the final replaces the rc (and rc2 replaces rc1). Each part must fit Windows Installer's limits (major and minor to 255, build to 65535).
#>
function ConvertTo-MsiVersion([string]$Version) {
    $m = [regex]::Match($Version, '^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$')
    if (-not $m.Success) { throw "not a version the MSI can carry (X.Y.Z, then an optional -suffix): '$Version'" }
    $major = [int]$m.Groups[1].Value; $minor = [int]$m.Groups[2].Value; $build = [int]$m.Groups[3].Value
    if ($major -gt 255 -or $minor -gt 255 -or $build -gt 65535) { throw "'$Version' does not fit an MSI version (major and minor to 255, build to 65535)" }
    return "$major.$minor.$build"
}
