# Cập nhật TikTok Shop Clip Viewer (bản cài "Load unpacked") từ repo phát hành công khai
# github.com/peachyd351/tiktokshop-viewer-dist: đọc ban-moi.json, tải từng file vào thư mục tạm,
# kiểm SHA-256 từng file, đủ hết mới chép vào thư mục extension (manifest.json chép cuối).
# Chạy qua "Cập nhật.bat". Extension tự nhận ra manifest.json mới và tự khởi động lại.

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$base = "https://raw.githubusercontent.com/peachyd351/tiktokshop-viewer-dist/main"
$ext = Split-Path -Parent $PSScriptRoot
$tmp = $null

function Version([string]$v) { [version]($v -replace "[^\d.]", "") }

try {
    $local = Get-Content (Join-Path $ext "manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($local.name -ne "TikTok Shop Clip Viewer") { throw "Không thấy manifest.json của TTS Viewer trong $ext" }
    $info = Invoke-RestMethod "$base/ban-moi.json?t=$([DateTimeOffset]::Now.ToUnixTimeSeconds())" -UseBasicParsing
    Write-Host "Bản đang cài: $($local.version) | Bản mới nhất: $($info.version)"
    if ((Version $info.version) -le (Version $local.version)) {
        Write-Host "Đang dùng bản mới nhất, không cần cập nhật." -ForegroundColor Green
        exit 0
    }
    if ($info.notes) { Write-Host "`nCó gì mới:`n$($info.notes)`n" }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("tts-viewer-" + [guid]::NewGuid())
    New-Item -ItemType Directory $tmp | Out-Null
    $i = 0
    foreach ($f in $info.files) {
        $i++
        if ($f.path -split "/" -contains "..") { throw "Đường dẫn lạ trong bản cập nhật: $($f.path)" }
        Write-Host ("Tải {0}/{1}: {2}" -f $i, $info.files.Count, $f.path)
        $dest = Join-Path $tmp $f.path
        New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
        $url = "$base/files/" + (($f.path -split "/" | ForEach-Object { [uri]::EscapeDataString($_) }) -join "/")
        Invoke-WebRequest $url -OutFile $dest -UseBasicParsing
        if ((Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() -ne $f.sha256) { throw "File $($f.path) tải về bị lỗi (sai mã kiểm tra), thử lại sau." }
    }

    # Đủ và đúng hết mới chép; manifest.json cuối cùng để dừng giữa chừng thì Chrome vẫn nạp bản cũ.
    $paths = @($info.files.path | Where-Object { $_ -ne "manifest.json" }) + "manifest.json"
    foreach ($p in $paths) {
        $to = Join-Path $ext $p
        New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
        Copy-Item (Join-Path $tmp $p) $to -Force
    }
    Write-Host "`n✓ Đã cập nhật lên $($info.version). Extension sẽ tự khởi động lại trong ít giây." -ForegroundColor Green
    Write-Host "  (Nếu chưa thấy đổi: mở side panel hoặc vào chrome://extensions bấm tải lại.)"
} catch {
    Write-Host "`nLỗi: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Bản đang cài vẫn dùng được (manifest.json chỉ chép khi mọi file đã xong). Chạy lại sau ít phút."
    exit 1
} finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
