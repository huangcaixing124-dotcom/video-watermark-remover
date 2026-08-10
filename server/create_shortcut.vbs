Set objShell = CreateObject("WScript.Shell")
strDesktop = objShell.SpecialFolders("Desktop")
strShortcut = strDesktop & "\去水印视频工具 - 控制台.lnk"

Set objShortcut = objShell.CreateShortcut(strShortcut)
objShortcut.TargetPath = "F:\去水印视频工具\server\tools.bat"
objShortcut.WorkingDirectory = "F:\去水印视频工具\server"
objShortcut.Description = "去水印视频工具 - 管理控制台"
objShortcut.IconLocation = "F:\去水印视频工具\server\tools.bat, 0"
objShortcut.WindowStyle = 1  ' Normal window
objShortcut.Save

WScript.Echo "快捷方式已创建到桌面: 去水印视频工具 - 控制台"