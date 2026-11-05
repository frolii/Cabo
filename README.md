# 🦄 Cabo Punktezähler (PWA)

Ein radikal vereinfachter, heller und 100 % offline-fähiger Progressive Web App (PWA) Punktezähler für das Kartenspiel **Cabo** (komplett auf Deutsch).

## ✨ Features

- **Helles, freundliches Design:** Sanfter Creme-/Pergament-Hintergrund (`#F8FAFC`), klare weiße Karten (`#FFFFFF`) und natürliche Grün-, Sonnengold- und Lavendel-Akzente passend zur originalen Cabo-Schachtel.
- **Ultra-Lean Hauptbildschirm:** Keine verschachtelten Popups beim Spielen – Punkte-Eingabe (`-1`, Direktfeld, `+1`, `+5`), **📣 Cabo-Rufer** und **🦄 12-13er-Toggle** befinden sich direkt auf den Spielerkarten.
- **Dauerhaft aktiver Kamikaze-Modus & Offizielle Deutsche Regeln:**
  - **Cabo-Ruf:** Niedrigste (oder geteilt niedrigste) Kartensumme = **`0 Punkte`**. Fehlgeschlagener Ruf = **`Kartensumme + 5 Strafpunkte`**.
  - **12-13er-Regel (Kamikaze):** Hält ein Spieler `12-12-13-13`, bekommt er **`0 Punkte`** und alle anderen erhalten automatisch **`+50 Punkte`** (im Standard-Modus) bzw. **`+25 Punkte`** (im Speed-Modus).
  - **Exakte Punktlandung:** Landet ein Spieler exakt auf **`100`** (bzw. **`50`** im Speed-Modus), wird sein Punktestand einmalig pro Spiel automatisch auf **`50`** (bzw. **`25`**) halbiert.
- **Verschachtelte Sieges-Statistik:** Über den Button **„Menü & Siege“** oben rechts lässt sich jederzeit die **Ewige Bestenliste** (Siege, gespielte Partien & Siegquote pro Spielername) sowie die Historie der letzten beendeten Spiele einsehen.
- **100 % Offline & Root-Deployment-Ready:** Speichert jeden Schritt sofort in `localStorage` und funktioniert dank Service Worker (`/sw.js`) und Manifest (`/manifest.json`) komplett ohne Internetverbindung.
