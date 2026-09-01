<#
.SYNOPSIS
Remove one staged Phase 6 run root, and prove it is gone.

.DESCRIPTION
`cmd.exe /c "rd /s /q \"$path\""` cannot be called across the WSL boundary. WSL rebuilds a command
line from argv and escapes the inner quotes as \", which cmd does not unescape, so `rd` receives a
path it cannot parse — and answers "The filename, directory name, or volume label syntax is
incorrect" while still exiting 0. The caller's `|| rm -rf` fallback therefore never fired and the
cleanup silently deleted nothing for as long as it existed. A parameter bound by PowerShell crosses
the boundary intact, which is how the runner already receives its paths.

Exits non-zero if the tree is still there afterwards. A delete that reports success without
deleting is the entire defect above, and it is worth failing loudly to avoid repeating.
#>
param(
  [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = 'Stop'

# Defence in depth for a recursive delete. The caller checks this too; a second check here means the
# script cannot be repurposed against an arbitrary path by a future caller that forgets.
$leaf = Split-Path -Leaf $Path
$parent = Split-Path -Leaf (Split-Path -Parent $Path)
if ($parent -ne 'CosyncingPhase6' -or [string]::IsNullOrWhiteSpace($leaf)) {
  Write-Error "Refusing to remove a path outside a Phase 6 run root: $Path"
  exit 2
}
if (-not (Test-Path -LiteralPath $Path)) { exit 0 }

# Bounded retry. A recursive delete on Windows loses to whoever happens to hold a handle at that
# instant — an indexer, a scanner, a child that has been signalled and has not finished dying — and
# those clear on their own in well under a second. Three attempts, because the cleanup runs in CI
# where nobody is watching, and a run root left behind accumulates on the runner until it fills.
$lastError = $null
foreach ($attempt in 1..3) {
  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
  } catch {
    $lastError = $_.Exception.Message
  }
  if (-not (Test-Path -LiteralPath $Path)) { exit 0 }
  if ($attempt -lt 3) { Start-Sleep -Milliseconds 500 }
}
Write-Error "Phase 6 run root survived removal: $Path`n$lastError"
exit 1
