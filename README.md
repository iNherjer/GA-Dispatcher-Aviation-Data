# GA Dispatcher Aviation Data

Build- und Hosting-Pipeline für die statischen Luftfahrtdaten von GA Dispatcher.
Sie lädt die öffentlichen OpenAIP-Datensätze, normalisiert sie in ein stabiles
Schema und veröffentlicht kleine, räumlich indizierte JSON-Packs über GitHub
Pages.

Die Pipeline ist zunächst unabhängig von der App. Die App kann später über
`latest.json` das aktuelle Manifest laden und nur die Packs abrufen, die den
Karten- oder Routenausschnitt schneiden. Der bestehende OpenAIP-V2-Abruf bleibt
dadurch als Legacy- und Fallback-Pfad erhalten.

## Enthaltene Sammlungen

- Lufträume inklusive Geometrie und Höhenband
- Flugplätze inklusive Frequenzen und Pisten
- Navaids inklusive Frequenz, Kanal und Reichweite
- VFR-Meldepunkte (VRPs)

## Lokaler Testlauf

Voraussetzung ist Node.js 22 oder neuer. Der kleine Deutschland-Test ruft die
gleichen Endpunkte und verwendet das gleiche Packformat wie der globale Lauf:

```bash
node tools/build-data.mjs --countries=DE --output=dist
node tools/validate-data.mjs dist
```

Ohne `--countries` wird ein globaler Datenstand gebaut:

```bash
npm run build
npm run validate
```

Nützliche Optionen:

```text
--collections=airspaces,airports,navaids,reportingPoints
--countries=DE,AT,CH
--output=dist
--dataset-version=snapshot-2026-07-28
--source-base=https://ga-proxy.einherjer.workers.dev/api
```

## Veröffentlichte Struktur

```text
latest.json
cycles/<datasetVersion>/manifest.json
cycles/<datasetVersion>/airspaces/<country>/<cell>.json
cycles/<datasetVersion>/airports/<country>/<cell>.json
cycles/<datasetVersion>/navaids/<country>/<cell>.json
cycles/<datasetVersion>/reporting-points/<country>/<cell>.json
```

Jeder Manifest-Eintrag enthält Land, räumliche Abdeckung, Anzahl, Dateigröße
und SHA-256-Prüfsumme. Ein Objekt wird genau einem Pack zugeordnet. Die
Pack-Abdeckung enthält trotzdem die vollständige Objektgeometrie, damit auch
große Lufträume bei einem räumlichen Schnitt sicher gefunden werden.

Ein Pack ist standardmäßig auf 6 MB unkomprimiertes JSON begrenzt. In der
Praxis sind die meisten Packs wesentlich kleiner; größere, dichte Zellen werden
automatisch in nummerierte Teilpacks zerlegt.

## GitHub Actions

`publish.yml` unterstützt:

- einen manuellen Initiallauf über **Run workflow**,
- einen wöchentlichen Scheduler mit einer 27-Tage-Sperre,
- einen erzwungenen Neuaufbau,
- einen optionalen Länder-Testlauf,
- Validierung vor dem atomaren Pages-Deployment,
- einen kleinen Status-Commit nach erfolgreichem Deployment.

Für den ersten Lauf muss GitHub Pages einmal im Repository unter
**Settings → Pages → Source: GitHub Actions** aktiviert sein. Danach erzeugt
der Workflow den Datenstand vollständig selbst.

Die großen generierten JSON-Dateien werden dabei nicht in die Git-Historie
geschrieben. Nur Builder, Workflow und der wenige Byte große Zeitstempel des
letzten erfolgreichen Laufs liegen im Repository; der Datenstand selbst wird
als atomar austauschbares Pages-Artefakt veröffentlicht.

## Datenquelle und Lizenz

Die abgeleiteten Datensätze basieren auf [OpenAIP](https://www.openaip.net/)
und werden unter den Bedingungen von **CC BY-NC 4.0** bereitgestellt. Details
stehen in [ATTRIBUTION.md](ATTRIBUTION.md).
