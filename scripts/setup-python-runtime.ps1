# Setup embedded Python runtime bound to this project.
# Output: runtime/python/ (interpreter + pip + sympy)
$ErrorActionPreference = 'Stop'

$PyVer = '3.12.8'
$BaseUrl = "https://www.python.org/ftp/python/$PyVer"
$ZipUrl = "$BaseUrl/python-$PyVer-embed-amd64.zip"
$GetPipUrl = 'https://bootstrap.pypa.io/get-pip.py'

$Root = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $Root 'runtime\python'
$ZipPath = Join-Path $Root 'runtime\python-embed.zip'
$GetPipPath = Join-Path $Root 'runtime\get-pip.py'

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'runtime') | Out-Null

Write-Host "[1/5] Downloading Python $PyVer embed package..."
Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing

Write-Host "[2/5] Extracting to runtime/python ..."
if (Test-Path $RuntimeDir) { Remove-Item $RuntimeDir -Recurse -Force }
Expand-Archive -Path $ZipPath -DestinationPath $RuntimeDir -Force

Write-Host "[3/5] Enabling site-packages (_pth) ..."
$Pth = Get-ChildItem $RuntimeDir -Filter '*._pth' | Select-Object -First 1
if ($Pth) {
    $content = Get-Content $Pth.FullName
    $content = $content | ForEach-Object {
        if ($_ -match '^#\s*import site') { 'import site' } else { $_ }
    }
    if ($content -notmatch 'Lib\\site-packages') {
        $content += 'Lib\site-packages'
    }
    $content | Set-Content $Pth.FullName -Encoding ASCII
    Write-Host "    -> $($Pth.Name) updated"
} else {
    throw 'No _pth file found'
}

Write-Host "[4/5] Installing pip ..."
Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPipPath -UseBasicParsing
$PyExe = Join-Path $RuntimeDir 'python.exe'
& $PyExe $GetPipPath --no-warn-script-location 2>&1 | Out-Null

Write-Host "[5/5] Installing sympy / mpmath ..."
& $PyExe -m pip install --no-warn-script-location -q sympy 2>&1 | Select-Object -Last 3

Remove-Item $ZipPath, $GetPipPath -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Done! Verify:'
& $PyExe -c 'import sys; print("Python", sys.version.split()[0])'
& $PyExe -c 'import sympy; print("sympy", sympy.__version__)'
