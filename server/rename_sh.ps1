$d = [Environment]::GetFolderPath('Desktop')
$old = "$d\wm-tools.lnk"
$new = "$d\去水印视频工具-控制台.lnk"
if (Test-Path $old) {
    Rename-Item $old $new
    Write-Host "Renamed"
} else {
    Write-Host "Not found"
}