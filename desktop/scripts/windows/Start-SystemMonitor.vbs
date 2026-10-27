' Starts System Monitor without a console window. Lives in desktop\scripts\windows\.
Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
WshShell.Run "cmd /c npm start", 0, False
Set WshShell = Nothing
