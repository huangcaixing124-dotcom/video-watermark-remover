$d = [Environment]::GetFolderPath('Desktop')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut("$d\wm-tools.lnk")
$s.TargetPath = "F:\去水印视频工具\server\tools.bat"
$s.WorkingDirectory = "F:\去水印视频工具\server"
$s.WindowStyle = 1
$s.Save()
Write-Host "done"