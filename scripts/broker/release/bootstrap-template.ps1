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
# `powershell -ExecutionPolicy Bypass -c "irm <base>/install.ps1 | iex"`, which has no way to bind
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
Cross-check ONE artifact against all three statements of what it should be: the signed checksum list, the
signed manifest, and the digest baked into this script. Each of the three binds the NAME to the digest, so
agreement is about this artifact rather than about a digest appearing somewhere.
#>
function Assert-SignedArtifact {
  param(
    [Parameter(Mandatory = $true)] $Pin,
    [Parameter(Mandatory = $true)] $Manifest,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]] $ChecksumRows
  )
  $named = @($ChecksumRows | Where-Object { ($_ -split '\s+')[1] -eq $Pin.Name })
  if ($named.Count -gt 1) { Fail 'checksum list contains duplicate artifact rows' }
  if ($named.Count -eq 0) { Fail "artifact checksum is missing or malformed: $($Pin.Name)" }
  $signed = ($named[0] -split '\s+')[0]
  if ($signed -notmatch '^[0-9a-f]{64}$') {
    Fail "artifact checksum is missing or malformed: $($Pin.Name)"
  }
  $stated = New-Object System.Collections.ArrayList
  Get-ManifestDigestsFor -Node $Manifest -Name $Pin.Name -Found $stated
  if ($stated.Count -gt 1) { Fail "signed manifest names $($Pin.Name) more than once" }
  if ($stated.Count -eq 0) { Fail "signed manifest does not name $($Pin.Name)" }
  if ($stated[0] -ne $signed) { Fail "signed manifest and checksum list disagree about $($Pin.Name)" }
  # The signed chain and the baked-in table must name the same bytes, or one of the two was tampered with.
  if ($signed -ne $Pin.Sha256) {
    Fail "signed checksum list disagrees with the digest embedded in this installer for $($Pin.Name)"
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
function Test-ElevatedProcess {
  param([Parameter(Mandatory = $true)] $Identity)
  return (New-Object Security.Principal.WindowsPrincipal $Identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
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
  foreach ($path in @($StagedApplication, $StagedReceipt, $StagedWeb)) {
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
}

# ---------------------------------------------------------------------------------------------------
# Refusals, before any network.
# ---------------------------------------------------------------------------------------------------

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
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
      Fail 'existing application has no safe bootstrap ownership receipt'
    }
    if (Test-ReparsePoint -Item (Get-Item -LiteralPath $receiptPath -Force)) {
      Fail 'existing application has no safe bootstrap ownership receipt'
    }
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
  Write-Output 'PATH was not changed. Run setup with the absolute command:'
  Write-Output "  & '$bunBin' '$application' setup"
} catch {
  [Console]::Error.WriteLine("cosyncing install: $($_.Exception.Message)")
  # `exit` still runs the `finally` below, so the scratch directory and any half-placed staging path are
  # removed on the failure path exactly as they are on the success path.
  exit 1
} finally {
  Invoke-InstallCleanup
}
