# ReWrap

**Bulk-convert iPhone photos to JPEG — pixels untouched.**

ReWrap converts iPhone HEIC/HEIF and ProRAW (DNG) photos to JPEG entirely in your browser. No resizing, rotation, or filters are ever applied. Every metadata block — EXIF, GPS, color profile, XMP — is copied verbatim, with a ledger showing exactly what was preserved.

**Try it live → [saadsulek.github.io/ReWrap](https://saadsulek.github.io/ReWrap/)**

---

## Why ReWrap

Most HEIC-to-JPEG converters silently re-encode, strip metadata, or upload your photos to a server. ReWrap does neither:

- **Pixels stay pixels.** HEIC/HEIF files are decoded once and re-encoded once, at your chosen quality — a single unavoidable round trip, with no resizing, cropping, or filtering. ProRAW DNGs have their embedded full-quality JPEG extracted byte-for-byte, so the image data never changes at all.
- **Metadata travels with the photo.** EXIF, GPS, ICC color profile, and XMP blocks are copied as raw bytes, not re-parsed and rebuilt — and a ledger shows you what was preserved for every file.
- **Nothing leaves your device.** All decoding runs locally via WebAssembly. No uploads, no servers, no accounts. You can disconnect from the network after the page loads and it still works.

## Features

- Drag-and-drop or folder-picker batch conversion
- Supports `.heic`, `.heif`, and ProRAW `.dng`
- Adjustable JPEG quality (100 / 98 / 95 / 90) for HEIC/HEIF re-encoding
- Optional auto-save as each file finishes
- Download the whole batch as a single ZIP
- Per-file metadata ledger (EXIF, GPS, color profile, XMP)
- Works fully offline after the first load

## How it works

| Format | Process |
|---|---|
| **HEIC / HEIF** | Decode the HEVC-compressed frame once, draw it unchanged, encode to JPEG once at the chosen quality. `decode → encode`, exactly one round trip. |
| **ProRAW (.dng)** | Parse the TIFF/DNG structure and lift out the embedded full-quality JPEG. `extract → wrap`, zero bytes of image data change. |

Note: some non-ProRAW DNGs store only raw sensor data with no embedded JPEG. ReWrap won't demosaic or invent pixels for those — it will refuse rather than silently alter your photo.

## Usage

1. Open [the live app](https://saadsulek.github.io/ReWrap/) (or run it locally — see below).
2. Drag your HEIC/HEIF/DNG files (or a whole folder) onto the dropzone, or click to pick files.
3. Choose a JPEG quality if you're converting HEIC/HEIF.
4. Watch the queue process, then download individual files or grab everything as a ZIP.

## Running locally

ReWrap is a static site — no build step, no backend.

```bash
git clone https://github.com/saadsulek/ReWrap.git
cd ReWrap
# serve the folder with any static server, e.g.:
python3 -m http.server 8000
```

Then open `http://localhost:8000` in your browser.

## Tech stack

- Vanilla HTML/CSS/JavaScript — no framework, no build tooling
- [libheif-js](https://www.npmjs.com/package/libheif-js) (WebAssembly) for HEIC/HEIF decoding
- [exifr](https://www.npmjs.com/package/exifr) for metadata parsing
- [JSZip](https://www.npmjs.com/package/jszip) for batch ZIP downloads

## Privacy

Everything happens client-side. Your photos are never uploaded anywhere — you can verify this by opening dev tools and watching the network tab, or by disconnecting from the internet after the page loads.

## License

Add a license of your choice (e.g. MIT) — none is currently specified in this repo.

## Contributing

Issues and pull requests are welcome. If you hit a DNG file that won't convert, check whether it's ProRAW with an embedded JPEG (supported) or raw-sensor-only (not supported by design — see [How it works](#how-it-works)).

