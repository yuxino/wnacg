[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $ArtifactRoot,

  [Parameter(Mandatory = $true)]
  [ValidateSet('X64', 'ARM64')]
  [string] $ExpectedRunnerArchitecture,

  [switch] $SkipPortableProbe
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-OnlyFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Root,

    [Parameter(Mandatory = $true)]
    [string] $Filter
  )

  $files = @(Get-ChildItem -LiteralPath $Root -Filter $Filter -File -Recurse)
  if ($files.Count -ne 1) {
    throw "Expected exactly one '$Filter' below '$Root', found $($files.Count)"
  }
  return $files[0]
}

function Get-PeMachine {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $stream = [System.IO.File]::OpenRead($Path)
  $reader = $null
  try {
    $reader = New-Object System.IO.BinaryReader($stream)
    if ($reader.ReadUInt16() -ne 0x5A4D) {
      throw "'$Path' is not a PE executable"
    }
    $stream.Position = 0x3C
    $peOffset = $reader.ReadInt32()
    if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) {
      throw "'$Path' has an invalid PE header offset"
    }
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) {
      throw "'$Path' has an invalid PE signature"
    }
    return $reader.ReadUInt16()
  } finally {
    if ($null -ne $reader) {
      $reader.Dispose()
    } else {
      $stream.Dispose()
    }
  }
}

function Assert-X64Pe {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $machine = Get-PeMachine -Path $Path
  if ($machine -ne 0x8664) {
    throw ("Expected an x64 PE file at '{0}', found machine 0x{1:X4}" -f $Path, $machine)
  }
}

function Assert-OcrPayload {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Directory
  )

  $requiredFiles = @(
    'manga_ocr_helper.exe',
    'onnxruntime.dll',
    'onnxruntime_providers_shared.dll',
    'MSVCP140.dll',
    'MSVCP140_1.dll',
    'VCRUNTIME140.dll',
    'VCRUNTIME140_1.dll'
  )
  foreach ($name in $requiredFiles) {
    $file = Get-Item -LiteralPath (Join-Path $Directory $name) -ErrorAction Stop
    if ($file.Length -le 0) {
      throw "OCR resource is empty: $name"
    }
  }
  foreach ($name in @('onnxruntime-LICENSE.txt', 'onnxruntime-ThirdPartyNotices.txt')) {
    $file = Get-Item -LiteralPath (Join-Path (Join-Path $Directory 'licenses') $name) -ErrorAction Stop
    if ($file.Length -le 0) {
      throw "OCR notice is empty: $name"
    }
  }
  Assert-X64Pe -Path (Join-Path $Directory 'manga_ocr_helper.exe')
}

function Assert-MsiPayload {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path
  )

  $installer = $null
  $summary = $null
  $database = $null
  $view = $null
  try {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    [object[]] $summaryArgs = @([string] $Path, [int] 0)
    $summary = $installer.GetType().InvokeMember(
      'SummaryInformation',
      [System.Reflection.BindingFlags]::GetProperty,
      $null,
      $installer,
      $summaryArgs
    )
    [object[]] $propertyArgs = @([int] 7)
    [string] $template = $summary.GetType().InvokeMember(
      'Property',
      [System.Reflection.BindingFlags]::GetProperty,
      $null,
      $summary,
      $propertyArgs
    )
    if ($template -notmatch '^x64;') {
      throw "MSI Template Summary must target x64, found '$template'"
    }

    $database = $installer.GetType().InvokeMember(
      'OpenDatabase',
      [System.Reflection.BindingFlags]::InvokeMethod,
      $null,
      $installer,
      @([string] $Path, [int] 0)
    )
    $view = $database.GetType().InvokeMember(
      'OpenView',
      [System.Reflection.BindingFlags]::InvokeMethod,
      $null,
      $database,
      @('SELECT `FileName` FROM `File`')
    )
    [void] $view.GetType().InvokeMember(
      'Execute',
      [System.Reflection.BindingFlags]::InvokeMethod,
      $null,
      $view,
      $null
    )
    $msiFileNames = @()
    while ($true) {
      $record = $view.GetType().InvokeMember(
        'Fetch',
        [System.Reflection.BindingFlags]::InvokeMethod,
        $null,
        $view,
        $null
      )
      if ($null -eq $record) {
        break
      }
      try {
        $fileName = $record.GetType().InvokeMember(
          'StringData',
          [System.Reflection.BindingFlags]::GetProperty,
          $null,
          $record,
          @([int] 1)
        )
        $msiFileNames += ($fileName -split '\|')[-1]
      } finally {
        if ([Runtime.InteropServices.Marshal]::IsComObject($record)) {
          [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
        }
      }
    }

    $requiredFiles = @(
      'manga_ocr_helper.exe',
      'onnxruntime.dll',
      'onnxruntime_providers_shared.dll',
      'MSVCP140.dll',
      'MSVCP140_1.dll',
      'VCRUNTIME140.dll',
      'VCRUNTIME140_1.dll',
      'onnxruntime-LICENSE.txt',
      'onnxruntime-ThirdPartyNotices.txt'
    )
    foreach ($name in $requiredFiles) {
      if ($msiFileNames -notcontains $name) {
        throw "MSI does not contain required OCR resource: $name"
      }
    }
  } finally {
    foreach ($comObject in @($view, $database, $summary, $installer)) {
      if ($null -ne $comObject -and [Runtime.InteropServices.Marshal]::IsComObject($comObject)) {
        [void] [Runtime.InteropServices.Marshal]::FinalReleaseComObject($comObject)
      }
    }
  }
}

function Test-OcrHelperStartup {
  param(
    [Parameter(Mandatory = $true)]
    [string] $HelperPath,

    [Parameter(Mandatory = $true)]
    [string] $WorkRoot
  )

  $stderrPath = Join-Path $WorkRoot 'ocr-helper.stderr'
  $previousModelsDir = [Environment]::GetEnvironmentVariable('WNACG_OCR_MODELS_DIR', 'Process')
  try {
    $missingModels = Join-Path $WorkRoot 'missing models'
    [Environment]::SetEnvironmentVariable('WNACG_OCR_MODELS_DIR', $missingModels, 'Process')
    $process = Start-Process -FilePath $HelperPath -NoNewWindow -Wait -PassThru -RedirectStandardError $stderrPath
    $process.Refresh()
    if ($process.ExitCode -ne 1) {
      throw "OCR helper dependency probe expected exit 1, found $($process.ExitCode)"
    }
    $stderr = [System.IO.File]::ReadAllText($stderrPath, [System.Text.Encoding]::UTF8)
    if ($stderr.IndexOf('comic-text-detector.onnx', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
      throw "OCR helper did not load its app-local runtime and reach model loading: $stderr"
    }
  } finally {
    [Environment]::SetEnvironmentVariable('WNACG_OCR_MODELS_DIR', $previousModelsDir, 'Process')
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Test-AppStartup {
  param(
    [Parameter(Mandatory = $true)]
    [string] $AppPath
  )

  $process = $null
  try {
    $process = Start-Process -FilePath $AppPath -WorkingDirectory (Split-Path -Parent $AppPath) -PassThru
    Start-Sleep -Seconds 8
    $process.Refresh()
    if ($process.HasExited) {
      throw "WNACG exited during the startup probe with code $($process.ExitCode): $AppPath"
    }
  } finally {
    if ($null -ne $process) {
      $process.Refresh()
      if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        [void] $process.WaitForExit(10000)
      }
      $process.Dispose()
    }
  }
}

function Invoke-NsisInstallSmoke {
  param(
    [Parameter(Mandatory = $true)]
    [string] $InstallerPath
  )

  $installRoot = Join-Path $env:LOCALAPPDATA 'wnacg'
  $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\wnacg'
  $modelRoot = Join-Path $env:LOCALAPPDATA 'com.yuxino.wnacg\ocr-models'
  $modelSentinel = Join-Path $modelRoot 'ci-preserve-after-uninstall.txt'
  if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $uninstallKey)) {
    throw "Refusing to replace a pre-existing WNACG installation at '$installRoot'"
  }
  if (Test-Path -LiteralPath $modelRoot) {
    throw "Refusing to replace a pre-existing WNACG model directory at '$modelRoot'"
  }

  New-Item -ItemType Directory -Path $modelRoot | Out-Null
  [System.IO.File]::WriteAllText($modelSentinel, 'preserve', [System.Text.Encoding]::ASCII)

  $installed = $false
  try {
    $installer = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', '/NS') -Wait -PassThru
    $installer.Refresh()
    if ($installer.ExitCode -ne 0) {
      throw "NSIS installer failed with exit code $($installer.ExitCode)"
    }
    $installed = $true

    $app = Join-Path $installRoot 'wnacg.exe'
    $ocr = Join-Path $installRoot 'ocr'
    $uninstaller = Join-Path $installRoot 'uninstall.exe'
    Get-Item -LiteralPath $app -ErrorAction Stop | Out-Null
    Get-Item -LiteralPath $uninstaller -ErrorAction Stop | Out-Null
    Assert-X64Pe -Path $app
    Assert-OcrPayload -Directory $ocr
    Test-OcrHelperStartup -HelperPath (Join-Path $ocr 'manga_ocr_helper.exe') -WorkRoot $env:RUNNER_TEMP
    Test-AppStartup -AppPath $app

    $installPrefix = $installRoot.TrimEnd('\') + '\'
    if ($modelRoot.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "OCR model storage must remain outside the uninstallable app directory: $modelRoot"
    }
  } finally {
    if ($installed) {
      $uninstaller = Join-Path $installRoot 'uninstall.exe'
      if (Test-Path -LiteralPath $uninstaller) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -PassThru
        $uninstall.Refresh()
        if ($uninstall.ExitCode -ne 0) {
          throw "NSIS uninstaller failed with exit code $($uninstall.ExitCode)"
        }
      }
      for ($attempt = 0; $attempt -lt 30 -and (Test-Path -LiteralPath (Join-Path $installRoot 'wnacg.exe')); $attempt++) {
        Start-Sleep -Milliseconds 500
      }
      if (Test-Path -LiteralPath (Join-Path $installRoot 'wnacg.exe')) {
        throw "NSIS uninstaller left the application executable behind: $installRoot"
      }
    }
    if (-not (Test-Path -LiteralPath $modelSentinel)) {
      throw "NSIS uninstall removed the isolated OCR model directory: $modelRoot"
    }
    Remove-Item -LiteralPath $modelSentinel -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $modelRoot -Force -ErrorAction SilentlyContinue
  }
}

$artifactDirectory = (Resolve-Path -LiteralPath $ArtifactRoot).Path
if ($PSVersionTable.PSVersion.Major -ne 5) {
  throw "This smoke test must run under Windows PowerShell 5.1, found $($PSVersionTable.PSVersion)"
}

$runnerArchitecture = $env:RUNNER_ARCH
if ([string]::IsNullOrWhiteSpace($runnerArchitecture)) {
  $runnerArchitecture = $env:PROCESSOR_ARCHITECTURE
}
if ($runnerArchitecture -ne $ExpectedRunnerArchitecture) {
  throw "Expected runner architecture $ExpectedRunnerArchitecture, found $runnerArchitecture"
}
if ($ExpectedRunnerArchitecture -eq 'ARM64') {
  $os = Get-CimInstance Win32_OperatingSystem
  if ($os.Caption -notmatch 'Windows 11') {
    throw "Expected Windows 11 for the ARM64 smoke test, found '$($os.Caption)'"
  }
}

$msi = Get-OnlyFile -Root $artifactDirectory -Filter '*.msi'
$nsis = Get-OnlyFile -Root $artifactDirectory -Filter '*_x64-setup.exe'
if ($msi.Name -notmatch '_x64(?:_.+)?\.msi$') {
  throw "Expected an x64 MSI, found $($msi.Name)"
}
Assert-MsiPayload -Path $msi.FullName

if (-not $SkipPortableProbe) {
  $sourceApp = Get-Item -LiteralPath (Join-Path $artifactDirectory 'wnacg.exe') -ErrorAction Stop
  $sourceOcr = Get-Item -LiteralPath (Join-Path $artifactDirectory 'ocr') -ErrorAction Stop
  Assert-X64Pe -Path $sourceApp.FullName
  Assert-OcrPayload -Directory $sourceOcr.FullName

  $unicode = ([char] 0x6D4B).ToString() + ([char] 0x8BD5).ToString()
  $probeRoot = Join-Path $env:RUNNER_TEMP ("WNACG path $unicode PS51")
  if (Test-Path -LiteralPath $probeRoot) {
    throw "Portable probe directory already exists: $probeRoot"
  }
  New-Item -ItemType Directory -Path $probeRoot | Out-Null
  try {
    Copy-Item -LiteralPath $sourceApp.FullName -Destination (Join-Path $probeRoot 'wnacg.exe')
    Copy-Item -LiteralPath $sourceOcr.FullName -Destination (Join-Path $probeRoot 'ocr') -Recurse
    Test-OcrHelperStartup -HelperPath (Join-Path $probeRoot 'ocr\manga_ocr_helper.exe') -WorkRoot $probeRoot
    Test-AppStartup -AppPath (Join-Path $probeRoot 'wnacg.exe')
  } finally {
    Remove-Item -LiteralPath $probeRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Invoke-NsisInstallSmoke -InstallerPath $nsis.FullName
Write-Host "Windows smoke passed: PowerShell $($PSVersionTable.PSVersion), runner $runnerArchitecture, x64 package install/start/OCR/uninstall"
