# SeekDB Windows 启动脚本（需管理员权限）
# 用法: 右键 -> 以管理员身份运行 PowerShell -> .\scripts\start-seekdb.ps1
# 可选参数: -BinDir <seekdb bin 目录> -ServiceName <服务名>
# 也可以用 Docker 跑 seekdb，见 README 的 Docker 章节（Windows 上更省事）。

param(
    [string]$ServiceName = "seekdb",
    [string]$BinDir = ""
)

function Test-Exists([string]$p) { return $p -and (Test-Path $p) }

# 自动探测安装目录：参数 > 环境变量 > 常见安装路径 > PATH
if (-not $BinDir) {
    $candidates = @(
        $env:SEEKDB_BIN,
        "C:\Program Files\seekdb\bin",
        "D:\seekdb\app\bin"
    ) | Where-Object { $_ -and (Test-Exists (Join-Path $_ "seekdb.exe")) }
    if ($candidates.Count -gt 0) {
        $BinDir = $candidates[0]
    } else {
        $cmd = Get-Command seekdb.exe -ErrorAction SilentlyContinue
        if ($cmd) { $BinDir = Split-Path $cmd.Source -Parent }
    }
}

$SeekdbExe = if ($BinDir) { Join-Path $BinDir "seekdb.exe" } else { "" }
$ManageScript = if ($BinDir) { Join-Path $BinDir "seekdb_manage.ps1" } else { "" }

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
if (-not $BinDir -or -not (Test-Exists $SeekdbExe)) {
    Write-Err "未找到 seekdb.exe。已尝试：参数 -BinDir / 环境变量 SEEKDB_BIN / C:\Program Files\seekdb\bin / D:\seekdb\app\bin / PATH"
    Write-Err "请确认已安装 seekdb，或改用 Docker（见 README）："
    Write-Err '  docker run -d --name seekvec-seekdb -p 2882:2881 -v seekvec_seekdb-data:/var/lib/seekdb quay.io/oceanbase/seekdb@sha256:4db4961869d554313520d6081fca29265ba6da6db7313311bd8acbed771a956b'
    exit 1
}

# 检查服务是否已安装
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if (-not $svc) {
    Write-Log "服务 '$ServiceName' 未安装，正在初始化并注册服务..."
    if (-not (Test-Exists $ManageScript)) {
        Write-Err "找不到 $ManageScript，无法初始化服务。"
        exit 1
    }
    & $ManageScript install
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

if (-not $svc) {
    Write-Err "服务 '$ServiceName' 注册失败。"
    exit 1
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
    Write-Ok "端口 2881 就绪，可以运行 npm run dev（或 SEEKDB_PORT=2882 连接 Docker 实例）"
} else {
    Write-Err "服务已启动但端口 2881 未就绪，请稍等几秒后重试。"
}
