# Windows 构建脚本（PowerShell）—— 生产默认用标准 Go
# 用法: powershell -ExecutionPolicy Bypass -File scripts/build.ps1
# 体积优先可装 TinyGo 后跑 `tinygo build -target wasm -no-debug -o extension/wasm/matcher.wasm ./wasm`

$ErrorActionPreference = 'Stop'

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    Write-Error "未找到 go，请先安装: https://go.dev/dl/"
}

$goRoot = (& go env GOROOT).Trim()
Write-Host "GOROOT = $goRoot"

$env:GOOS = "js"
$env:GOARCH = "wasm"
go build -o extension/wasm/matcher.wasm ./wasm
Copy-Item "$goRoot/lib/wasm/wasm_exec.js" extension/wasm/wasm_exec.js -Force

$size = (Get-Item extension/wasm/matcher.wasm).Length / 1KB
Write-Host ("构建完成: extension/wasm/matcher.wasm ({0:N0} KB)" -f $size)
