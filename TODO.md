# TODO

## GUI-Prüfpunkte
- ⬜ #167 SMTP-Hinweis (staging/second-branch): App starten → Profil-/Admin-Dialog → SMTP-Bereich öffnen → Hinweis „Port 587 setzt STARTTLS voraus“ sichtbar und lesbar (hell/dunkel)
- ⬜ #158 Limits-Tab (staging/second-branch): Admin-Dialog → Tab „Limits“ zeigt 6 Felder mit aktuellen Werten, Tooltip = Vorgabe; Kontingent auf 1 → Speichern → „Gespeichert.“, Wert bleibt nach Neuöffnen; als Nutzer Zip > 1 MB hochladen → „Speicherkontingent überschritten“; 0 bzw. „abc“ → Validierungsfehler; Kommentarlimit 5, Kommentar mit 6 Zeichen → „Kommentar zu lang“; Kontingent zurück auf 300; Nicht-Admin sieht den Tab nicht
- ⬜ #163 Start-Schlüssel (staging/second-branch): `LatexIDE.cmd` und `LatexIDE-Lokal.vbs` per Doppelklick → Browser öffnet mit `?k=…` und steht danach auf `/` ohne `k`; zweiter Doppelklick bei laufender App öffnet nur den Browser erneut; „Desktop-App verbinden“ (Login über Server, `/desktop-callback`) einmal durchspielen; macOS `install.command` nur textuell getestet
