# Windows 构建脚本（PowerShell）
# 用法: powershell -ExecutionPolicy Bypass -File scripts/build.ps1

$ErrorActionPreference = 'Stop'

if (-not (Get-Command tinygo -ErrorAction SilentlyContinue)) {
    Write-Error "未找到 tinygo，请先安装: winget install TinyGo.TinyGo"
}

$tinygoRoot = (& tinygo env TINYGOROOT).Trim()
Write-Host "TINYGOROOT = $tinygoRoot"

tinygo build -target wasm -no-debug -o extension/wasm/matcher.wasm ./wasm
Copy-Item "$tinygoRoot/targets/wasm_exec.js" extension/wasm/wasm_exec.js -Force

$size = (Get-Item extension/wasm/matcher.wasm).Length / 1KB
Write-Host ("构建完成: extension/wasm/matcher.wasm ({0:N0} KB)" -f $size)
