param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$ReviewDirectory,
  [string]$Flutter = (Join-Path $env:USERPROFILE 'tools\flutter\bin\flutter.bat'),
  [string]$NuGetDirectory = 'C:\tools\nuget'
)
$ErrorActionPreference = 'Stop'
if (Test-Path $ReviewDirectory) { throw "Review directory already exists: $ReviewDirectory" }
if (-not (Test-Path $Flutter)) { throw "Missing Windows Flutter: $Flutter" }
if (-not (Test-Path (Join-Path $NuGetDirectory 'nuget.exe'))) { throw 'NuGet is required' }
New-Item -ItemType Directory -Path $ReviewDirectory | Out-Null
& tar.exe -xzf $Archive -C $ReviewDirectory
if ($LASTEXITCODE -ne 0) { throw 'Review snapshot extraction failed' }
$env:Path = "$NuGetDirectory;$env:Path"
$Version = (Get-Content (Join-Path $ReviewDirectory 'package.json') -Raw | ConvertFrom-Json).version
Push-Location (Join-Path $ReviewDirectory 'apps\client')
try {
  & $Flutter --version
  & $Flutter pub get
  if ($LASTEXITCODE -ne 0) { throw 'Flutter dependency resolution failed' }
  & $Flutter build windows --release "--dart-define=COSYNCING_CLIENT_VERSION=$Version"
  if ($LASTEXITCODE -ne 0) { throw 'Windows client build failed' }
} finally { Pop-Location }
$Release = Join-Path $ReviewDirectory 'apps\client\build\windows\x64\runner\Release'
$Executable = Join-Path $Release 'cosyncing.exe'
if ((Get-AuthenticodeSignature $Executable).Status -ne 'NotSigned') {
  throw 'Expected the unsigned review build'
}
Compress-Archive -Path (Join-Path $Release '*') -DestinationPath "$ReviewDirectory.zip"
Write-Output "Unsigned Windows review archive: $ReviewDirectory.zip"
