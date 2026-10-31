; Inno Setup 6 Skript fuer LaTeX-IDE Desktop.
; Per-User-Installation ohne Admin-Rechte unter {localappdata}\Programs\LatexIDE.
; Baut auf dem Staging-Ordner installer\out\staging auf (siehe build-release.ps1).
; Zwei Betriebsarten: Desktop-App (verbindet sich mit einem Server) oder eigener
; Server auf diesem Rechner. Ein vom Server heruntergeladenes Setup traegt dessen
; Adresse als 1024-Byte-Trailer "LATEXIDE-SERVER-URL=..." am Dateiende
; (server/lib/desktopAssets.js) - dann ist die Betriebsart Desktop und es wird nichts gefragt.

#define MyAppName "LaTeX-IDE"
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
AppPublisher=felix-d-git
AppPublisherURL=https://github.com/felix-d-git/LaTeX-IDE
AppSupportURL=https://github.com/felix-d-git/LaTeX-IDE
AppUpdatesURL=https://github.com/felix-d-git/LaTeX-IDE
AppCopyright=Copyright (C) 2026 felix-d-git and LaTeX-IDE contributors - AGPL-3.0-only
; Ordner bleibt LatexIDE (Updates bestehender Installationen, Pfade in Starter/Uninstall)
DefaultDirName={localappdata}\Programs\LatexIDE
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\out
OutputBaseFilename=LatexIDE-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Nur Hinweisseite, keine Zustimmung: die AGPL muss nicht angenommen werden (Abschnitt 9).
; build-release.ps1 erzeugt die Dateien im Staging (Quell-Link dieser Version).
InfoBeforeFile={#StagingDir}\LICENSES-INSTALLER.txt

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"; InfoBeforeFile: "{#StagingDir}\LICENSES-INSTALLER-en.txt"

[Tasks]
Name: "desktopicon"; Description: "Desktop-Verknuepfung anlegen"; GroupDescription: "Zusaetzliche Symbole:"; Flags: unchecked

[InstallDelete]
; Sonst bleiben bei Updates entfernte Pakete liegen (bis 0.5.0 z. B. @napi-rs/canvas mit Skia).
; node_modules enthaelt keine Nutzerdaten (.env liegt direkt in {app}, Daten unter {localappdata}\LatexIDE).
Type: filesandordirs; Name: "{app}\node_modules"
; Ebenso server/ und client/: sonst bleiben von neuen Versionen entfernte Dateien liegen.
; .env und server.json liegen direkt in {app} und bleiben unberuehrt. node/ bleibt (laufender Server sperrt node.exe).
Type: filesandordirs; Name: "{app}\server"
Type: filesandordirs; Name: "{app}\client"
; Verknuepfungen vom alten Namen (bis 0.5.2 "LatexIDE")
Type: files; Name: "{group}\LatexIDE.lnk"
Type: files; Name: "{group}\Uninstall LatexIDE.lnk"
Type: files; Name: "{userdesktop}\LatexIDE.lnk"

[Files]
Source: "{#StagingDir}\*"; DestDir: "{app}"; Excludes: "\node_modules\.cache\*"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{code:StarterExe}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{code:StarterExe}"; Tasks: desktopicon

[Run]
; Nach einem stillen Update (aus der App heraus) die App wieder starten.
Filename: "{app}\{code:StarterExe}"; Flags: nowait postinstall skipifnotsilent runhidden shellexec
; TeX Live Installation nach dem Kopieren der Dateien. Sichtbares Fenster,
; kann sehr lange dauern (mehrere Stunden). Bricht die Installation nicht ab,
; falls der Nutzer latexmk bereits im PATH hat (Skript prueft selbst).
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-texlive.ps1"""; \
    WorkingDir: "{app}"; StatusMsg: "TeX Live wird installiert (kann mehrere Stunden dauern)..."; Flags: waituntilterminated
Filename: "{app}\{code:StarterExe}"; Description: "LaTeX-IDE jetzt starten"; Flags: nowait postinstall skipifsilent runhidden shellexec

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

function IsLocalMode: Boolean;
begin
  Result := (TrailerUrl = '') and (ModePage.SelectedValueIndex = 2);
end;

function StarterExe(Param: String): String;
begin
  if IsServerMode then Result := 'LatexIDE-Server.cmd'
  else if IsLocalMode then Result := 'LatexIDE-Lokal.vbs'
  else Result := '{#MyAppExeName}';
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
  // Setup mit eingebauter Server-Adresse macht aus einer Server-/Lokal-Installation die Desktop-App.
  if (TrailerUrl <> '') and (GetPreviousData('Mode', 'desktop') <> 'desktop') then
    if SuppressibleMsgBox('Dieses Setup stammt von einem Server und installiert die Desktop-App. ' +
      'Die bestehende Installation (eigener Server bzw. lokal) wuerde dadurch umgestellt. ' +
      'Zum Aktualisieren stattdessen das Setup von GitHub verwenden.' + #13#10#13#10 + 'Trotzdem fortfahren?',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDYES) = IDNO then Abort;

  ModePage := CreateInputOptionPage(wpSelectDir,
    'Betriebsart', 'Wie soll LaTeX-IDE auf diesem Rechner laufen?',
    'Die Desktop-App verbindet sich mit einem bestehenden LaTeX-IDE-Server. Als eigener Server laeuft das ganze System auf diesem Rechner (im Browser unter http://localhost:3077). 100 % lokal: nur fuer dich, ohne Konto und Netzwerk, beendet sich mit dem Browserfenster.',
    True, False);
  ModePage.Add('Desktop-App (mit einem Server verbinden)');
  ModePage.Add('Eigener Server auf diesem Rechner');
  ModePage.Add('Nur dieser Rechner (100 % lokal, ohne Konto)');
  if GetPreviousData('Mode', 'desktop') = 'server' then ModePage.SelectedValueIndex := 1
  else if GetPreviousData('Mode', 'desktop') = 'local' then ModePage.SelectedValueIndex := 2
  else ModePage.SelectedValueIndex := 0;

  UrlPage := CreateInputQueryPage(ModePage.ID,
    'Server', 'Mit welchem LaTeX-IDE-Server soll sich die App verbinden?',
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
    'LaTeX-IDE haelt eine Kopie deiner eigenen Projekte auf diesem Rechner, damit du auch offline arbeiten kannst. Sie wird automatisch mit dem Server abgeglichen.',
    False, '');
  LocalDirPage.Add('');
  LocalDirPage.Values[0] := GetPreviousData('LocalDir', ExpandConstant('{userdocs}\LatexIDE'));
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = ModePage.ID then Result := TrailerUrl <> ''
  else if PageID = UrlPage.ID then Result := (TrailerUrl <> '') or IsServerMode or IsLocalMode
  else if PageID = AdminPage.ID then Result := (not IsServerMode) or FileExists(ExpandConstant('{app}\.env'))
  else if PageID = LocalDirPage.ID then Result := IsServerMode or IsLocalMode;
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
    if (Pos('@', AdminPage.Values[0]) = 0) or (Pos('.', Copy(AdminPage.Values[0], Pos('@', AdminPage.Values[0]) + 1, MaxInt)) = 0) or (Length(Pw) < 8) or (Pos('''', Pw) > 0) then
    begin
      MsgBox('Bitte eine E-Mail-Adresse und ein Passwort mit mindestens 8 Zeichen (ohne Apostroph) angeben.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  if IsServerMode then SetPreviousData(PreviousDataKey, 'Mode', 'server')
  else if IsLocalMode then SetPreviousData(PreviousDataKey, 'Mode', 'local')
  else SetPreviousData(PreviousDataKey, 'Mode', 'desktop');
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
        'UPDATE_MODE=notify',
        'INSTALL_KIND=windows'], False);
    Exit;
  end;
  if IsLocalMode then Exit; // Einstellungen setzt LatexIDE-Lokal.vbs
  Url := TrailerUrl;
  if Url = '' then Url := Trim(UrlPage.Values[0]);
  SaveStringsToUTF8File(ExpandConstant('{app}\server.json'), ['{"remoteUrl": "' + JsonEscape(Url) + '"}'], False);
  SaveStringsToUTF8File(ExpandConstant('{app}\install.json'), ['{"localDir": "' + JsonEscape(LocalDirPage.Values[0]) + '"}'], False);
end;

// --- Deinstallation ---------------------------------------------------------

function MultiByteToWideChar(CodePage, Flags: Cardinal; Src: AnsiString; SrcLen: Integer; Dest: String; DestLen: Integer): Integer;
  external 'MultiByteToWideChar@kernel32.dll stdcall';

function Utf8ToStr(S: AnsiString): String;
var
  Len: Integer;
begin
  Result := '';
  if S = '' then Exit;
  SetLength(Result, Length(S)); // UTF-16 braucht nie mehr Zeichen als UTF-8 Bytes
  Len := MultiByteToWideChar(65001, 0, S, Length(S), Result, Length(S));
  SetLength(Result, Len);
end;

// "localDir" aus einer JSON-Datei (install.json vom Setup, config.json der App), beide UTF-8.
function JsonLocalDir(FileName: String): String;
var
  S: AnsiString;
  P: Integer;
begin
  Result := '';
  if not LoadStringFromFile(FileName, S) then Exit;
  P := Pos('"localDir"', S);
  if P = 0 then Exit;
  S := Copy(S, P + 10, Length(S));
  P := Pos('"', S);
  if P = 0 then Exit;
  S := Copy(S, P + 1, Length(S));
  P := Pos('"', S);
  if P = 0 then Exit;
  Result := Utf8ToStr(Copy(S, 1, P - 1));
  StringChangeEx(Result, '\\', '\', True);
end;

// Ordner der lokalen Kopie, aber nur, wenn er LatexIDE heisst - ein selbst gewaehlter
// Ordner wie "Dokumente" kann fremde Dateien enthalten und wird nie geloescht.
function LocalCopyDir: String;
begin
  Result := JsonLocalDir(ExpandConstant('{localappdata}\LatexIDE\data\config.json'));
  if Result = '' then Result := JsonLocalDir(ExpandConstant('{app}\install.json'));
  if Result = '' then Result := ExpandConstant('{userdocs}\LatexIDE');
  if (CompareText(ExtractFileName(RemoveBackslashUnlessRoot(Result)), 'LatexIDE') <> 0) or not DirExists(Result) then
    Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Base, LocalCopy, Msg, AppDir: String;
  IsServerInstall: Boolean;
  Code: Integer;
begin
  if CurUninstallStep <> usUninstall then Exit;
  Base := ExpandConstant('{localappdata}\LatexIDE');
  LocalCopy := LocalCopyDir;
  IsServerInstall := FileExists(ExpandConstant('{app}\.env')) or DirExists(Base + '\server-data');

  // Laufenden Server/App dieser Installation beenden, sonst sind Dateien gesperrt.
  // Pfad fuer PowerShell: Apostrophe verdoppeln, StartsWith statt -like (dort sind [ ] Platzhalter).
  AppDir := ExpandConstant('{app}');
  StringChangeEx(AppDir, '''', '''''', True);
  Exec('powershell.exe', '-NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith(''' +
    AppDir + '\'', ''OrdinalIgnoreCase'') } | Stop-Process -Force"', '', SW_HIDE, ewWaitUntilTerminated, Code);

  // TeX Live und Caches sind keine Nutzerdaten.
  DelTree(Base + '\texlive', True, True, True);
  DelTree(Base + '\data\cache', True, True, True);

  // Projektdaten nur nach Rueckfrage (bei stiller Deinstallation: behalten).
  if not UninstallSilent and (DirExists(Base) or (LocalCopy <> '')) then
  begin
    if IsServerInstall then
      Msg := 'ACHTUNG: Dieser Rechner IST der Server. "Ja" loescht alle Konten und alle Projekte ' +
        'aller Nutzer unwiderruflich (auch die Einstellungen in der .env).' + #13#10#13#10 +
        'Sollen wirklich alle Server-Daten geloescht werden?' + #13#10#13#10 + Base + #13#10
    else
      Msg := 'Sollen auch deine Projekte und Einstellungen geloescht werden?' + #13#10#13#10 +
        Base + #13#10;
    if LocalCopy <> '' then Msg := Msg + LocalCopy + ' (lokale Kopie)' + #13#10;
    Msg := Msg + #13#10 + 'Projekte auf einem Server bleiben dort erhalten. Lokale Projekte und noch nicht ' +
      'abgeglichene Offline-Aenderungen gehen verloren - vorher ggf. in LaTeX-IDE unter ' +
      '"Alle Projekte" als ZIP herunterladen.' + #13#10#13#10 +
      'Ja = alles loeschen, Nein = Projekte behalten.';
    if MsgBox(Msg, mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    begin
      DelTree(Base, True, True, True);
      DeleteFile(ExpandConstant('{app}\.env'));
      if LocalCopy <> '' then DelTree(LocalCopy, True, True, True);
    end;
  end;
  RemoveDir(Base); // nur falls leer
end;

[UninstallDelete]
; Datenordner und TeX Live raeumt CurUninstallStepChanged auf (Projekte nur nach Rueckfrage).
; Von [Code] erzeugte Dateien.
Type: files; Name: "{app}\server.json"
Type: files; Name: "{app}\install.json"
; .env bleibt bei "Projekte behalten" (und stiller Deinstallation) liegen; CurUninstallStepChanged loescht sie bei "Ja".
