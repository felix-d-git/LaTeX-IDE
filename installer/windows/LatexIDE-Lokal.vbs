' SPDX-License-Identifier: AGPL-3.0-only
' SPDX-FileCopyrightText: 2026 felix-d-git and LaTeX-IDE contributors
' 100 % lokal (Installer-Option "Nur dieser Rechner"): Server ohne sichtbares Fenster,
' ohne Anmeldung, nur 127.0.0.1. Der Server oeffnet selbst den Browser mit dem
' zufaelligen Start-Schluessel (?k=, #163) und beendet sich, sobald kein
' Browserfenster mehr verbunden ist. Ein zweiter Start oeffnet nur den Browser.
' Mit Electron-Laufzeit (#212) startet stattdessen die Desktop-App im eigenen Fenster
' (desktop/main.js, ohne Server-Adresse = lokaler Modus, Datei-Argument wird durchgereicht).
' ponytail: VBScript ist in Windows abgekuendigt (Feature on Demand) - bei Wegfall
' durch einen kleinen Starter (z. B. node.exe mit eigenem Subsystem-Flag) ersetzen.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set env = sh.Environment("Process")
lad = env("LOCALAPPDATA")
env("PATH") = appDir & "\node;" & lad & "\LatexIDE\texlive\2025\bin\windows;" & env("PATH")
sh.CurrentDirectory = appDir
electron = appDir & "\electron-runtime\electron.exe"
If fso.FileExists(electron) Then
  args = ""
  For Each a In WScript.Arguments
    args = args & " """ & a & """"
  Next
  ' lokaler Modus: Daten wie bisher unter local-data, keine Server-Adresse
  env("REMOTE_URL") = ""
  env("LATEX_IDE_DATA") = lad & "\LatexIDE\local-data"
  env("UPDATE_MODE") = "off"
  sh.Run """" & electron & """ """ & appDir & "\desktop""" & args, 1, False
Else
  env("LOCAL_MODE") = "1"
  If env("PORT") = "" Then env("PORT") = "3077"
  env("DATA_DIR") = lad & "\LatexIDE\local-data"
  env("UPDATE_MODE") = "off"
  sh.Run """" & appDir & "\node\node.exe"" """ & appDir & "\server\index.js""", 0, False
End If
