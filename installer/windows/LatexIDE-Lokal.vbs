' 100 % lokal (Installer-Option "Nur dieser Rechner"): Server ohne sichtbares Fenster,
' ohne Anmeldung, nur 127.0.0.1. Oeffnet selbst den Browser und beendet sich,
' sobald kein Browserfenster mehr verbunden ist.
' ponytail: VBScript ist in Windows abgekuendigt (Feature on Demand) - bei Wegfall
' durch einen kleinen Starter (z. B. node.exe mit eigenem Subsystem-Flag) ersetzen.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set env = sh.Environment("Process")
lad = env("LOCALAPPDATA")
env("PATH") = appDir & "\node;" & lad & "\LatexIDE\texlive\2025\bin\windows;" & env("PATH")
env("LOCAL_MODE") = "1"
If env("PORT") = "" Then env("PORT") = "3077"
env("DATA_DIR") = lad & "\LatexIDE\local-data"
env("UPDATE_MODE") = "off"
sh.CurrentDirectory = appDir
sh.Run """" & appDir & "\node\node.exe"" """ & appDir & "\server\index.js""", 0, False
