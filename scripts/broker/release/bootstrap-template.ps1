# cosyncing installer for Windows x64, rendered by the same release step that renders install.sh.
#
# This is `bootstrap-template.sh` in PowerShell, section for section, and every refusal it carries is
# carried here for the same reason. Where the two differ, the difference is Windows, never policy.
#
# Targets Windows PowerShell 5.1 on .NET Framework, because that is what `powershell -c` invokes and what
# every Windows box has. Two consequences shape the whole file: there is no `ImportSubjectPublicKeyInfo`
# (that is .NET Core 3+), so the P-256 key is decoded by hand into a CNG blob; and `Invoke-WebRequest`
# needs `-UseBasicParsing` and an explicit TLS 1.2 selection.
#
# It installs the JavaScript distribution — one universal bundle plus the web client sidecar, executed by a
# separately installed Bun — and it stops after placing files. Registering the service is `setup`'s job and
# is already qualified; nothing here touches Task Scheduler.
#
# No `param()` block, deliberately: the documented invocation is
# `powershell -NoProfile -c "irm <base>/install.ps1 | iex"`, which has no way to bind
# parameters, so every knob is an environment variable and the same knobs work either way.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 draws a progress bar for every Invoke-WebRequest byte, which costs more than the
# transfer on a ~90 MB archive. Not cosmetic: it is the difference between seconds and minutes.
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell defaults to SSL3/TLS1.0 on hosts whose registry has not been updated, and every
# release host requires TLS 1.2. The shell installer states the same floor with `--tlsv1.2`.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$VERSION = '@VERSION@'
$BASE_URL = '@BASE_URL@'
$KEY_ID = '@KEY_ID@'
# Only the P-256 key is embedded. The Ed25519 sibling is deliberately absent: Windows CNG exposes no
# Ed25519 algorithm identifier and .NET Framework has no implementation, so carrying that key would ship a
# trust anchor this script cannot use and invite a reader to believe it had been checked.
$P256_PUBLIC_KEY_B64 = '@P256_PUBLIC_KEY_B64@'
# The JavaScript application bundle and the web client sidecar this release publishes.
$APP_ASSET = '@APP_ASSET@'
$WEB_ASSET = '@WEB_ASSET@'
# The oldest Bun this release's bundle was built and tested against.
$MINIMUM_BUN = '@MINIMUM_BUN@'
# One row per artifact this installer places: "<name> <sha256> <size>".
$ARTIFACT_TABLE = '@ARTIFACT_TABLE@'
# Official Bun builds for MINIMUM_BUN, most likely first: "<host> <asset> <sha256>". One table serves both
# installers, so rows for hosts this script cannot run on are present and inert.
$BUN_TABLE = '@BUN_TABLE@'
$BUN_RELEASE_BASE = '@BUN_RELEASE_BASE@'
# What this installer installs. `all` places the desktop GUI client too, runs setup, and hands the client
# a pairing; `server` stops after the broker's own files, which is what this installer did before the
# client joined the release. Both are rendered from THIS file, so the server installer is the all-in-one
# with one branch not taken rather than a second script that can drift from it.
$INSTALL_MODE = '@INSTALL_MODE@'
# One row per desktop client this release publishes: "<host> <asset> <sha256> <size>". One table serves all
# four installers, so rows for hosts this script cannot run on are present and inert.
$CLIENT_TABLE = '@CLIENT_TABLE@'

# The one host this installer supports. Windows ARM64 and an x64 process emulated on ARM64 are refused
# below, so there is nothing to select between.
$HOST_KEY = 'windows-x64'

$ACL_SECTIONS = [Security.AccessControl.AccessControlSections]::Owner -bor
  [Security.AccessControl.AccessControlSections]::Group -bor
  [Security.AccessControl.AccessControlSections]::Access

# Resolved and refused on once, below, then used by the functions that unpack the web sidecar and Bun.
$TAR_EXE = ''

# Cleanup state, declared here because `Invoke-InstallCleanup` reads it and the install body assigns it.
$WORK = ''
$WEB_ROOT = ''
$StagedApplication = ''
$StagedReceipt = ''
$StagedWeb = ''
$RetiredWeb = ''
# Set when this run took over an npm install, so the tail can offer to remove the package it came from.
$AdoptedNpmInstall = $false
# Assigned by the all-in-one client section, declared here because `Invoke-InstallCleanup` reads them and
# StrictMode turns an unassigned variable into a terminating error.
$CLIENT_ROOT = ''
$StagedClient = ''
$RetiredClient = ''

function Fail {
  param([Parameter(Mandatory = $true)][string] $Message)
  throw $Message
}

# Read an environment variable without depending on the `$env:` provider under StrictMode, and treat an
# empty value as unset the way the shell's `${VAR:-}` does.
function Get-EnvironmentValue {
  param([Parameter(Mandatory = $true)][string] $Name)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($null -eq $value) { return '' }
  return $value.Trim()
}

# Read one JSON field without StrictMode turning an absent property into a stack trace. A missing field
# reads as $null and every caller compares against what it requires, so a manifest whose shape changed
# fails closed with the message for that field.
function Get-JsonProperty {
  param($Object, [Parameter(Mandatory = $true)][string] $Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

<#
Run a native executable and hand back its output and exit code.

Windows PowerShell 5.1 turns a native child's stderr into ErrorRecords, and under
`$ErrorActionPreference = 'Stop'` the first one is a TERMINATING error — so a plain `& $bun --revision`
whose output is captured kills the installer on any Bun that prints a warning. The preference is lowered
for exactly the duration of the call and restored in a `finally`, and both streams are captured to files.
Captured stderr is carried for diagnosis only and is never parsed for a decision.
#>
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string] $FilePath,
    [string[]] $ArgumentList = @()
  )
  $stdoutPath = [IO.Path]::Combine(
    [IO.Path]::GetTempPath(), 'cosyncing-install-native-' + [Guid]::NewGuid().ToString('N') + '.out')
  $stderrPath = "$stdoutPath.err"
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $exitCode = -1
  try {
    $global:LASTEXITCODE = 0
    & $FilePath @ArgumentList > $stdoutPath 2> $stderrPath
    $exitCode = $LASTEXITCODE
  } catch {
    # A path the operating system will not execute at all. Reported as a failed run rather than raised, so
    # every call site keeps its own refusal message instead of leaking a CommandNotFoundException.
    $exitCode = -1
  } finally {
    $ErrorActionPreference = $previous
  }
  $stdout = ''
  $stderr = ''
  if (Test-Path -LiteralPath $stdoutPath) { $stdout = [IO.File]::ReadAllText($stdoutPath) }
  if (Test-Path -LiteralPath $stderrPath) { $stderr = [IO.File]::ReadAllText($stderrPath) }
  Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  return [pscustomobject] @{ ExitCode = $exitCode; StdOut = $stdout; StdErr = $stderr }
}

# ---------------------------------------------------------------------------------------------------
# Owner-only files and directories, as the product defines them.
# ---------------------------------------------------------------------------------------------------

$CURRENT_USER_SID = ''

<#
The product's own owner-only policy, spelled the way the operating system stores it.

`windowsOwnerOnlySddl` in security/windows-dacl.ts is the definition; this is that string. `FA` is
FILE_ALL_ACCESS, `P` protects the DACL from inheritance, and `OICI` carries the grant into a directory's
contents and is absent on a file. The three principals are the user, SYSTEM and Administrators, closed.

A directory with inherited access is reported `unsafe-dacl` by `doctor` and refused by `setup`, so each
level is created WITH this descriptor rather than tightened afterwards — a post-mkdir change leaves a
window in which a principal admitted by a shared parent could keep an open handle. Measured on Windows
PowerShell 5.1: a child created inside one of these directories comes back `OICIID` and unprotected, so
every level genuinely needs its own.
#>
function Get-OwnerOnlySddl {
  param([Parameter(Mandatory = $true)][ValidateSet('file', 'directory')][string] $Kind)
  $inherit = if ($Kind -eq 'directory') { 'OICI' } else { '' }
  return "O:$CURRENT_USER_SID" + "G:$CURRENT_USER_SID" + 'D:P' +
    "(A;$inherit;FA;;;$CURRENT_USER_SID)" +
    "(A;$inherit;FA;;;S-1-5-18)" +
    "(A;$inherit;FA;;;S-1-5-32-544)"
}

# The .NET APIs rather than Get-Acl/Set-Acl throughout: those live in Microsoft.PowerShell.Security, and a
# 5.1 session that inherited a PowerShell 7 PSModulePath cannot auto-load it. An installer that failed to
# secure a directory because a module would not resolve is the wrong failure to be possible.
function Get-OwnerOnlySecurity {
  param([Parameter(Mandatory = $true)][ValidateSet('file', 'directory')][string] $Kind)
  $security = if ($Kind -eq 'directory') {
    New-Object Security.AccessControl.DirectorySecurity
  } else {
    New-Object Security.AccessControl.FileSecurity
  }
  $security.SetSecurityDescriptorSddlForm((Get-OwnerOnlySddl -Kind $Kind), $ACL_SECTIONS)
  return $security
}

function New-OwnerOnlyDirectory {
  param([Parameter(Mandatory = $true)][string] $Path)
  try {
    [void] [IO.Directory]::CreateDirectory($Path, (Get-OwnerOnlySecurity -Kind 'directory'))
  } catch {
    Fail "could not create directory: $Path ($($_.Exception.Message))"
  }
}

function Set-OwnerOnlySecurity {
  param(
    [Parameter(Mandatory = $true)][string] $Path,
    [Parameter(Mandatory = $true)][ValidateSet('file', 'directory')][string] $Kind
  )
  try {
    if ($Kind -eq 'directory') {
      [IO.Directory]::SetAccessControl($Path, (Get-OwnerOnlySecurity -Kind 'directory'))
    } else {
      [IO.File]::SetAccessControl($Path, (Get-OwnerOnlySecurity -Kind 'file'))
    }
  } catch {
    Fail "could not secure the $Kind at $Path ($($_.Exception.Message))"
  }
}

function Get-PathOwnerSid {
  param([Parameter(Mandatory = $true)][string] $Path)
  try {
    $security = if (Test-Path -LiteralPath $Path -PathType Container) {
      [IO.Directory]::GetAccessControl($Path)
    } else {
      [IO.File]::GetAccessControl($Path)
    }
    $owner = $security.GetOwner([Security.Principal.SecurityIdentifier])
    if ($null -eq $owner) { return '' }
    return $owner.Value
  } catch {
    return ''
  }
}

function Test-ReparsePoint {
  param([Parameter(Mandatory = $true)] $Item)
  return ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}

<#
Create or converge one application-owned directory, mirroring `ensureOwnerOnlyDirectory`.

An existing directory is refused unless the current user owns it, and is then tightened rather than
recreated: an operator's own `%USERPROFILE%\.cosyncing` from an earlier install is legitimate and may
predate this policy, while a directory somebody else owns must never be laundered by tightening it. A
reparse point is refused outright — the shell refuses a symlinked state home for the same reason.
#>
function Initialize-OwnerOnlyDirectory {
  param([Parameter(Mandatory = $true)][string] $Path)
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer -or (Test-ReparsePoint -Item $item)) { Fail "unsafe directory: $Path" }
    if ((Get-PathOwnerSid -Path $Path) -ne $CURRENT_USER_SID) {
      Fail "directory is not owned by the current user: $Path"
    }
    Set-OwnerOnlySecurity -Path $Path -Kind 'directory'
    return
  }
  # Each missing level gets the descriptor in its own create call; one CreateDirectory would otherwise
  # build the intermediates with inherited access.
  $missing = New-Object System.Collections.ArrayList
  $cursor = $Path
  while ($cursor -and -not (Test-Path -LiteralPath $cursor)) {
    [void] $missing.Insert(0, $cursor)
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  if ($missing.Count -eq 0) { Fail "could not create directory: $Path" }
  foreach ($directory in $missing) { New-OwnerOnlyDirectory -Path $directory }
}

function New-StagingPath {
  param([Parameter(Mandatory = $true)][string] $Parent, [Parameter(Mandatory = $true)][string] $Prefix)
  return Join-Path $Parent ($Prefix + [Guid]::NewGuid().ToString('N').Substring(0, 12))
}

# ---------------------------------------------------------------------------------------------------
# Downloads.
# ---------------------------------------------------------------------------------------------------

function Invoke-Download {
  param(
    [Parameter(Mandatory = $true)][string] $Uri,
    [Parameter(Mandatory = $true)][string] $OutFile
  )
  try {
    Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
  } catch {
    Fail "could not download $Uri ($($_.Exception.Message))"
  }
  if (-not (Test-Path -LiteralPath $OutFile -PathType Leaf)) { Fail "could not download $Uri" }
}

function Get-ReleaseFile {
  param([Parameter(Mandatory = $true)][string] $Name)
  $path = Join-Path $WORK $Name
  Invoke-Download -Uri "$BASE_URL/$Name" -OutFile $path
  return $path
}

function Get-Sha256 {
  param([Parameter(Mandatory = $true)][string] $Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# ---------------------------------------------------------------------------------------------------
# The embedded artifact table.
#
# The per-artifact digest table is baked into THIS script at assembly time, alongside the release key. It
# is an artifact pin anchored in the TLS-delivered installer, not an independent trust root: a party who
# can replace this script can replace the digest with it. The script arrives over TLS exactly like every
# other SHA-pinned installer one-liner, the pinned digest is checked before anything is installed, and
# every later upgrade is verified by the broker itself regardless of what this bootstrap could check.
# ---------------------------------------------------------------------------------------------------

function Get-EmbeddedArtifact {
  param([Parameter(Mandatory = $true)][string] $Name)
  $rows = @($ARTIFACT_TABLE -split '\r?\n' |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and (($_ -split '\s+')[0] -eq $Name) })
  if ($rows.Count -gt 1) { Fail 'embedded artifact table contains duplicate rows' }
  if ($rows.Count -eq 0) { Fail "this installer carries no artifact named $Name" }
  $fields = $rows[0] -split '\s+'
  if ($fields.Count -ne 3) { Fail "embedded artifact row for $Name is malformed" }
  if ($fields[1] -notmatch '^[0-9a-f]{64}$') { Fail "embedded checksum for $Name is malformed" }
  if ($fields[2] -notmatch '^[0-9]+$') { Fail "embedded size for $Name is malformed" }
  return [pscustomobject] @{ Name = $Name; Sha256 = $fields[1]; Size = [long] $fields[2] }
}

<#
The desktop client row for one host, or $null when this release publishes none for it.

$null rather than a refusal: a host with no client is a supported outcome of an all-in-one install — it
finishes as a server install and says so — where a missing BROKER artifact is a broken release.
#>
function Get-EmbeddedClient {
  param([Parameter(Mandatory = $true)][string] $Host_)
  $rows = @($CLIENT_TABLE -split '\r?\n' |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and (($_ -split '\s+')[0] -eq $Host_) })
  if ($rows.Count -gt 1) { Fail 'embedded client table contains duplicate rows' }
  if ($rows.Count -eq 0) { return $null }
  $fields = $rows[0] -split '\s+'
  if ($fields.Count -ne 4) { Fail "embedded client row for $Host_ is malformed" }
  if ($fields[2] -notmatch '^[0-9a-f]{64}$') { Fail "embedded checksum for $($fields[1]) is malformed" }
  if ($fields[3] -notmatch '^[0-9]+$') { Fail "embedded size for $($fields[1]) is malformed" }
  return [pscustomobject] @{ Name = $fields[1]; Sha256 = $fields[2]; Size = [long] $fields[3] }
}

# ---------------------------------------------------------------------------------------------------
# P-256 verification.
# ---------------------------------------------------------------------------------------------------

$P256_CURVE_OID = [byte[]] @(0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07)

<#
Build an ECDSA verifier from the embedded SPKI PEM, by hand.

Windows PowerShell 5.1 runs on .NET Framework, which has no `ImportSubjectPublicKeyInfo` — that is
.NET Core 3+ — and Windows ships no system OpenSSL to shell out to. So the SPKI is decoded here: assert it
names the P-256 curve, take the trailing uncompressed point, and hand CNG a `BCRYPT_ECCKEY_BLOB` (`ECS1`
magic, cbKey 32, X, Y). CNG can always do this, which is why this script has no "cannot verify" state and
no degraded branch: signature FAILURE is fatal, and the genuine inability to verify that a stock-LibreSSL
Mac has does not occur here.
#>
function New-P256Verifier {
  param([Parameter(Mandatory = $true)][string] $Base64Pem)
  try {
    $pem = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Base64Pem))
    $body = ($pem -split '\r?\n' | Where-Object { $_ -notmatch '^-----' }) -join ''
    $der = [Convert]::FromBase64String($body)
  } catch {
    Fail 'embedded P-256 release key is invalid'
  }
  $oidAt = -1
  for ($index = 0; $index -le $der.Length - $P256_CURVE_OID.Length; $index += 1) {
    $matched = $true
    for ($offset = 0; $offset -lt $P256_CURVE_OID.Length; $offset += 1) {
      if ($der[$index + $offset] -ne $P256_CURVE_OID[$offset]) { $matched = $false; break }
    }
    if ($matched) { $oidAt = $index; break }
  }
  if ($oidAt -lt 0) { Fail 'embedded release key does not name the P-256 curve' }
  if ($der.Length -lt 65) { Fail 'embedded release key is too short to carry a P-256 point' }
  $point = New-Object byte[] 65
  [Array]::Copy($der, $der.Length - 65, $point, 0, 65)
  if ($point[0] -ne 0x04) { Fail 'embedded release key is not an uncompressed P-256 point' }
  # BCRYPT_ECCKEY_BLOB: magic, then cbKey, then X and Y at cbKey bytes each. 0x31534345 is 'ECS1',
  # BCRYPT_ECDSA_PUBLIC_P256_MAGIC.
  $blob = New-Object byte[] 72
  [Array]::Copy([BitConverter]::GetBytes([uint32] 0x31534345), 0, $blob, 0, 4)
  [Array]::Copy([BitConverter]::GetBytes([uint32] 32), 0, $blob, 4, 4)
  [Array]::Copy($point, 1, $blob, 8, 64)
  try {
    $key = [Security.Cryptography.CngKey]::Import(
      $blob, [Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob)
    return New-Object Security.Cryptography.ECDsaCng $key
  } catch {
    Fail "embedded P-256 release key could not be loaded ($($_.Exception.Message))"
  }
}

<#
Verify one detached signature over one downloaded payload.

The `.p256.sig` files are IEEE P1363 — the raw 64-byte `r || s` — which is exactly the layout
`ECDsa.VerifyData(byte[], byte[], HashAlgorithmName)` reads, and the only layout .NET Framework offers.
The `.p256.der.sig` siblings exist for `openssl dgst -verify` on the shell path and are not used here.
#>
function Assert-P256Signature {
  param(
    [Parameter(Mandatory = $true)] $Verifier,
    [Parameter(Mandatory = $true)][string] $PayloadPath,
    [Parameter(Mandatory = $true)][string] $SignaturePath,
    [Parameter(Mandatory = $true)][string] $Failure
  )
  $signature = [IO.File]::ReadAllBytes($SignaturePath)
  if ($signature.Length -ne 64) { Fail $Failure }
  $payload = [IO.File]::ReadAllBytes($PayloadPath)
  $verified = $false
  try {
    $verified = $Verifier.VerifyData(
      $payload, $signature, [Security.Cryptography.HashAlgorithmName]::SHA256)
  } catch {
    $verified = $false
  }
  if (-not $verified) { Fail $Failure }
}

<#
Every digest the signed manifest states FOR THIS ASSET, by walking the document.

Reading `artifacts[0].sha256` and friends by position would bind this check to today's manifest shape, and
scanning for the digest anywhere would be weaker than it looks — it would pass for a manifest that named
the asset in one object and carried the digest in another. So the walk collects the `sha256` of every
object whose `name` is this asset, and the caller refuses anything but exactly one, the same rule the
checksum list applies to a repeated row. Neither is reachable without the signing key; a rule that
silently picked one of two answers would still be the wrong rule to have written down.
#>
function Get-ManifestDigestsFor {
  param($Node, [Parameter(Mandatory = $true)][string] $Name, [Parameter(Mandatory = $true)] $Found)
  if ($null -eq $Node -or $Node -is [string] -or $Node -is [ValueType]) { return }
  if ($Node -is [System.Collections.IList]) {
    foreach ($item in $Node) { Get-ManifestDigestsFor -Node $item -Name $Name -Found $Found }
    return
  }
  if ($Node -is [System.Management.Automation.PSCustomObject]) {
    $named = Get-JsonProperty -Object $Node -Name 'name'
    if (($named -is [string]) -and ($named -eq $Name)) {
      [void] $Found.Add([string] (Get-JsonProperty -Object $Node -Name 'sha256'))
    }
    foreach ($property in $Node.PSObject.Properties) {
      Get-ManifestDigestsFor -Node $property.Value -Name $Name -Found $Found
    }
  }
}

<#
The two statements about ONE artifact that hold for everything this installer places: the signed checksum
list, and the digest baked into this script. Both bind the NAME to the digest, so agreement is about this
artifact rather than about a digest appearing somewhere.
#>
function Assert-ChecksumPin {
  param(
    [Parameter(Mandatory = $true)] $Pin,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $ChecksumRows
  )
  $named = @($ChecksumRows | Where-Object { ($_ -split '\s+')[1] -eq $Pin.Name })
  if ($named.Count -gt 1) { Fail 'checksum list contains duplicate artifact rows' }
  if ($named.Count -eq 0) { Fail "artifact checksum is missing or malformed: $($Pin.Name)" }
  $signed = ($named[0] -split '\s+')[0]
  if ($signed -notmatch '^[0-9a-f]{64}$') {
    Fail "artifact checksum is missing or malformed: $($Pin.Name)"
  }
  # The signed chain and the baked-in table must name the same bytes, or one of the two was tampered with.
  if ($signed -ne $Pin.Sha256) {
    Fail "signed checksum list disagrees with the digest embedded in this installer for $($Pin.Name)"
  }
}

<#
The broker's own artifacts add a THIRD statement: the signed manifest, which names them because a running
broker upgrades ITSELF to them. A desktop client is not a broker upgrade and the manifest deliberately does
not name one, so the client path calls `Assert-ChecksumPin` directly and this wrapper is what the broker
artifacts use.
#>
function Assert-SignedArtifact {
  param(
    [Parameter(Mandatory = $true)] $Pin,
    [Parameter(Mandatory = $true)] $Manifest,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $ChecksumRows
  )
  Assert-ChecksumPin -Pin $Pin -ChecksumRows $ChecksumRows
  $stated = New-Object System.Collections.ArrayList
  Get-ManifestDigestsFor -Node $Manifest -Name $Pin.Name -Found $stated
  if ($stated.Count -gt 1) { Fail "signed manifest names $($Pin.Name) more than once" }
  if ($stated.Count -eq 0) { Fail "signed manifest does not name $($Pin.Name)" }
  if ($stated[0] -ne $Pin.Sha256) {
    Fail "signed manifest and checksum list disagree about $($Pin.Name)"
  }
}

function Get-VerifiedArtifact {
  param([Parameter(Mandatory = $true)] $Pin)
  $path = Get-ReleaseFile -Name $Pin.Name
  if ((Get-Item -LiteralPath $path -Force).Length -ne $Pin.Size) {
    Fail "$($Pin.Name) size does not match this installer"
  }
  if ((Get-Sha256 -Path $path) -ne $Pin.Sha256) { Fail "$($Pin.Name) checksum verification failed" }
  return $path
}

# ---------------------------------------------------------------------------------------------------
# Bun.
#
# The bundle carries no interpreter, so a Bun that can run it is a hard prerequisite rather than a nicety.
# COSYNCING_BUN_BIN is honoured first because it is the same override the broker itself reads.
# ---------------------------------------------------------------------------------------------------

function Get-BunVersion {
  param([Parameter(Mandatory = $true)][string] $Path)
  $probe = Invoke-Native -FilePath $Path -ArgumentList @('--revision')
  if ($probe.ExitCode -ne 0) { return '' }
  $firstLine = @($probe.StdOut -split '\r?\n' | ForEach-Object { $_.Trim() } |
    Where-Object { $_ } | Select-Object -First 1)
  if ($firstLine.Count -eq 0) { return '' }
  $match = [Regex]::Match($firstLine[0], '^(\d+)\.(\d+)\.(\d+)')
  if (-not $match.Success) { return '' }
  return $match.Value
}

function Test-BunMeetsFloor {
  param([Parameter(Mandatory = $true)][string] $Path)
  $reported = Get-BunVersion -Path $Path
  if (-not $reported) { return $false }
  return ([Version] $reported) -ge ([Version] $MINIMUM_BUN)
}

function Resolve-Bun {
  param([Parameter(Mandatory = $true)][string] $BunPrefix)
  $candidates = New-Object System.Collections.ArrayList
  $override = Get-EnvironmentValue 'COSYNCING_BUN_BIN'
  if ($override) { [void] $candidates.Add($override) }
  $onPath = @(Get-Command 'bun' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1)
  if ($onPath.Count -gt 0) { [void] $candidates.Add($onPath[0].Source) }
  [void] $candidates.Add((Join-Path $BunPrefix 'bin\bun.exe'))
  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    if (Test-BunMeetsFloor -Path $candidate) { return $candidate }
  }
  return ''
}

<#
The two questions about this machine that nothing in PowerShell 5.1 can answer, in one compiled type.

`IsWow64Process2` is what Microsoft documents for "what machine is this, really", and it is the same
kernel32 export `windowsFfi().nativeMachine()` reaches through Bun's FFI. Asking it here means the
installer's host refusal and `brokerHostVerdict`'s agree by construction rather than by resemblance.

`IsProcessorFeaturePresent(PF_AVX2_INSTRUCTIONS_AVAILABLE)` is how a pre-AVX2 x64 is detected, because
Windows exposes no AVX2 bit through CIM. Worth asking because Bun's plain build faults on such a host
rather than exiting cleanly, and a Windows Error Reporting dialog during a headless install is worse
than a wasted download.

Both are wrapped so a host that cannot compile at all — Constrained Language Mode, a locked-down
compiler — degrades instead of failing. See each caller for what degraded means there.
#>
# TRUE when this process holds an elevated token. Its own function for the same reason
# `Get-NativeMachineValue` is: a host property a test cannot change about itself has to be replaceable in
# a copy of the rendered script, since the alternative is an environment override — and a refusal that an
# environment variable can switch off is not a refusal.
# Put the install directory on the user's PATH.
#
# Windows has no equivalent of adding a line to a shell rc file: an operator who cannot run `cosyncing`
# has no convenient way to fix it, so the installer that placed the binary is the thing that must. Bun's
# own installer, which this one already depends on, does the same to the same PATH.
#
# Written through the registry rather than [Environment]::SetEnvironmentVariable, which rewrites the
# value as REG_SZ. User PATH is normally REG_EXPAND_SZ, and flattening it stops every OTHER entry that
# contains a %VARIABLE% from resolving -- a well-known way for an installer to break unrelated software.
# The existing kind is read and preserved.
function Add-UserPathEntry {
  param([Parameter(Mandatory = $true)][string] $Directory)
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { return 'unavailable' }
  try {
    $kind = 'ExpandString'
    try {
      if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
    } catch { $kind = 'ExpandString' }
    # Unexpanded, so a PATH written with %USERPROFILE% is compared and rewritten as it was stored.
    $current = [string] $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    # Entry-wise, never a substring test: `...\.cosyncing\bin` is a substring of nothing here, but a
    # directory whose name merely STARTS with another's would otherwise read as already present.
    $entries = @($current -split ';' | Where-Object { $_ -ne '' })
    foreach ($entry in $entries) {
      $candidate = $entry.Trim().TrimEnd('\')
      if (-not $candidate) { continue }
      $expanded = [Environment]::ExpandEnvironmentVariables($candidate)
      if ($expanded -eq $Directory.TrimEnd('\')) { return 'already-present' }
    }
    $next = if ($entries.Count -gt 0) { ($entries -join ';') + ';' + $Directory } else { $Directory }
    $key.SetValue('Path', $next, $kind)
    # A registry write alone reaches nobody: a terminal started from Explorer inherits Explorer's cached
    # environment, so without this broadcast "open a new terminal" would not actually work and the
    # operator would have to sign out. Best-effort -- the entry is written either way, and the timeout
    # keeps a wedged top-level window from holding the installer.
    try {
      if (-not ('CosyncingInstall.Broadcast' -as [type])) {
        Add-Type -Namespace 'CosyncingInstall' -Name 'Broadcast' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint msg, System.UIntPtr wParam,
  string lParam, uint flags, uint timeout, out System.UIntPtr result);
'@ -ErrorAction Stop
      }
      $unused = [UIntPtr]::Zero
      # HWND_BROADCAST, WM_SETTINGCHANGE, SMTO_ABORTIFHUNG, 5s.
      [void] [CosyncingInstall.Broadcast]::SendMessageTimeout(
        [IntPtr] 0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref] $unused)
    } catch { }
    return 'added'
  } catch {
    return 'unavailable'
  } finally {
    $key.Dispose()
  }
}

function Test-ElevatedProcess {
  param([Parameter(Mandatory = $true)] $Identity)
  return (New-Object Security.Principal.WindowsPrincipal $Identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# A running desktop client holds its own executable open, and Windows will not rename the directory that
# contains it. Both the preflight and the placement itself ask this, so the rule and its wording live once.
function Assert-ClientNotRunning {
  param([Parameter(Mandatory = $true)][string] $ClientRoot)
  foreach ($candidate in @(Get-Process -Name 'cosyncing' -ErrorAction SilentlyContinue)) {
    $candidatePath = ''
    try { $candidatePath = $candidate.Path } catch { $candidatePath = '' }
    if ($candidatePath -and $candidatePath.StartsWith($ClientRoot,
        [StringComparison]::OrdinalIgnoreCase)) {
      Fail ("the desktop client is running from $ClientRoot and Windows cannot replace it while it " +
        'is open; close it and run this installer again')
    }
  }
}

function Initialize-NativeProbe {
  if ('CosyncingInstall.Native' -as [type]) { return $true }
  try {
    Add-Type -Namespace 'CosyncingInstall' -Name 'Native' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetCurrentProcess();
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool IsWow64Process2(System.IntPtr process, out ushort processMachine, out ushort nativeMachine);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern bool IsProcessorFeaturePresent(uint feature);
'@
  } catch {
    return $false
  }
  return $true
}

# The raw `IMAGE_FILE_MACHINE_*` value for the NATIVE machine, or $null when nothing could answer.
# `IsWow64Process2` is Windows 10 1511 and newer; an older host raises EntryPointNotFoundException at the
# call rather than at Add-Type, because DllImport binds lazily.
function Get-NativeMachineValue {
  if (-not (Initialize-NativeProbe)) { return $null }
  [uint16] $processMachine = 0
  [uint16] $nativeMachine = 0
  try {
    if (-not [CosyncingInstall.Native]::IsWow64Process2(
        [CosyncingInstall.Native]::GetCurrentProcess(), [ref] $processMachine, [ref] $nativeMachine)) {
      return $null
    }
  } catch {
    return $null
  }
  return $nativeMachine
}

<#
The machine's architecture as `Kind` (`x64`, `arm64`, `other` or `unknown`) plus what to print.

`RuntimeInformation.OSArchitecture` is NOT a substitute for the kernel call and is only the fallback
here: on .NET Framework it is `GetNativeSystemInfo`, documented to report the EMULATED architecture to
an x86 or x64 process on an ARM64 machine, and before 4.8.1 it does not consult the machine at all. So
an installer keyed on it would admit an emulated ARM64 host silently — which is the case this refusal
exists for.

`unknown` means no probe answered, and it PROCEEDS. That is a deliberate difference from
`brokerHostVerdict`, which refuses a machine it cannot identify: the broker's qualified surface is the
thing it is about to run, whereas this script places files that `setup` then refuses to register, with
FFI in hand and a message of its own. An installer that turns away a supported machine because a
compiler was blocked would be the worse failure. It also means a pre-4.7.1 host, where the fallback
type does not exist either, now reaches the `tar.exe` refusal below and is told what to do, instead of
dying on a missing .NET type.
#>
function Get-MachineArchitecture {
  $native = Get-NativeMachineValue
  if ($null -ne $native) {
    switch ($native) {
      0x8664 { return [pscustomobject] @{ Kind = 'x64'; Reported = 'x64' } }
      0xAA64 { return [pscustomobject] @{ Kind = 'arm64'; Reported = 'ARM64' } }
      # Zero means the call succeeded and declined to say, which is not a machine we can name. Fall
      # through to the framework's answer rather than refusing on it.
      0x0000 { }
      default {
        return [pscustomobject] @{
          Kind = 'other'
          Reported = ('IMAGE_FILE_MACHINE 0x{0:x4}' -f $native)
        }
      }
    }
  }
  try {
    $reported = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
  } catch {
    return [pscustomobject] @{ Kind = 'unknown'; Reported = 'an architecture this host will not report' }
  }
  $kind = 'other'
  if ($reported -eq [System.Runtime.InteropServices.Architecture]::X64) {
    $kind = 'x64'
  } elseif ($reported -eq [System.Runtime.InteropServices.Architecture]::Arm64) {
    $kind = 'arm64'
  }
  return [pscustomobject] @{ Kind = $kind; Reported = "$reported" }
}

# Only REORDERS the pinned rows — the `--revision` probe still decides which build runs — so a probe that
# cannot run costs the default order and nothing else.
function Test-Avx2Present {
  if (-not (Initialize-NativeProbe)) { return $true }
  try {
    return [CosyncingInstall.Native]::IsProcessorFeaturePresent(40)
  } catch {
    return $true
  }
}

function Get-BunCandidates {
  $rows = @($BUN_TABLE -split '\r?\n' |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -and (($_ -split '\s+')[0] -eq $HOST_KEY) } |
    ForEach-Object {
      $fields = $_ -split '\s+'
      [pscustomobject] @{ Asset = $fields[1]; Sha256 = $fields[2] }
    })
  if ($rows.Count -eq 0) { Fail "this installer carries no pinned Bun build for $HOST_KEY" }
  if (-not (Test-Avx2Present)) {
    $rows = @($rows | Where-Object { $_.Asset -like '*-baseline*' }) +
      @($rows | Where-Object { $_.Asset -notlike '*-baseline*' })
  }
  return $rows
}

<#
Bun is DOWNLOADED, never bundled. A Bun inside this release would put a JavaScriptCore build back into the
artifact set — the one thing this distribution exists to avoid — and would make every cosyncing release
responsible for shipping a runtime it does not build.

Downloaded is not the same as unverified. Every cosyncing artifact above is checked against a digest baked
into this script; the runtime that EXECUTES those artifacts is held to exactly the same rule. Bun's own
`bun.com/install.ps1` is deliberately not in this path: piping an unpinned third-party script to a shell
would make the one component nothing here checks the one component that runs everything else. The archives
come straight from Bun's tagged release and their checksums are Bun's own published ones.
#>
function Install-PinnedBun {
  param([Parameter(Mandatory = $true)][string] $BunPrefix)
  if ((Get-EnvironmentValue 'COSYNCING_SKIP_BUN_INSTALL') -eq '1') {
    Fail ("Bun $MINIMUM_BUN or newer is required to run cosyncing and COSYNCING_SKIP_BUN_INSTALL=1 " +
      'forbids installing it; install it from https://bun.sh and rerun this installer')
  }
  Write-Output ("Bun $MINIMUM_BUN or newer is required and was not found. " +
    "Installing the pinned Bun $MINIMUM_BUN.")
  foreach ($candidate in Get-BunCandidates) {
    $archive = Join-Path $WORK $candidate.Asset
    Invoke-Download -Uri "$BUN_RELEASE_BASE/bun-v$MINIMUM_BUN/$($candidate.Asset)" -OutFile $archive
    # A mismatch is fatal, never "try the next one": these are the bytes Bun published for this tag, so
    # different bytes mean the download was substituted, not that this build is wrong for this host.
    if ((Get-Sha256 -Path $archive) -ne $candidate.Sha256) {
      Fail "$($candidate.Asset) does not match the checksum embedded in this installer"
    }
    $unpack = Join-Path $WORK 'bun-unpack'
    if (Test-Path -LiteralPath $unpack) { Remove-Item -LiteralPath $unpack -Recurse -Force }
    New-OwnerOnlyDirectory -Path $unpack
    # `tar.exe` (bsdtar), not `Expand-Archive`. The cmdlet lives in Microsoft.PowerShell.Archive, which is
    # the same class of dependency this script refuses to take on Get-Acl: a 5.1 session that inherited a
    # PowerShell 7 PSModulePath cannot auto-load it, and this is the ONE path that only runs on a host
    # without a usable Bun — so the failure would land exactly where nothing else has been proven. bsdtar
    # reads zip, it is already a hard requirement for the web sidecar, and it is refused for once above.
    $extract = Invoke-Native -FilePath $TAR_EXE -ArgumentList @('-xf', $archive, '-C', $unpack)
    if ($extract.ExitCode -ne 0) {
      Fail ("$($candidate.Asset) could not be extracted (tar exit $($extract.ExitCode)" +
        "$(if ($extract.StdErr) { ": $($extract.StdErr.Trim())" }))")
    }
    # Bun packs one directory named after the asset, holding the executable.
    $unpacked = Join-Path $unpack (
      [IO.Path]::GetFileNameWithoutExtension($candidate.Asset) + '\bun.exe')
    if (-not (Test-Path -LiteralPath $unpacked -PathType Leaf)) {
      Fail "$($candidate.Asset) did not contain a bun.exe"
    }
    if (Test-BunMeetsFloor -Path $unpacked) {
      Initialize-OwnerOnlyDirectory -Path (Join-Path $BunPrefix 'bin')
      Move-Item -LiteralPath $unpacked -Destination (Join-Path $BunPrefix 'bin\bun.exe') -Force
      return
    }
    Write-Output "  $($candidate.Asset) does not run on this host; trying the next pinned build"
  }
  Fail ("no pinned Bun $MINIMUM_BUN build runs on this host ($HOST_KEY); install Bun from " +
    'https://bun.sh and rerun this installer')
}

function Invoke-InstallCleanup {
  if ($WORK -and (Test-Path -LiteralPath $WORK)) {
    Remove-Item -LiteralPath $WORK -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($path in @($StagedApplication, $StagedReceipt, $StagedWeb, $StagedClient)) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  # A retired web root is the operator's previous client, held only for the instant between two renames. On
  # any failure it is put BACK, never discarded — losing it would leave a host with no web client at all.
  if ($RetiredWeb -and (Test-Path -LiteralPath $RetiredWeb -PathType Container)) {
    if (Test-Path -LiteralPath $WEB_ROOT) {
      Remove-Item -LiteralPath $RetiredWeb -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Move-Item -LiteralPath $RetiredWeb -Destination $WEB_ROOT -Force -ErrorAction SilentlyContinue
    }
  }
  # The same rule for the desktop client the all-in-one places.
  if ($RetiredClient -and $CLIENT_ROOT -and
      (Test-Path -LiteralPath $RetiredClient -PathType Container)) {
    if (Test-Path -LiteralPath $CLIENT_ROOT) {
      Remove-Item -LiteralPath $RetiredClient -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Move-Item -LiteralPath $RetiredClient -Destination $CLIENT_ROOT -Force -ErrorAction SilentlyContinue
    }
  }
}

# ---------------------------------------------------------------------------------------------------
# Refusals, before any network.
# ---------------------------------------------------------------------------------------------------

# Takes over the copy `cosyncing setup` made from the npm package, after asking.
#
# A missing receipt is the ORDINARY state of an npm install, not evidence of tampering: the npm package is
# an acquisition artifact, and `cosyncing setup` copies its bundle to exactly this path and writes no
# receipt. Refusing every unreceipted application therefore refused the entire installed base - npm is the
# only other channel this product ships through - and did it before the desktop-client step, so neither
# half was updated.
#
# Consent comes from the console and nowhere else. Every environment variable this installer reads makes it
# MORE restrictive, never less, and an unattended run must not take over another package manager's install
# on an operator's behalf, so there is deliberately no variable that answers this question.
#
# On agreement this returns and the ordinary placement below runs: one file is replaced and one receipt is
# written. Nothing reads or writes anything else under the state home, so settings, credentials, paired
# devices, drafts and sessions survive untouched, and the scheduled task keeps naming the same path.
function Get-SupersededWebRoot {
  # The web client is version-stamped, so an upgrade does not replace the previous root - it lands beside
  # it and, until this existed, abandoned it. Every sibling but the current one is superseded, so a host
  # that has already leaked several is healed rather than merely stopped from leaking more. The install
  # directory is one this installer owns outright - it refuses an unowned application, shim or web root -
  # so a `cosyncing-web-*` in it is either this release's or a superseded one. A reparse point is skipped
  # rather than followed, and so is anything this user does not own.
  param([string]$InstallDir, [string]$Current, [string]$OwnerSid)
  $found = @()
  foreach ($item in @(Get-ChildItem -LiteralPath $InstallDir -Filter 'cosyncing-web-*' -Force `
      -ErrorAction SilentlyContinue)) {
    if (-not $item.PSIsContainer) { continue }
    if (Test-ReparsePoint -Item $item) { continue }
    if ($item.FullName -eq $Current) { continue }
    if ((Get-PathOwnerSid -Path $item.FullName) -ne $OwnerSid) { continue }
    $found += $item.FullName
  }
  return $found
}

function Approve-NpmApplicationTakeover {
  param(
    [Parameter(Mandatory = $true)][string] $BunBin,
    [Parameter(Mandatory = $true)][string] $Application,
    [Parameter(Mandatory = $true)][string] $StateHome,
    [Parameter(Mandatory = $true)][string] $Version
  )
  # Running it is not a new exposure: a user-owned file in the user's own profile that this installer is
  # about to overwrite, executed as that same user.
  $probe = Invoke-Native -FilePath $BunBin -ArgumentList @($Application, 'version', '--json')
  $reported = $null
  if ($probe.ExitCode -eq 0) {
    try { $reported = $probe.StdOut | ConvertFrom-Json } catch { $reported = $null }
  }
  if ((-not $reported) -or
      ((Get-JsonProperty -Object $reported -Name 'product') -cne 'cosyncing') -or
      ((Get-JsonProperty -Object $reported -Name 'packaged') -ne $true) -or
      ((Get-JsonProperty -Object $reported -Name 'distribution') -cne 'bun-js')) {
    Fail 'existing application has no safe bootstrap ownership receipt'
  }
  $existingVersion = [string] (Get-JsonProperty -Object $reported -Name 'version')
  if (-not $existingVersion) { $existingVersion = 'an unknown version' }

  Write-Output ''
  Write-Output "cosyncing $existingVersion is installed at"
  Write-Output "  $Application"
  Write-Output 'from the npm package, by `cosyncing setup`. This installer did not place it.'
  Write-Output ''
  Write-Output 'Taking it over replaces that one file and records ownership of it. Everything else in'
  Write-Output "  $StateHome"
  Write-Output 'is left exactly as it is - settings, credentials, paired devices, drafts and sessions -'
  Write-Output 'and the scheduled task keeps naming the same path.'
  Write-Output ''

  if ([Console]::IsInputRedirected) {
    Fail ('replacing an npm install needs your answer and no console input is attached. Rerun this ' +
      'installer from a PowerShell window, or stay on npm with: npm update -g cosyncing; then ' +
      "& '$BunBin' '$Application' setup")
  }

  if ((Read-Host "Replace it with cosyncing $Version? [y/N]") -notmatch '^(y|yes)$') {
    Fail 'left the npm install in place; nothing was changed'
  }
}

try {
  if ($PSVersionTable.PSVersion -lt [Version] '5.1') {
    Fail ("Windows PowerShell 5.1 or newer is required; this host reports " +
      "$($PSVersionTable.PSVersion). Update Windows Management Framework, or run this installer from a " +
      'newer PowerShell.')
  }

  # The Windows mirror of the shell installer's root refusal. The qualified service lifecycle is a
  # per-user Scheduled Task registered by the user who owns it, and an elevated install would stamp
  # BUILTIN\Administrators as the owner of every file it creates — which the product's own owner-only
  # inspection then reads as somebody else's state.
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (Test-ElevatedProcess -Identity $identity) {
    Fail ('refusing an elevated install; run this in an ordinary PowerShell window as the user who will ' +
      'own the broker')
  }
  $CURRENT_USER_SID = $identity.User.Value

  # The MACHINE architecture, not the process's. `brokerHostVerdict` refuses for both reasons this does:
  # Windows ARM64 is not qualified, and neither is an x64 process emulated on an ARM64 machine — which
  # reports x64 for itself, so a check written against the process would admit it silently. The two now
  # ask the same kernel export; see `Get-MachineArchitecture` for why the framework's own answer cannot
  # be the one that decides, and for why an unanswerable probe proceeds here but not there.
  $machine = Get-MachineArchitecture
  if ($machine.Kind -ceq 'arm64') {
    Fail ('Windows ARM64 is not yet qualified for this broker. Run the broker on Windows x64, or on a ' +
      'supported Linux or macOS host.')
  }
  if ($machine.Kind -ceq 'other') {
    Fail ("this installer supports Windows x64; this machine reports $($machine.Reported). Run the " +
      'broker on Windows x64, or on a supported Linux or macOS host.')
  }

  # The desktop client is placed at the very end of this script, so a client left open used to be
  # discovered only after the download, the signature check, the Bun probe and the whole broker install
  # had already run - the operator waited through all of it to be told to close an app and start over.
  # Ask here, while nothing has been written. The placement asks again, which is what catches a client
  # started while this was running.
  if ($null -ne (Get-EmbeddedClient -Host_ $HOST_KEY)) {
    $preflightLocalAppData = Get-EnvironmentValue 'LOCALAPPDATA'
    if ($preflightLocalAppData -and [IO.Path]::IsPathRooted($preflightLocalAppData)) {
      $preflightRoot = Join-Path ([IO.Path]::GetFullPath($preflightLocalAppData)) 'cosyncing\client'
      Assert-ClientNotRunning -ClientRoot $preflightRoot
    }
  }

  # The sidecar is a gzipped tar and Windows PowerShell 5.1 can unpack neither layer. `tar.exe` (bsdtar)
  # has shipped in System32 since Windows 10 1803, so this is a refusal that names what to do rather than
  # a reason to skip the web client and leave a broker whose own UI is missing. It unpacks Bun's zip too,
  # which is why nothing here needs Microsoft.PowerShell.Archive.
  $TAR_EXE = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $TAR_EXE -PathType Leaf)) {
    Fail ("required program is missing: $TAR_EXE. It ships with Windows 10 1803 and newer; update " +
      'Windows, or install the broker on a supported Linux or macOS host.')
  }

  if ($BASE_URL -notmatch '^https://') {
    Fail 'this installer was rendered with a non-HTTPS release base URL and will not run'
  }

  # -------------------------------------------------------------------------------------------------
  # State home and the paths setup acquires from.
  # -------------------------------------------------------------------------------------------------

  $userProfile = Get-EnvironmentValue 'USERPROFILE'
  if (-not $userProfile) { Fail 'USERPROFILE is required' }

  $stateHome = Get-EnvironmentValue 'COSYNCING_HOME'
  if ($stateHome) {
    if (-not [IO.Path]::IsPathRooted($stateHome)) { Fail 'COSYNCING_HOME must be absolute when set' }
  } else {
    # The broker's own default: `os.homedir()` plus the product state directory name, which on Windows is
    # USERPROFILE. Confirmed against `setupStateHome()`, which has no win32-specific branch to mirror.
    $stateHome = Join-Path $userProfile '.cosyncing'
  }
  if ($stateHome -match '[\r\n]') { Fail 'state path contains a line break' }
  $stateHome = [IO.Path]::GetFullPath($stateHome)

  $installDir = Join-Path $stateHome 'bin'
  $application = Join-Path $installDir 'cosyncing'
  # A shim for humans, not for the service: `setup` writes the Scheduled Task's action with bun.exe named
  # directly, so nothing durable depends on this file.
  $aliasPath = Join-Path $installDir 'cosy.cmd'
  # A packaged broker resolves its web client as `<directory of the application>\cosyncing-web-<version>`,
  # so the sidecar has exactly one correct destination and the installer must not invent another.
  $WEB_ROOT = Join-Path $installDir "cosyncing-web-$VERSION"
  $receiptPath = Join-Path $stateHome 'bootstrap-receipt'

  $WORK = New-StagingPath -Parent ([IO.Path]::GetTempPath()) -Prefix 'cosyncing-install.'
  # Owner-only even though it is scratch: %TEMP% is per-user but the verified artifacts pass through here
  # before they are installed, and a shared-temp host must not let another principal swap them.
  New-OwnerOnlyDirectory -Path $WORK

  # -------------------------------------------------------------------------------------------------
  # Verify the release, then fetch what it names.
  # -------------------------------------------------------------------------------------------------

  $applicationPin = Get-EmbeddedArtifact -Name $APP_ASSET
  $webPin = Get-EmbeddedArtifact -Name $WEB_ASSET

  $verifier = New-P256Verifier -Base64Pem $P256_PUBLIC_KEY_B64

  $manifestPath = Get-ReleaseFile -Name 'release-manifest.json'
  $checksumPath = Get-ReleaseFile -Name 'SHA256SUMS'
  $manifestSignaturePath = Get-ReleaseFile -Name 'release-manifest.json.p256.sig'
  $checksumSignaturePath = Get-ReleaseFile -Name 'SHA256SUMS.p256.sig'

  Assert-P256Signature -Verifier $verifier -PayloadPath $manifestPath `
    -SignaturePath $manifestSignaturePath -Failure 'release manifest signature verification failed'
  Assert-P256Signature -Verifier $verifier -PayloadPath $checksumPath `
    -SignaturePath $checksumSignaturePath -Failure 'checksum-list signature verification failed'

  $manifest = $null
  try {
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  } catch {
    Fail 'signed release manifest is not readable JSON'
  }
  # `-cne`, not `-ne`: PowerShell's default comparison is case-INSENSITIVE, and every identity compared
  # from here down is an exact string the release step wrote. The signature is the real guard, so this is
  # hygiene rather than a hole, but a check that would accept `Universal` for `universal` does not mean
  # what it reads as.
  if ((Get-JsonProperty -Object $manifest -Name 'version') -cne $VERSION) {
    Fail 'signed manifest version does not match this pinned installer'
  }
  # One key id covers both signatures, because the Ed25519 and P-256 keys are one release identity rather
  # than two independent trust anchors: a release is signed by the pair. This installer carries only the
  # P-256 half and still asserts the manifest's single identity — the two cannot be rotated apart without
  # also changing this id. See docs/release/broker-release-signing.md.
  $manifestKeyId = Get-JsonProperty -Name 'keyId' `
    -Object (Get-JsonProperty -Object $manifest -Name 'signature')
  if ($manifestKeyId -cne $KEY_ID) {
    Fail 'signed manifest key id does not match this pinned installer'
  }

  $checksumRows = [string[]] @([IO.File]::ReadAllText($checksumPath) -split '\r?\n' |
    ForEach-Object { $_.Trim() } | Where-Object { $_ })

  Assert-SignedArtifact -Pin $applicationPin -Manifest $manifest -ChecksumRows $checksumRows
  Assert-SignedArtifact -Pin $webPin -Manifest $manifest -ChecksumRows $checksumRows

  $applicationSource = Get-VerifiedArtifact -Pin $applicationPin
  $webSource = Get-VerifiedArtifact -Pin $webPin

  # -------------------------------------------------------------------------------------------------
  # Bun.
  # -------------------------------------------------------------------------------------------------

  # Bun's own installer puts its prefix at $BUN_INSTALL, defaulting to %USERPROFILE%\.bun. Honour an
  # existing setting so a host that already directs Bun elsewhere is not given a second copy in a
  # directory it never reads.
  $bunPrefix = Get-EnvironmentValue 'BUN_INSTALL'
  if ($bunPrefix) {
    if (-not [IO.Path]::IsPathRooted($bunPrefix)) { Fail 'BUN_INSTALL must be absolute when set' }
  } else {
    $bunPrefix = Join-Path $userProfile '.bun'
  }
  $bunPrefix = [IO.Path]::GetFullPath($bunPrefix)

  $bunBin = Resolve-Bun -BunPrefix $bunPrefix
  $bunState = ''
  if ($bunBin) {
    $bunState = "already installed ($(Get-BunVersion -Path $bunBin) at $bunBin)"
  } else {
    Install-PinnedBun -BunPrefix $bunPrefix
    # Re-probe rather than trusting the install: it reports success for an install this script would still
    # refuse, and a Bun below the floor must never reach the receipt.
    $bunBin = Resolve-Bun -BunPrefix $bunPrefix
    if (-not $bunBin) {
      Fail ("Bun $MINIMUM_BUN or newer is still not runnable after installing it into $bunPrefix; " +
        'install it from https://bun.sh and rerun this installer')
    }
    $bunState = "installed by this script ($(Get-BunVersion -Path $bunBin) at $bunBin)"
  }

  # -------------------------------------------------------------------------------------------------
  # Identity probe.
  #
  # Run the verified bundle through the resolved Bun and make it identify itself. The bundle cannot be
  # executed on its own: its shebang means nothing on Windows, and resolving `bun` through PATH could name
  # a different runtime from the one this install is about to record.
  # -------------------------------------------------------------------------------------------------

  $probe = Invoke-Native -FilePath $bunBin -ArgumentList @($applicationSource, 'version', '--json')
  if ($probe.ExitCode -ne 0) { Fail 'verified application did not run its offline version check' }
  $reported = $null
  try {
    $reported = $probe.StdOut | ConvertFrom-Json
  } catch {
    Fail 'verified application did not report readable version JSON'
  }
  if ((Get-JsonProperty -Object $reported -Name 'version') -cne $VERSION) {
    Fail 'verified application reports the wrong version'
  }
  if ((Get-JsonProperty -Object $reported -Name 'target') -cne 'universal') {
    Fail 'verified application reports the wrong target'
  }
  if ((Get-JsonProperty -Object $reported -Name 'packaged') -ne $true) {
    Fail 'verified application is not a packaged build'
  }
  # The kind is checked exactly. `packaged` is true for the npm build too, and an npm-owned bundle
  # installed here would tell the operator to run `npm update` on files npm never placed.
  if ((Get-JsonProperty -Object $reported -Name 'distribution') -cne 'bootstrap-js') {
    Fail 'verified application is not the installer-owned distribution'
  }

  # -------------------------------------------------------------------------------------------------
  # Existing install and receipt.
  # -------------------------------------------------------------------------------------------------

  Initialize-OwnerOnlyDirectory -Path $stateHome
  Initialize-OwnerOnlyDirectory -Path $installDir

  if (Test-Path -LiteralPath $application) {
    $existing = Get-Item -LiteralPath $application -Force
    if ($existing.PSIsContainer -or (Test-ReparsePoint -Item $existing)) {
      Fail 'existing cosyncing application is not a safe regular file'
    }
    if ((Get-PathOwnerSid -Path $application) -ne $CURRENT_USER_SID) {
      Fail 'existing cosyncing application is not owned by this user'
    }
    # No receipt to check against, by design on the npm path: this either wins consent to take the
    # install over, or exits. There is deliberately no third outcome where an unreceipted application is
    # replaced. See Approve-NpmApplicationTakeover.
    if ((-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) -or
        (Test-ReparsePoint -Item (Get-Item -LiteralPath $receiptPath -Force))) {
      Approve-NpmApplicationTakeover -BunBin $bunBin -Application $application `
        -StateHome $stateHome -Version $VERSION
      $AdoptedNpmInstall = $true
    } else {
      if ((Get-PathOwnerSid -Path $receiptPath) -ne $CURRENT_USER_SID) {
        Fail 'existing bootstrap receipt is not owned by this user'
      }
      $receiptLines = @([IO.File]::ReadAllText($receiptPath) -split '\r?\n' |
        ForEach-Object { $_.Trim() })
      # Receipt 1 recorded a compiled per-host executable. This installer places a JavaScript bundle a Bun
      # runtime executes, so overwriting one with the other would leave a service that can never start.
      if ($receiptLines -contains 'schemaVersion=1') {
        Fail ('this path holds a compiled cosyncing install; remove it and its service before installing ' +
          'the JavaScript build')
      }
      if ($receiptLines -notcontains 'schemaVersion=2') { Fail 'existing bootstrap receipt is invalid' }
      if ($receiptLines -notcontains 'product=cosyncing') {
        Fail 'existing bootstrap receipt is for another product'
      }
      if ($receiptLines -notcontains "application=$application") {
        Fail 'existing bootstrap receipt names another application'
      }
      $prior = @($receiptLines | Where-Object { $_ -clike 'sha256=*' } |
        ForEach-Object { $_.Substring(7) })
      if ($prior.Count -ne 1 -or $prior[0] -notmatch '^[0-9a-f]{64}$') {
        Fail 'existing bootstrap receipt checksum is invalid'
      }
      if ((Get-Sha256 -Path $application) -ne $prior[0]) {
        Fail 'existing application differs from its bootstrap ownership receipt'
      }
    }
  }

  # There is no symlink alias on Windows, so the `cosy` path is a batch shim this installer writes. A file
  # that is not one of ours is refused rather than replaced, exactly as the shell refuses a `cosy` that is
  # not its own symlink.
  if (Test-Path -LiteralPath $aliasPath) {
    $aliasItem = Get-Item -LiteralPath $aliasPath -Force
    if ($aliasItem.PSIsContainer -or (Test-ReparsePoint -Item $aliasItem) -or
        ([IO.File]::ReadAllText($aliasPath) -notmatch '%~dp0cosyncing')) {
      Fail 'refusing to replace an unowned cosy path'
    }
  }

  if (Test-Path -LiteralPath $WEB_ROOT) {
    $webItem = Get-Item -LiteralPath $WEB_ROOT -Force
    if (-not $webItem.PSIsContainer -or (Test-ReparsePoint -Item $webItem)) {
      Fail "unsafe web client path: $WEB_ROOT"
    }
    if ((Get-PathOwnerSid -Path $WEB_ROOT) -ne $CURRENT_USER_SID) {
      Fail "web client directory is not owned by the current user: $WEB_ROOT"
    }
  }

  # -------------------------------------------------------------------------------------------------
  # Stage, then rename.
  # -------------------------------------------------------------------------------------------------

  # The sidecar archive holds a single `app/` tree. Extract it into the install directory rather than a
  # temp filesystem so the final move is a rename on one volume, not a cross-volume copy that could
  # half-complete.
  $StagedWeb = New-StagingPath -Parent $installDir -Prefix '.cosyncing-web.staging.'
  New-OwnerOnlyDirectory -Path $StagedWeb
  $extract = Invoke-Native -FilePath $TAR_EXE -ArgumentList @('-xzf', $webSource, '-C', $StagedWeb)
  if ($extract.ExitCode -ne 0) {
    Fail "web client archive could not be extracted ($($extract.StdErr.Trim()))"
  }
  $stagedApp = Join-Path $StagedWeb 'app'
  if (-not (Test-Path -LiteralPath (Join-Path $stagedApp 'index.html') -PathType Leaf)) {
    Fail 'web client archive does not contain a web build'
  }
  # tar created `app` inside the staging directory, so it carries INHERITED access. The product reports an
  # inherited DACL as `unsafe-dacl`, and this directory is about to become the web root the product
  # inspects, so it gets its own protected descriptor before the rename carries it there.
  Set-OwnerOnlySecurity -Path $stagedApp -Kind 'directory'

  $StagedApplication = New-StagingPath -Parent $installDir -Prefix '.cosyncing.install.'
  Copy-Item -LiteralPath $applicationSource -Destination $StagedApplication -Force
  Set-OwnerOnlySecurity -Path $StagedApplication -Kind 'file'

  $StagedReceipt = New-StagingPath -Parent $stateHome -Prefix '.bootstrap-receipt.'
  # LF and no byte-order mark, with the same keys the shell installer writes, so a receipt is the same
  # bytes on every host.
  $receipt = (@(
    'schemaVersion=2',
    'product=cosyncing',
    "version=$VERSION",
    'target=universal',
    'distribution=bootstrap-js',
    "host=$HOST_KEY",
    "application=$application",
    "webRoot=$WEB_ROOT",
    "runtime=$bunBin",
    "sha256=$($applicationPin.Sha256)"
  ) -join "`n") + "`n"
  [IO.File]::WriteAllText($StagedReceipt, $receipt, (New-Object Text.UTF8Encoding $false))
  Set-OwnerOnlySecurity -Path $StagedReceipt -Kind 'file'

  Move-Item -LiteralPath $StagedApplication -Destination $application -Force
  $StagedApplication = ''
  Move-Item -LiteralPath $StagedReceipt -Destination $receiptPath -Force
  $StagedReceipt = ''
  if (Test-Path -LiteralPath $WEB_ROOT -PathType Container) {
    $RetiredWeb = New-StagingPath -Parent $installDir -Prefix '.cosyncing-web.retired.'
    Move-Item -LiteralPath $WEB_ROOT -Destination $RetiredWeb -Force
  }
  Move-Item -LiteralPath $stagedApp -Destination $WEB_ROOT -Force
  Remove-Item -LiteralPath $StagedWeb -Recurse -Force -ErrorAction SilentlyContinue
  $StagedWeb = ''
  if ($RetiredWeb) {
    Remove-Item -LiteralPath $RetiredWeb -Recurse -Force -ErrorAction SilentlyContinue
    $RetiredWeb = ''
  }

  # The shell places a `cosy -> cosyncing` symlink. Windows offers a JavaScript bundle no equivalent, so
  # `cosy` is a batch shim with the resolved Bun baked in — a convenience for humans typing commands.
  # `setup` writes the service's own action with bun.exe named directly and never reads this file. Written
  # without a byte-order mark, because cmd.exe would try to execute the mark as part of the first command.
  [IO.File]::WriteAllText($aliasPath, "@`"$bunBin`" `"%~dp0cosyncing`" %*`r`n",
    (New-Object Text.UTF8Encoding $false))
  Set-OwnerOnlySecurity -Path $aliasPath -Kind 'file'

  Write-Output "Installed cosyncing $VERSION at $application"
  Write-Output "Web client: $WEB_ROOT"
  Write-Output "Bun runtime: $bunState"
  Write-Output 'Artifact digests: matched the sha256 values embedded in this installer.'
  Write-Output ('Release signature: verified (ECDSA P-256 over the signed release manifest and ' +
    'checksum list)')
  Write-Output "Command shim: $aliasPath"
  $pathState = Add-UserPathEntry -Directory $installDir
  if ($pathState -eq 'added') {
    Write-Output "PATH: added $installDir to your user PATH. Open a NEW terminal, then run: cosy setup"
  } elseif ($pathState -eq 'already-present') {
    Write-Output "PATH: $installDir is already on your user PATH."
  } else {
    Write-Output "PATH: could not be updated. Run cosyncing with its full path, or add $installDir by hand."
  }

  # The npm package is preserved by design - `uninstall` says the same thing - but after a takeover it is
  # a loaded gun: its own `setup` copies itself back over the application just placed, and the next run of
  # this installer would then refuse again. Offer to remove it, and never fail the install over the answer.
  if ($AdoptedNpmInstall) {
    $npmRoot = ''
    if (Get-Command npm -CommandType Application -ErrorAction SilentlyContinue) {
      $npmProbe = Invoke-Native -FilePath 'npm' -ArgumentList @('root', '-g')
      if ($npmProbe.ExitCode -eq 0) { $npmRoot = $npmProbe.StdOut.Trim() }
    }
    if ($npmRoot -and (Test-Path -LiteralPath (Join-Path $npmRoot 'cosyncing') -PathType Container)) {
      Write-Output ''
      Write-Output "The npm package it came from is still installed at $npmRoot\cosyncing."
      Write-Output 'Its own setup would copy itself back over the install just made.'
      if ((Read-Host 'Remove it now? [y/N]') -match '^(y|yes)$') {
        $removal = Invoke-Native -FilePath 'npm' -ArgumentList @('uninstall', '-g', 'cosyncing')
        if ($removal.ExitCode -eq 0) {
          Write-Output 'Removed the npm package.'
        } else {
          Write-Output 'Could not remove the npm package; remove it by hand: npm uninstall -g cosyncing'
        }
      } else {
        Write-Output 'Left it in place. Remove it later with: npm uninstall -g cosyncing'
      }
    }
  }

  if ($INSTALL_MODE -cne 'all') {
    # Named, not removed. This installer does not run setup, so the service is still the previous broker
    # and still serving out of one of these; setup is what moves it to the new root.
    foreach ($superseded in (Get-SupersededWebRoot -InstallDir $installDir -Current $WEB_ROOT -OwnerSid $CURRENT_USER_SID)) {
      Write-Output "A previous web client is still at $superseded. setup moves the service to the new"
      Write-Output 'one, after which that directory can be removed.'
    }
    if ($pathState -eq 'added') {
      Write-Output 'Open a NEW terminal so the PATH entry applies, then run: cosy setup'
      Write-Output 'Or run setup now with the absolute command:'
    } else {
      Write-Output 'Run setup with the absolute command:'
    }
    Write-Output "  & '$bunBin' '$application' setup"
    exit 0
  }

  # -------------------------------------------------------------------------------------------------
  # The all-in-one tail: the desktop client, setup, and the pairing handoff.
  #
  # Everything above is what `install-server.ps1` also does, and it has already finished. Nothing below
  # undoes it. A host this release publishes no client for is reported and skipped - a supported outcome,
  # not a failure. Everything else here is fatal, including any disagreement about the client's bytes: this
  # run exits non-zero with a correctly installed broker and a printed next command, which is the honest
  # report of what happened.
  # -------------------------------------------------------------------------------------------------

  $clientPin = Get-EmbeddedClient -Host_ $HOST_KEY
  $clientLaunch = ''
  if ($null -eq $clientPin) {
    Write-Output "Desktop client: skipped - this release publishes no desktop client for $HOST_KEY."
  } else {
    # Verified by exactly the rule the broker's own artifacts are verified by, minus the manifest - which
    # names broker upgrades and deliberately does not name a client. See `Assert-SignedArtifact`.
    Assert-ChecksumPin -Pin $clientPin -ChecksumRows $checksumRows
    $clientSource = Get-VerifiedArtifact -Pin $clientPin

    # %LOCALAPPDATA%, not %USERPROFILE%\.cosyncing: this is an application, not broker state, and Windows
    # puts a per-user unpackaged application there. Owner-only all the same, because the whole install is
    # one user's and an application another principal can rewrite is an application that runs as this one.
    $localAppData = Get-EnvironmentValue 'LOCALAPPDATA'
    if (-not $localAppData) { $localAppData = Join-Path $userProfile 'AppData\Local' }
    if (-not [IO.Path]::IsPathRooted($localAppData)) { Fail 'LOCALAPPDATA must be absolute' }
    $clientParent = Join-Path ([IO.Path]::GetFullPath($localAppData)) 'cosyncing'
    Initialize-OwnerOnlyDirectory -Path $clientParent
    $CLIENT_ROOT = Join-Path $clientParent 'client'

    # `tar.exe` (bsdtar), not `Expand-Archive`: the cmdlet lives in Microsoft.PowerShell.Archive, and a 5.1
    # session that inherited a PowerShell 7 PSModulePath cannot auto-load it. bsdtar reads zip, it is
    # already a hard requirement refused for once above, and it is what unpacks Bun's archives here too.
    $StagedClient = New-StagingPath -Parent $clientParent -Prefix '.cosyncing-client.staging.'
    New-OwnerOnlyDirectory -Path $StagedClient
    $extract = Invoke-Native -FilePath $TAR_EXE -ArgumentList @('-xf', $clientSource, '-C', $StagedClient)
    if ($extract.ExitCode -ne 0) {
      Fail ("desktop client archive could not be extracted (tar exit $($extract.ExitCode)" +
        "$(if ($extract.StdErr) { ": $($extract.StdErr.Trim())" }))")
    }
    # The archive holds one top-level directory whose name carries the release version, so the tree is
    # found rather than named: a version-shaped path written down here would be a second place to keep in
    # step with the client release.
    $extracted = @([IO.Directory]::GetDirectories($StagedClient))
    if ($extracted.Count -ne 1) {
      Fail 'desktop client archive does not contain a single application directory'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $extracted[0] 'cosyncing.exe') -PathType Leaf)) {
      Fail 'desktop client archive contains no cosyncing.exe'
    }
    # tar created that directory inside the staging one, so it carries INHERITED access; it gets its own
    # protected descriptor before the rename carries it to its destination.
    Set-OwnerOnlySecurity -Path $extracted[0] -Kind 'directory'

    # A running client holds its own executable open, and Windows will not rename the directory that
    # contains it: the retire step below would fail mid-install and roll back with a message about a move,
    # not about the app the operator has open. Say it before anything is touched. The broker above is
    # already installed and correct, which is the same posture as every other fatal step in this tail.
    Assert-ClientNotRunning -ClientRoot $CLIENT_ROOT

    if (Test-Path -LiteralPath $CLIENT_ROOT) {
      $clientItem = Get-Item -LiteralPath $CLIENT_ROOT -Force
      if (-not $clientItem.PSIsContainer -or (Test-ReparsePoint -Item $clientItem)) {
        Fail "unsafe desktop client path: $CLIENT_ROOT"
      }
      if ((Get-PathOwnerSid -Path $CLIENT_ROOT) -ne $CURRENT_USER_SID) {
        Fail "desktop client directory is not owned by the current user: $CLIENT_ROOT"
      }
      $RetiredClient = New-StagingPath -Parent $clientParent -Prefix '.cosyncing-client.retired.'
      Move-Item -LiteralPath $CLIENT_ROOT -Destination $RetiredClient -Force
    }
    Move-Item -LiteralPath $extracted[0] -Destination $CLIENT_ROOT -Force
    Remove-Item -LiteralPath $StagedClient -Recurse -Force -ErrorAction SilentlyContinue
    $StagedClient = ''
    if ($RetiredClient) {
      Remove-Item -LiteralPath $RetiredClient -Recurse -Force -ErrorAction SilentlyContinue
      $RetiredClient = ''
    }
    $clientLaunch = Join-Path $CLIENT_ROOT 'cosyncing.exe'
    # A Start Menu entry, so the client is startable after this run rather than only by absolute path.
    # Linux gets a .desktop entry and macOS an .app the launcher already indexes; Windows had neither,
    # which left the client reachable only from the install that launched it and nowhere afterwards.
    $shortcutPath = ''
    try {
      $appData = Get-EnvironmentValue 'APPDATA'
      if ($appData) {
        $programs = Join-Path $appData 'Microsoft\Windows\Start Menu\Programs'
        if (-not (Test-Path -LiteralPath $programs)) {
          New-Item -ItemType Directory -Path $programs -Force | Out-Null
        }
        $candidate = Join-Path $programs 'cosyncing.lnk'
        # The Start Menu starts the client with its OWN environment, not this script's, so a relocated
        # home has to travel with the shortcut or the client reads %USERPROFILE%\.cosyncing and finds no
        # handoff. A .lnk cannot carry an environment variable, so that case goes through a launcher
        # script; the default home needs none and points straight at the executable.
        $target = $clientLaunch
        if ($stateHome -ne (Join-Path $userProfile '.cosyncing')) {
          $launcher = Join-Path $CLIENT_ROOT 'cosyncing-launch.cmd'
          [IO.File]::WriteAllText(
            $launcher,
            "@echo off`r`nset `"COSYNCING_HOME=$stateHome`"`r`nstart `"`" `"$clientLaunch`"`r`n",
            (New-Object Text.UTF8Encoding $false))
          # The shortcut targets the launcher itself: Windows runs a .cmd through the shell, so no
          # interpreter has to be named and no further environment is read to locate one.
          $target = $launcher
        }
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($candidate)
        $shortcut.TargetPath = $target
        if ($target -ne $clientLaunch) {
          # Minimized, so the launcher's console does not sit on screen behind the client.
          $shortcut.WindowStyle = 7
        }
        $shortcut.WorkingDirectory = $CLIENT_ROOT
        $shortcut.IconLocation = $clientLaunch
        $shortcut.Description = 'Drive your coding agents from anywhere'
        $shortcut.Save()
        $shortcutPath = $candidate
      }
    } catch {
      # An unwritable Start Menu is not a failed install: the client is placed and launchable either way,
      # and saying so beats failing a run whose broker and client are both correct.
      $shortcutPath = ''
    }
    if ($shortcutPath) {
      Write-Output "Desktop client: $CLIENT_ROOT (Start Menu: $shortcutPath)"
    } else {
      Write-Output "Desktop client: $CLIENT_ROOT (no Start Menu entry could be written)"
    }
  }

  # `setup` shows the whole plan and asks before it changes anything, and that consent is the point of the
  # command. A run whose input is redirected - a scheduled task, a CI step, a remote command - cannot ask,
  # so it prints the command and stops rather than taking the operator's consent as given: --yes and
  # --accept-managed-runtime-ownership are never passed here.
  if ([Console]::IsInputRedirected) {
    Write-Output ''
    Write-Output 'No console input is attached, so setup was not run. Finish with:'
    Write-Output "  & '$bunBin' '$application' setup"
    exit 0
  }

  Write-Output ''
  Write-Output 'Running setup. It shows its plan and asks before changing anything.'
  # Run with the console attached rather than through `Invoke-Native`, which captures both streams to
  # files: setup is a conversation, and a captured conversation is a hang. The preference is lowered for
  # the duration so a native child's stderr is not turned into a terminating error, exactly as
  # `Invoke-Native` does it.
  $setupExit = -1
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $global:LASTEXITCODE = 0
    & $bunBin $application setup
    $setupExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($setupExit -ne 0) {
    Fail ("setup did not complete; the broker files are installed. Rerun: " +
      "& '$bunBin' '$application' setup")
  }

  # Setup has rewritten the service definition and restarted it against the new web root, so every other
  # version-stamped root beside it is now referenced by nothing. Before setup one of them could still be
  # the tree the running broker was serving, which is why this is here and not beside the install: a
  # failed setup stops above and leaves them alone.
  foreach ($superseded in (Get-SupersededWebRoot -InstallDir $installDir -Current $WEB_ROOT -OwnerSid $CURRENT_USER_SID)) {
    Remove-Item -LiteralPath $superseded -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $superseded) {
      Write-Output "Could not remove the superseded web client; remove it by hand: $superseded"
    } else {
      Write-Output "Removed the superseded web client: $superseded"
    }
  }

  # -------------------------------------------------------------------------------------------------
  # The pairing handoff.
  #
  # The client reads %COSYNCING_HOME%\client-pairing.json once at startup, imports it, and deletes it - so
  # the first launch after an all-in-one install is already paired with the broker beside it instead of
  # asking a user to retype a QR payload from one window into another. The offer is one-use and expires in
  # five minutes, exactly as `pair` prints it, so a file left behind by a client that never started is a
  # dead offer rather than a standing credential.
  # -------------------------------------------------------------------------------------------------

  $pairingPath = Join-Path $stateHome 'client-pairing.json'
  $handoffSkip = ''
  $listenerUrl = ''
  # No client on this host, so no offer is created. Writing one would burn a one-use pairing that expires
  # in five minutes and that nothing here can redeem, and leave it on disk looking like a credential.
  if (-not $clientLaunch) {
    Write-Output 'Pairing handoff: not needed, no desktop client was installed. Pair another device with:'
    Write-Output "  & '$bunBin' '$application' pair"
    exit 0
  }
  $status = Invoke-Native -FilePath $bunBin -ArgumentList @($application, 'status', '--json')
  if ($status.ExitCode -ne 0) {
    $handoffSkip = 'the broker did not report a listener URL'
  } else {
    try {
      $listenerUrl = [string] (Get-JsonProperty -Name 'url' `
        -Object (Get-JsonProperty -Object ($status.StdOut | ConvertFrom-Json) -Name 'listener'))
    } catch {
      $listenerUrl = ''
    }
    if ($listenerUrl -notmatch '^https?://') {
      $handoffSkip = 'the broker did not report a listener URL'
      $listenerUrl = ''
    }
  }
  if (-not $handoffSkip) {
    $offer = Invoke-Native -FilePath $bunBin `
      -ArgumentList @($application, 'pair', '--json', '--broker-url', $listenerUrl)
    if ($offer.ExitCode -ne 0) {
      $handoffSkip = 'the broker did not issue a pairing offer'
    } else {
      $parsed = $null
      try { $parsed = $offer.StdOut | ConvertFrom-Json } catch { $parsed = $null }
      $qr = [string] (Get-JsonProperty -Object $parsed -Name 'qr')
      $brokerUrl = [string] (Get-JsonProperty -Object $parsed -Name 'brokerUrl')
      $expiresAt = [string] (Get-JsonProperty -Object $parsed -Name 'expiresAt')
      if (-not $qr -or -not $brokerUrl -or -not $expiresAt) {
        $handoffSkip = 'the pairing offer could not be read'
      } else {
        # ConvertTo-Json rather than hand-built text: the QR payload is opaque and must reach the client
        # byte for byte, and a serializer is the thing that gets its escaping right. Newlines normalised
        # to LF and no byte-order mark, so a handoff file is the same bytes on every host.
        $document = ([pscustomobject] @{
          schemaVersion = 1
          qr = $qr
          brokerUrl = $brokerUrl
          expiresAt = $expiresAt
        } | ConvertTo-Json) -replace "`r`n", "`n"
        $stagedPairing = New-StagingPath -Parent $stateHome -Prefix '.client-pairing.'
        [IO.File]::WriteAllText($stagedPairing, "$document`n", (New-Object Text.UTF8Encoding $false))
        Set-OwnerOnlySecurity -Path $stagedPairing -Kind 'file'
        Move-Item -LiteralPath $stagedPairing -Destination $pairingPath -Force
        Write-Output "Pairing handoff: $pairingPath (one-use, expires in five minutes)"
      }
    }
  }
  if ($handoffSkip) {
    Write-Output "Pairing handoff: skipped - $handoffSkip. Pair by hand with:"
    Write-Output "  & '$bunBin' '$application' pair"
  }

  try {
    Start-Process -FilePath $clientLaunch -WorkingDirectory $CLIENT_ROOT | Out-Null
    Write-Output "Launched $clientLaunch"
  } catch {
    Write-Output "Could not launch $clientLaunch; start it from $CLIENT_ROOT."
  }
} catch {
  [Console]::Error.WriteLine("cosyncing install: $($_.Exception.Message)")
  # `exit` still runs the `finally` below, so the scratch directory and any half-placed staging path are
  # removed on the failure path exactly as they are on the success path.
  exit 1
} finally {
  Invoke-InstallCleanup
}
