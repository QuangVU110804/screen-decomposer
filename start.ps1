$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$port = if ($env:IMAGE_PORT) { $env:IMAGE_PORT } else { '3000' }
$url = "http://127.0.0.1:$port"

function Test-App {
    try { (Invoke-RestMethod "$url/health" -TimeoutSec 2).app -eq 'image-elements' } catch { $false }
}

if (Test-App) {
    Write-Host "Ứng dụng đã chạy sẵn: $url"
    Start-Process $url
    exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Chưa có Node.js >= 22.13. Cài bản LTS từ https://nodejs.org rồi chạy lại.'
}
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if ($LASTEXITCODE -ne 0) { throw "Node.js $(node --version) quá cũ; cần >= 22.13." }

if (-not (Test-Path -LiteralPath 'node_modules')) {
    Write-Host 'Cài thư viện Node (npm ci)...'
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci thất bại.' }
}

node scripts/doctor.js *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Cài engine Python và model lần đầu: cần Internet, vài GB trống, có thể mất 10-30 phút...'
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-local.ps1
    if ($LASTEXITCODE -ne 0) { throw 'Cài engine thất bại; xem lỗi phía trên.' }
}

# Open the browser once the server answers, without blocking the server output here.
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command',
    "for (`$i = 0; `$i -lt 120; `$i++) { try { Invoke-RestMethod '$url/health' -TimeoutSec 1 | Out-Null; Start-Process '$url'; break } catch { Start-Sleep 1 } }"
Write-Host "Mở $url — đóng cửa sổ này hoặc bấm Ctrl+C để tắt ứng dụng."
npm.cmd start
if ($LASTEXITCODE -ne 0) { throw "Ứng dụng dừng với lỗi. Nếu cổng $port đang bận, đặt IMAGE_PORT khác rồi chạy lại." }
