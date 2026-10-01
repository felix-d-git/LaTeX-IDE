; Inno Setup 6 Skript fuer LatexIDE Desktop.
; Per-User-Installation ohne Admin-Rechte unter {localappdata}\Programs\LatexIDE.
; Baut auf dem Staging-Ordner installer\out\staging auf (siehe build-release.ps1).
; Zwei Betriebsarten: Desktop-App (verbindet sich mit einem Server) oder eigener
; Server auf diesem Rechner. Ein vom Server heruntergeladenes Setup traegt dessen
; Adresse als 1024-Byte-Trailer "LATEXIDE-SERVER-URL=..." am Dateiende
; (server/lib/desktopAssets.js) - dann ist die Betriebsart Desktop und es wird nichts gefragt.

#define MyAppName "LatexIDE"
; Version kommt aus package.json (build-release.ps1 uebergibt /DMyAppVersion=...).
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
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

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Desktop-Verknuepfung anlegen"; GroupDescription: "Zusaetzliche Symbole:"; Flags: unchecked

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Excludes: "\node_modules\.cache\*"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{code:StarterExe}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{code:StarterExe}"; Tasks: desktopicon

[Run]
; Nach einem stillen Update (aus der App heraus) die App wieder starten.
Filename: "{app}\{code:StarterExe}"; Flags: nowait postinstall skipifnotsilent runhidden
; TeX Live Installation nach dem Kopieren der Dateien. Sichtbares Fenster,
; kann sehr lange dauern (mehrere Stunden). Bricht die Installation nicht ab,
; falls der Nutzer latexmk bereits im PATH hat (Skript prueft selbst).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-texlive.ps1"""; \
    WorkingDir: "{app}"; StatusMsg: "TeX Live wird installiert (kann mehrere Stunden dauern)..."; Flags: waituntilterminated
Filename: "{app}\{code:StarterExe}"; Description: "LatexIDE jetzt starten"; Flags: nowait postinstall skipifsilent runhidden

[Code]
var
  ModePage: TInputOptionWizardPage;
  UrlPage: TInputQueryWizardPage;
  AdminPage: TInputQueryWizardPage;
  LocalDirPage: TInputDirWizardPage;
  TrailerUrl: String;

// Server-Adresse, die der Server beim Download ans Setup angehaengt hat ('' = Setup direkt von GitHub).
function ReadTrailerUrl: String;
var
  F: TFileStream;
  S: AnsiString;
begin
  Result := '';
  F := TFileStream.Create(ExpandConstant('{srcexe}'), fmOpenRead or fmShareDenyNone);
  try
    if F.Size < 1024 then Exit;
    F.Seek(F.Size - 1024, soFromBeginning);
    SetLength(S, 1024);
    F.ReadBuffer(S, 1024);
  finally
    F.Free;
  end;
  if Copy(S, 1, 20) = 'LATEXIDE-SERVER-URL=' then
    Result := Trim(String(Copy(S, 21, 1004)));
end;

function IsServerMode: Boolean;
begin
  Result := (TrailerUrl = '') and (ModePage.SelectedValueIndex = 1);
end;

function StarterExe(Param: String): String;
begin
  if IsServerMode then Result := 'LatexIDE-Server.cmd' else Result := '{#MyAppExeName}';
end;

function JsonEscape(V: String): String;
begin
  Result := V;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

procedure InitializeWizard;
begin
  TrailerUrl := ReadTrailerUrl;

  ModePage := CreateInputOptionPage(wpSelectDir,
    'Betriebsart', 'Wie soll LatexIDE auf diesem Rechner laufen?',
    'Die Desktop-App verbindet sich mit einem bestehenden LatexIDE-Server. Als eigener Server laeuft das ganze System auf diesem Rechner (im Browser unter http://localhost:3077).',
    True, False);
  ModePage.Add('Desktop-App (mit einem Server verbinden)');
  ModePage.Add('Eigener Server auf diesem Rechner');
  if GetPreviousData('Mode', 'desktop') = 'server' then ModePage.SelectedValueIndex := 1 else ModePage.SelectedValueIndex := 0;

  UrlPage := CreateInputQueryPage(ModePage.ID,
    'Server', 'Mit welchem LatexIDE-Server soll sich die App verbinden?',
    'Tipp: Wird die App nach der Anmeldung in der Weboberflaeche des Servers heruntergeladen, ist die Adresse schon eingetragen.');
  UrlPage.Add('Server-Adresse (z. B. https://latex.example.org):', False);
  UrlPage.Values[0] := GetPreviousData('ServerUrl', '');

  AdminPage := CreateInputQueryPage(UrlPage.ID,
    'Administrator', 'Konto fuer die Verwaltung des Servers',
    'Mit diesem Konto meldest du dich zuerst an und laedst weitere Nutzer ein.');
  AdminPage.Add('E-Mail:', False);
  AdminPage.Add('Passwort (mind. 8 Zeichen):', True);

  // Ordner fuer die lokale Kopie der eigenen Projekte (nur Desktop-App, offline nutzbar).
  LocalDirPage := CreateInputDirPage(AdminPage.ID,
    'Lokale Kopie', 'Wo sollen deine Projekte lokal gespeichert werden?',
    'LatexIDE haelt eine Kopie deiner eigenen Projekte auf diesem Rechner, damit du auch offline arbeiten kannst. Sie wird automatisch mit dem Server abgeglichen.',
    False, '');
  LocalDirPage.Add('');
  LocalDirPage.Values[0] := GetPreviousData('LocalDir', ExpandConstant('{userdocs}\LatexIDE'));
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = ModePage.ID then Result := TrailerUrl <> ''
  else if PageID = UrlPage.ID then Result := (TrailerUrl <> '') or IsServerMode
  else if PageID = AdminPage.ID then Result := (not IsServerMode) or FileExists(ExpandConstant('{app}\.env'))
  else if PageID = LocalDirPage.ID then Result := IsServerMode;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Url, Pw: String;
begin
  Result := True;
  if CurPageID = UrlPage.ID then
  begin
    Url := Lowercase(Trim(UrlPage.Values[0]));
    if (Pos('http://', Url) <> 1) and (Pos('https://', Url) <> 1) then
    begin
      MsgBox('Bitte die Adresse mit http:// oder https:// angeben.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if CurPageID = AdminPage.ID then
  begin
    Pw := AdminPage.Values[1];
    if (Pos('@', AdminPage.Values[0]) = 0) or (Length(Pw) < 8) or (Pos('''', Pw) > 0) then
    begin
      MsgBox('Bitte eine E-Mail-Adresse und ein Passwort mit mindestens 8 Zeichen (ohne Apostroph) angeben.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  if IsServerMode then SetPreviousData(PreviousDataKey, 'Mode', 'server') else SetPreviousData(PreviousDataKey, 'Mode', 'desktop');
  SetPreviousData(PreviousDataKey, 'ServerUrl', UrlPage.Values[0]);
  SetPreviousData(PreviousDataKey, 'LocalDir', LocalDirPage.Values[0]);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Url, EnvFile: String;
begin
  if CurStep <> ssPostInstall then Exit;
  if IsServerMode then
  begin
    // Nur bei der Erstinstallation; Updates lassen .env (und damit die Daten) unberuehrt.
    EnvFile := ExpandConstant('{app}\.env');
    if not FileExists(EnvFile) then
      SaveStringsToUTF8File(EnvFile, [
        'ADMIN_EMAIL=' + Trim(AdminPage.Values[0]),
        'ADMIN_PASSWORD=''' + AdminPage.Values[1] + '''',
        'DATA_DIR=' + ExpandConstant('{localappdata}\LatexIDE\server-data'),
        'UPDATE_MODE=notify'], False);
    Exit;
  end;
  Url := TrailerUrl;
  if Url = '' then Url := Trim(UrlPage.Values[0]);
  SaveStringsToUTF8File(ExpandConstant('{app}\server.json'), ['{"remoteUrl": "' + JsonEscape(Url) + '"}'], False);
  SaveStringsToUTF8File(ExpandConstant('{app}\install.json'), ['{"localDir": "' + JsonEscape(LocalDirPage.Values[0]) + '"}'], False);
end;

[UninstallDelete]
; Datenordner (LATEX_IDE_DATA) und TeX-Live-Installation werden bewusst NICHT
; geloescht - der Uninstaller entfernt nur die App-Dateien unter {app} und
; fragt dabei nichts nach (Standardverhalten von Inno Setup).
; Von [Code] erzeugte Dateien.
Type: files; Name: "{app}\server.json"
Type: files; Name: "{app}\install.json"
Type: files; Name: "{app}\.env"
