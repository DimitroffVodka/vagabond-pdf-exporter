# Vagabond PDF Exporter

An Owlbear Rodeo extension that exports your Vagabond character from the [Vagabond extension by Alyx](https://extensions.owlbear.rodeo/vagabond) to the official Hero Record PDF.

## Installation

1. In Owlbear Rodeo, click your avatar → **Extensions** → **Add Extension**
2. Paste this URL:
   ```
   https://dimitroffvodka.github.io/vagabond-pdf-exporter/manifest.json
   ```
3. Done — the exporter appears as an action button in your OBR toolbar

## Usage

1. Open the **Vagabond** extension and make sure your character sheet is loaded
2. Open the **Vagabond PDF Exporter** from the toolbar
3. Click **Scan Character** — it will read your character data and show a preview
4. Click **Export to PDF** — the filled Hero Record PDF downloads automatically

## Requirements

- The [Vagabond extension by Alyx](https://extensions.owlbear.rodeo/vagabond) must be installed and open with a character loaded

## Notes

- `RSN` (Reason) in the Vagabond extension maps to `LOG` (Logic) in the PDF — this is a naming difference between versions of the system
- Inventory, abilities, and spell fields are not currently scraped (the Vagabond extension stores these differently)
- The blank Hero Record PDF is bundled directly in the extension — no external dependencies

## GitHub Pages Setup

Enable GitHub Pages on this repo pointing to the `main` branch root, then the manifest will be live at:
`https://dimitroffvodka.github.io/vagabond-pdf-exporter/manifest.json`
