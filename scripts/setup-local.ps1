$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$python = Join-Path $projectRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    # The dependency lock is tested on 64-bit 3.10/3.11; `python` alone may be a newer default.
    $creator = $null
    foreach ($candidate in @(@('py', '-3.11'), @('py', '-3.10'), @('python'))) {
        $arguments = @($candidate | Select-Object -Skip 1)
        try { $version = & $candidate[0] @arguments -c "import struct,sys;print('%d.%d-%d' % (sys.version_info[0], sys.version_info[1], struct.calcsize('P')*8))" 2>$null } catch { continue }
        if ($LASTEXITCODE -eq 0 -and $version -in @('3.10-64', '3.11-64')) { $creator = $candidate; break }
    }
    if (-not $creator) { throw 'Cần Python 3.10 hoặc 3.11 bản 64-bit: https://www.python.org/downloads/' }
    $arguments = @($creator | Select-Object -Skip 1)
    & $creator[0] @arguments -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Không tạo được venv. Cần Python 3.10 hoặc 3.11.' }
}
New-Item -ItemType Directory -Force -Path 'temp', 'models' | Out-Null
$lockOptions = @()
if (Test-Path -LiteralPath 'requirements-local.lock.txt') { $lockOptions = @('-c', 'requirements-local.lock.txt') }
& $python -m pip install --upgrade pip --no-cache-dir
if ($LASTEXITCODE -ne 0) { throw 'Không cập nhật được pip.' }
& $python -m pip install 'torch==2.5.1+cpu' 'torchvision==0.20.1+cpu' 'numpy==1.26.4' 'Pillow==11.3.0' --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple --no-cache-dir @lockOptions
if ($LASTEXITCODE -ne 0) { throw 'Không cài được PyTorch CPU.' }
& $python -m pip install -r requirements-local.txt --no-cache-dir @lockOptions
if ($LASTEXITCODE -ne 0) { throw 'Không cài được dependencies local.' }
$revision = 'f706ad9c4eb7f219c00d9050e46328518ffb65d2'
$archive = Join-Path 'temp' "mobilesam-$([guid]::NewGuid()).zip"
$archiveHash = 'BDCD4F3FA3B906D502439F6694A5E29B3FAAF3F3A768D1C2F4633E0C7E71C4E9'
try {
    Invoke-WebRequest "https://github.com/ChaoningZhang/MobileSAM/archive/$revision.zip" -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $archiveHash) { throw 'MobileSAM source checksum không khớp.' }
    & $python -m pip install --no-deps $archive --no-cache-dir
    if ($LASTEXITCODE -ne 0) { throw 'Không cài được MobileSAM.' }
} finally {
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
}
$weights = 'models/mobile_sam.pt'
$weightHash = '6DBB90523A35330FEDD7F1D3DFC66F995213D81B29A5CA8108DBCDD4E37D6C2F'
if (-not (Test-Path -LiteralPath $weights) -or (Get-FileHash -LiteralPath $weights -Algorithm SHA256).Hash -ne $weightHash) {
    Invoke-WebRequest "https://raw.githubusercontent.com/ChaoningZhang/MobileSAM/$revision/weights/mobile_sam.pt" -OutFile "$weights.download"
    if ((Get-FileHash -LiteralPath "$weights.download" -Algorithm SHA256).Hash -ne $weightHash) { throw 'MobileSAM weight checksum không khớp.' }
    Move-Item -LiteralPath "$weights.download" -Destination $weights -Force
}
& $python scripts/prepare-models.py
if ($LASTEXITCODE -ne 0) { throw 'Không chuẩn bị được OCR models.' }
& $python scripts/trim-local-runtime.py
if ($LASTEXITCODE -ne 0) { throw 'Không thu gọn được bộ cài PyTorch CPU.' }
node scripts/doctor.js
if ($LASTEXITCODE -ne 0) { throw 'Engine chưa vượt qua doctor check.' }
Write-Output 'Setup xong. Chạy npm start. Các lượt quét tiếp theo hoạt động offline, không cần API key.'
