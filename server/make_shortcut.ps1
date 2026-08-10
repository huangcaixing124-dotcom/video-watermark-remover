$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop "去水印视频工具 - 控制台.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "F:\去水印视频工具\server\tools.bat"
$shortcut.WorkingDirectory = "F:\去水印视频工具\server"
$shortcut.Description = "Video Watermark Remover - Management Console"
$shortcut.WindowStyle = 1
$shortcut.Save()
Write-Host "OK"