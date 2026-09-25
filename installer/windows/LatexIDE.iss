; Inno Setup 6 Skript fuer LatexIDE Desktop.
; Per-User-Installation ohne Admin-Rechte unter {localappdata}\Programs\LatexIDE.
; Baut auf dem Staging-Ordner installer\out\staging auf (siehe build-release.ps1).

#define MyAppName "LatexIDE"
#define MyAppVersion "0.1.0"
#define MyAppExeName "LatexIDE.cmd"
#define StagingDir "..\out\staging"

[Setup]
AppId={{8C9C6F8E-6A5B-4B2E-9E2A-6E7C6D3B7A11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\out
OutputBaseFilename=LatexIDE-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile=..\LICENSES-INSTALLER.txt
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Desktop-Verknuepfung anlegen"; GroupDescription: "Zusaetzliche Symbole:"; Flags: unchecked

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Excludes: "\node_modules\.cache\*"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; TeX Live Installation nach dem Kopieren der Dateien. Sichtbares Fenster,
; kann sehr lange dauern (mehrere Stunden). Bricht die Installation nicht ab,
; falls der Nutzer latexmk bereits im PATH hat (Skript prueft selbst).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-texlive.ps1"""; \
    WorkingDir: "{app}"; StatusMsg: "TeX Live wird installiert (kann mehrere Stunden dauern)..."; Flags: waituntilterminated

[UninstallDelete]
; Datenordner (LATEX_IDE_DATA) und TeX-Live-Installation werden bewusst NICHT
; geloescht - der Uninstaller entfernt nur die App-Dateien unter {app} und
; fragt dabei nichts nach (Standardverhalten von Inno Setup).
