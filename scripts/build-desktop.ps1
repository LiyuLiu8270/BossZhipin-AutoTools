$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler not found.' }
$outputDir = Join-Path $projectRoot 'artifacts\desktop'
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$source = Join-Path $projectRoot 'desktop\TrayApp.cs'
$bootstrap = Join-Path $outputDir 'icon-builder.exe'
$iconPath = Join-Path $outputDir 'xunxu.ico'
$references = @('/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll')
& $compiler /nologo /target:winexe /codepage:65001 /optimize+ "/out:$bootstrap" @references $source
if ($LASTEXITCODE -ne 0) { throw 'Icon builder compilation failed.' }
$iconProcess = Start-Process -FilePath $bootstrap -ArgumentList @('--write-icon', ('"' + $iconPath + '"')) -WindowStyle Hidden -PassThru -Wait
if ($iconProcess.ExitCode -ne 0 -or !(Test-Path -LiteralPath $iconPath)) { throw 'Icon generation failed.' }
# Unicode-safe output name even under Windows PowerShell 5 without UTF-8 BOM.
$appName = -join @([char]0x5FAA,[char]0x5E8F,[char]0x6C42,[char]0x804C,[char]0x52A9,[char]0x624B)
$target = Join-Path $projectRoot ($appName + '.exe')
& $compiler /nologo /target:winexe /codepage:65001 /optimize+ "/win32icon:$iconPath" "/out:$target" @references $source
if ($LASTEXITCODE -ne 0) { throw 'Desktop compilation failed. Exit the running tray app before rebuilding.' }
Write-Output "Built: $target"
