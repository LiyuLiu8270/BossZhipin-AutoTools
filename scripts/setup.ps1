param([string]$Python = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    & node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 24 or newer is required.' }
    $pythonArgs = @()
    if ($Python) {
        if (!(Test-Path -LiteralPath $Python -PathType Leaf)) { throw 'Python executable not found.' }
        $pythonCommand = (Resolve-Path -LiteralPath $Python).Path
    } elseif (Get-Command py.exe -ErrorAction SilentlyContinue) {
        $pythonCommand = 'py.exe'; $pythonArgs = @('-3')
    } elseif (Get-Command python.exe -ErrorAction SilentlyContinue) {
        $pythonCommand = 'python.exe'
    } else { throw 'Install Python 3.10+ or pass -Python with an absolute executable path.' }
    & $pythonCommand @pythonArgs -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.10 or newer is required.' }
    $venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
    if (!(Test-Path -LiteralPath $venvPython)) {
        & $pythonCommand @pythonArgs -m venv (Join-Path $projectRoot '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
    }
    & $venvPython -m pip install --disable-pip-version-check -r (Join-Path $projectRoot 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check network access and retry setup.' }
    & (Join-Path $PSScriptRoot 'build-desktop.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
    & node scripts/doctor.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Required runtime checks failed.' }
    Write-Output 'Setup complete. Run npm start, or npm run serve for foreground diagnostics.'
} finally { Pop-Location }
