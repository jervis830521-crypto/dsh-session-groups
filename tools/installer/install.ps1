# dsh-session-groups 一键安装/更新脚本
# 用法：双击 install.cmd（等价于 powershell -File install.ps1）
#       或命令行：install.ps1 [check|update|install]（缺省 = 自动：未装则装，已装则查更）
# 姿态：A) 未安装 -> 全新安装；B) 已安装 -> 有新版则原位覆盖更新（junction 不动）；C) 已最新 -> 退出
# 适用于任何 Windows 电脑，无需 git / node / 构建环境，只需要 PowerShell 5.1+ 和网络。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------- 可调参数 ----------
$Repo          = 'jervis830521-crypto/dsh-session-groups'   # GitHub 仓库
$PluginName    = 'dsh-session-groups'                        # 包名 / bundles 名 / junction 名
$InstallRoot   = 'E:\dsh-plugins'                            # 成品安置根目录（tgz 解压到这里）
$ProfileName   = 'web'                                       # 目标 dsh profile
$DshHome       = Join-Path $env:USERPROFILE '.dsh'           # dsh 数据目录（一般不用改）
# --------------------------------

$ProfileDir    = Join-Path $DshHome "profiles\$ProfileName"
$ProfilePkg    = Join-Path $ProfileDir 'package.json'
$NodeModules   = Join-Path $ProfileDir 'node_modules'
$JunctionPath  = Join-Path $NodeModules $PluginName
$InstallDir    = Join-Path $InstallRoot $PluginName

function Write-Step($msg) { Write-Host "== $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "   $msg" -ForegroundColor Yellow }
function Die($msg)        { Write-Host "!! $msg" -ForegroundColor Red; exit 1 }

# ---------- GitHub API：取最新 Release ----------
function Get-LatestRelease {
    $headers = @{ 'User-Agent' = 'dsh-session-groups-installer'; 'Accept' = 'application/vnd.github+json' }
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers -TimeoutSec 30
    $asset = $release.assets | Where-Object { $_.name -eq "$PluginName-$($release.tag_name.TrimStart('v')).tgz" } | Select-Object -First 1
    if (-not $asset) { Die "Release $($release.tag_name) 里没有找到 $PluginName 的 tgz 附件" }
    [pscustomobject]@{
        Version = $release.tag_name.TrimStart('v')
        Url     = $asset.browser_download_url
        Size    = $asset.size
        Digest  = if ($asset.digest -match '^sha256:([0-9a-f]{64})$') { $Matches[1] } else { $null }
    }
}

# ---------- 读本地已装版本 ----------
function Get-InstalledVersion {
    if (Test-Path (Join-Path $InstallDir 'package.json')) {
        try { return (Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version } catch { return $null }
    }
    return $null
}

function Test-Installed {
    # 已安装 = profile 里有它的装配痕迹（junction 或 manifest 条目）
    $inManifest = $false
    if (Test-Path $ProfilePkg) {
        try { $inManifest = ((Get-Content $ProfilePkg -Raw | ConvertFrom-Json).dsh.profile.bundles) -contains $PluginName } catch {}
    }
    return (Test-Path $JunctionPath) -or $inManifest
}

# ---------- 下载 + 校验 + 解压到 InstallDir ----------
function Install-Artifact($release) {
    $tmp = Join-Path $env:TEMP "$PluginName-$($release.Version)-download"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null

    Write-Step "下载 $($release.Url)"
    $tgz = Join-Path $tmp "$PluginName-$($release.Version).tgz"
    Invoke-WebRequest -Uri $release.Url -OutFile $tgz -UseBasicParsing -TimeoutSec 300

    if ($release.Digest) {
        $actual = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $release.Digest) { Die "SHA256 校验失败：期望 $($release.Digest)，实际 $actual" }
        Write-Ok "SHA256 校验通过"
    } else {
        Write-Warn2 "（Release 未提供 digest，跳过哈希校验）"
    }

    # 更新前备份（.bak 一份，失败可手工回滚）
    if (Test-Path $InstallDir) {
        $bak = "$InstallDir.bak"
        if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
        Copy-Item $InstallDir $bak -Recurse -Force
        Write-Ok "已备份旧版到 $bak"
    }

    Write-Step "解压到 $InstallDir"
    tar -xzf $tgz -C $tmp
    $pkg = Join-Path $tmp 'package'
    if (-not (Test-Path (Join-Path $pkg 'package.json'))) { Die "解压结果里没有 package.json（包损坏？）" }

    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
    if (-not (Test-Path $InstallRoot)) { New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null }
    Move-Item $pkg $InstallDir
    Remove-Item $tmp -Recurse -Force
    Write-Ok "成品就位：$InstallDir"
}

# ---------- 装配：profile manifest 两处 + junction ----------
function Register-Plugin {
    Write-Step "装配进 dsh profile '$ProfileName'"
    if (-not (Test-Path $ProfilePkg)) { Die "找不到 $ProfilePkg —— 这台电脑装过 dsh 吗？profile 名对吗？" }

    $json = Get-Content $ProfilePkg -Raw
    $obj  = $json | ConvertFrom-Json

    # 1) dependencies.link
    if (-not $obj.dependencies.PSObject.Properties[$PluginName]) {
        $obj.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue "link:$($InstallDir -replace '\\','/')"
        Write-Ok "dependencies 已加 link 条目"
    } else {
        $old = $obj.dependencies.$PluginName
        $obj.dependencies.$PluginName = "link:$($InstallDir -replace '\\','/')"
        if ($old -ne $obj.dependencies.$PluginName) { Write-Ok "dependencies.link 已更新（原：$old）" } else { Write-Ok "dependencies.link 已正确" }
    }

    # 2) bundles 数组
    if (-not $obj.dsh.profile.bundles -contains $PluginName) {
        $obj.dsh.profile.bundles += $PluginName
        Write-Ok "bundles 已加 $PluginName"
    } else {
        Write-Ok "bundles 已包含 $PluginName"
    }

    # 改前备份一份；写回必须无 BOM UTF-8（Node 读 JSON 对 BOM 敏感）
    Copy-Item $ProfilePkg "$ProfilePkg.installer-bak" -Force
    $out = $obj | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($ProfilePkg, $out, [System.Text.UTF8Encoding]::new($false))
    Write-Ok "manifest 已写回（备份：package.json.installer-bak）"

    # 3) junction：存在但指向旧位置也要重建
    $wantTarget = $InstallDir.TrimEnd('\')
    if (Test-Path $JunctionPath) {
        $cur = @((Get-Item $JunctionPath -Force).Target) | Where-Object { $_ } | Select-Object -First 1
        if ($cur -and ($cur.TrimEnd('\') -ieq $wantTarget)) {
            Write-Ok "junction 已正确指向 $InstallDir"
        } else {
            cmd /c rmdir "$JunctionPath"
            New-Item -ItemType Junction -Path $JunctionPath -Target $InstallDir | Out-Null
            Write-Ok "junction 已重建（原指向 $cur）-> $InstallDir"
        }
    } else {
        if (-not (Test-Path $NodeModules)) { New-Item -ItemType Directory -Path $NodeModules -Force | Out-Null }
        New-Item -ItemType Junction -Path $JunctionPath -Target $InstallDir | Out-Null
        Write-Ok "junction 已建：$JunctionPath -> $InstallDir"
    }
}

function Unregister-Plugin {
    # 只拆装配不删文件：profile manifest + bundles + junction
    if (Test-Path $ProfilePkg) {
        $obj = Get-Content $ProfilePkg -Raw | ConvertFrom-Json
        if ($obj.dependencies.PSObject.Properties[$PluginName]) { $obj.dependencies.PSObject.Properties.Remove($PluginName) }
        $obj.dsh.profile.bundles = @($obj.dsh.profile.bundles | Where-Object { $_ -ne $PluginName })
        $out = $obj | ConvertTo-Json -Depth 20
        [System.IO.File]::WriteAllText($ProfilePkg, $out, [System.Text.UTF8Encoding]::new($false))
    }
    if (Test-Path $JunctionPath) { cmd /c rmdir "$JunctionPath" }
    Write-Ok "已从 profile '$ProfileName' 拆除（成品文件保留在 $InstallDir）"
}

# ---------- 主流程 ----------
$mode = if ($args.Count -gt 0) { $args[0] } else { 'auto' }

if ($mode -eq 'uninstall') { Unregister-Plugin; exit 0 }

Write-Step "查询 GitHub 最新 Release（$Repo）"
$latest = Get-LatestRelease
Write-Ok "最新版 v$($latest.Version)"

$installedVer = Get-InstalledVersion

if ($mode -eq 'check') {
    if ($installedVer) {
        if ($installedVer -eq $latest.Version) { Write-Host "已是最新（v$installedVer）" -ForegroundColor Green }
        else { Write-Host "有更新：本地 v$installedVer -> 远程 v$($latest.Version)" -ForegroundColor Yellow }
    } else {
        Write-Host "本机未安装（成品目录 $InstallDir 不存在）" -ForegroundColor Yellow
    }
    exit 0
}

$installed = Test-Installed

if (-not $installed) {
    Write-Step "本机未安装 -> 全新安装 v$($latest.Version)"
    Install-Artifact $latest
    Register-Plugin
    Write-Host ""
    Write-Host "安装完成！请重启 dsh 使插件生效。" -ForegroundColor Green
    exit 0
}

# 已安装：对比版本
if ($installedVer -eq $latest.Version) {
    Write-Host "已是最新 v$installedVer，无需更新。" -ForegroundColor Green
    exit 0
}

Write-Step "更新：v$installedVer -> v$($latest.Version)"
Install-Artifact $latest
# junction/manifest 已在，无需重复装配；但校验一遍防手欠删过
Register-Plugin
Write-Host ""
Write-Host "更新完成！请重启 dsh 使新版本生效。" -ForegroundColor Green
