# SeekDB Windows 启动脚本（需管理员权限）
# 用法: 右键 -> 以管理员身份运行 PowerShell -> .\scripts\start-seekdb.ps1

param(
    [string]$ServiceName = "seekdb",
    [string]$BinDir = "C:\Program Files\seekdb\bin"
)

$SeekdbExe = Join-Path $BinDir "seekdb.exe"
$ManageScript = Join-Path $BinDir "seekdb_manage.ps1"

function Write-Log { param([string]$msg) Write-Host "[seekdb] $msg" }
function Write-Err  { param([string]$msg) Write-Host "[seekdb][ERROR] $msg" -ForegroundColor Red }
function Write-Ok   { param([string]$msg) Write-Host "[seekdb] $msg" -ForegroundColor Green }

# 检查管理员权限
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err "需要管理员权限。请右键 -> 以管理员身份运行 PowerShell。"
    exit 1
}

# 检查 seekdb 是否安装
if (-not (Test-Path $SeekdbExe)) {
    Write-Err "seekdb 未安装。请先运行 MSI 安装包。"
    Write-Err "下载: https://github.com/oceanbase/seekdb/releases/download/v1.3.0/seekdb-1.3.0.0-100000092026051510-win64.msi"
    exit 1
}

# 检查服务是否已安装
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if (-not $svc) {
    Write-Log "服务 '$ServiceName' 未安装，正在初始化并注册服务..."
    & $ManageScript install
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

if ($svc.Status -eq "Running") {
    Write-Log "服务 '$ServiceName' 已在运行（PID: $(Get-CimInstance Win32_Service -Filter ""Name='$ServiceName'"" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId)）。"
} else {
    Write-Log "启动服务 '$ServiceName'..."
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 3
    $newSvc = Get-Service -Name $ServiceName
    if ($newSvc.Status -eq "Running") {
        Write-Ok "服务 '$ServiceName' 启动成功。"
    } else {
        Write-Err "服务 '$ServiceName' 启动失败（状态: $($newSvc.Status)）。"
        exit 1
    }
}

# 验证端口
$portOk = Test-NetConnection 127.0.0.1 -Port 2881 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($portOk) {
    Write-Ok "端口 2881 就绪，可以运行 npm run dev"
} else {
    Write-Err "服务已启动但端口 2881 未就绪，请稍等几秒后重试。"
}
