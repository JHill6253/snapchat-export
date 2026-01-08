# Snapchat Memory Export

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)](https://github.com)

CLI tool to export Snapchat memories with preserved metadata (dates, GPS coordinates) to your local file system or Apple Photos.

---

## Features

- **Download all saved memories** - Photos and videos from your Snapchat data export
- **Overlay compositing** - Automatically composites text/sticker overlays onto your photos and videos
- **Preserve metadata** - Original capture dates embedded in file metadata
- **GPS coordinates** - Location data written as EXIF metadata
- **Interactive mode** - Guided prompts for easy setup (just run without arguments)
- **Concurrent downloads** - Configurable parallel downloads with rate limiting
- **Resume capability** - Tracks progress and survives interruptions
- **Apple Photos import** - Direct import to Photos.app (macOS only)
- **Dry-run mode** - Preview what will be downloaded before committing
- **Flexible organization** - Sort by date or export as flat file structure

---

## Prerequisites

- **Node.js 18+** (uses native `fetch` API)
- **Snapchat data export** ([instructions below](#getting-your-snapchat-data-export))
- **macOS** (required for Apple Photos import feature)

---

## Installation

```bash
# Clone the repository
git clone https://github.com/JHill6253/snapchat-export.git
cd snapchat-export

# Install dependencies
npm install

# Build the project
npm run build

# (Optional) Link globally for easier access
npm link
```

---

## Quick Start

### Interactive Mode (Recommended for beginners)

Just run the tool without any arguments for a guided experience:

```bash
# Run interactive mode
npm run dev

# Or after global install
snapchat-export
```

You'll be prompted to:

1. Enter the path to your Snapchat export folder
2. Choose output directory
3. Optionally filter by date range
4. Select download speed
5. Choose whether to import to Apple Photos

### Command Line Mode

```bash
# After downloading and extracting your Snapchat data export:

# Run the export (using npx)
npx snapchat-export ./mydata~1234567890 -o ./my-memories

# Or with global install
snapchat-export ./mydata~1234567890 -o ./my-memories
```

---

## Usage

```
snapchat-export <path> [options]
```

### Options

| Option                  | Description                             | Default              |
| ----------------------- | --------------------------------------- | -------------------- |
| `-o, --output <dir>`    | Output directory                        | `./snapchat-exports` |
| `-f, --format <format>` | Organization: `date` or `flat`          | `date`               |
| `-c, --concurrency <n>` | Number of parallel downloads            | `5`                  |
| `--delay <ms>`          | Delay between downloads (ms)            | `500`                |
| `-r, --max-retries <n>` | Retry attempts with exponential backoff | `3`                  |
| `--dry-run`             | Preview without downloading             | `false`              |
| `--skip-existing`       | Skip already-downloaded files           | `false`              |
| `--photos`              | Import to Apple Photos (macOS only)     | `false`              |
| `-l, --limit <n>`       | Limit number of memories to process     | -                    |
| `-i, --interactive`     | Force interactive mode                  | `false`              |
| `-h, --help`            | Display help                            | -                    |
| `-V, --version`         | Display version                         | -                    |

### Examples

**Basic export:**

```bash
snapchat-export ./mydata~1234567890
```

**Preview what will be downloaded:**

```bash
snapchat-export ./mydata~1234567890 --dry-run
```

**Export with higher concurrency (faster, but may hit rate limits):**

```bash
snapchat-export ./mydata~1234567890 -c 10 --delay 250
```

**Export directly to Apple Photos:**

```bash
snapchat-export ./mydata~1234567890 --photos
```

**Export to a specific directory with flat structure:**

```bash
snapchat-export ./mydata~1234567890 -o ~/Pictures/Snapchat -f flat
```

**Test with a small batch first:**

```bash
snapchat-export ./mydata~1234567890 --limit 10 --dry-run
```

---

## Getting Your Snapchat Data Export

Before using this tool, you need to download your data from Snapchat. There are two methods:

### Method A: Memories-Only Export (Recommended)

This is faster and contains only your saved memories.

1. Go to [accounts.snapchat.com](https://accounts.snapchat.com) and log in
2. Click **"My Data"**
3. Under "Select data to include," toggle **"Export your Memories"** to on
4. Click **"Request Only Memories"**
5. Select the date range you want (or leave blank for all memories)
6. Confirm your email address and click **"Submit"**
7. Wait for the email notification (can take up to 7 days for large exports)
8. Download the zip file from the link in the email, or visit [accounts.snapchat.com/accounts/downloadmydata](https://accounts.snapchat.com/accounts/downloadmydata)
9. Extract the zip file to get a folder named `mydata~TIMESTAMP`

### Method B: Full Data Export

This includes all your Snapchat data (chat history, friends, etc.) plus memories.

1. Go to [accounts.snapchat.com](https://accounts.snapchat.com) and log in
2. Click **"My Data"**
3. Select all the data categories you want to include
4. Confirm your email and click **"Submit"**
5. Wait for the email and download the zip file
6. Extract to get the `mydata~TIMESTAMP` folder

### Important Notes

> **Download links expire!** The download URLs in your Snapchat export are time-limited. Process your export soon after downloading it. If links have expired, you'll need to request a new export.

> **Large exports take time.** Snapchat may take several days to prepare exports with many memories. You'll receive an email when it's ready.

---

## Overlay Compositing

Snapchat memories often include overlay images (text, stickers, filters) that are stored separately from the base photo/video. This tool automatically:

1. **Downloads the raw media** - The base photo or video
2. **Downloads any overlay** - PNG images with transparency (if present)
3. **Composites them together** - Merges the overlay onto the base media

### Image Compositing

For photos, overlays are composited using [Jimp](https://github.com/jimp-dev/jimp), a pure JavaScript image processing library.

### Video Compositing

For videos, overlays are composited using FFmpeg. The tool will:

- Try to use a bundled FFmpeg if available
- Fall back to system FFmpeg if installed
- Skip video compositing (with a warning) if FFmpeg is not available

To install FFmpeg on macOS:

```bash
brew install ffmpeg
```

---

## Output Structure

### Date-based organization (default)

Files are organized by year and month:

```
snapchat-exports/
├── .snapchat-export-manifest.json    # Progress tracking
├── 2023/
│   ├── 06/
│   │   ├── 2023-06-15_143022_a1b2c3.jpg
│   │   └── 2023-06-15_150130_d4e5f6.mp4
│   └── 12/
│       └── 2023-12-25_091500_g7h8i9.jpg
└── 2024/
    └── 01/
        └── 2024-01-01_000112_j0k1l2.jpg
```

### Flat organization (`--format flat`)

All files in a single directory:

```
snapchat-exports/
├── .snapchat-export-manifest.json
├── 2023-06-15_143022_a1b2c3.jpg
├── 2023-06-15_150130_d4e5f6.mp4
├── 2023-12-25_091500_g7h8i9.jpg
└── 2024-01-01_000112_j0k1l2.jpg
```

---

## Resume Capability

This tool automatically tracks download progress using a manifest file (`.snapchat-export-manifest.json`). If the export is interrupted:

1. **Simply run the same command again** - Already-downloaded files will be skipped
2. The tool will show how many files were previously downloaded
3. Only remaining files will be processed

Failed downloads are automatically retried with exponential backoff (up to 3 retries by default, configurable with `--max-retries`).

---

## Troubleshooting

### "Download links expired" or 403 errors

The download URLs in Snapchat exports are time-limited. If you see these errors, you'll need to:

1. Request a new data export from Snapchat
2. Download and extract the fresh export
3. Run the tool again

### Rate limiting (429 errors)

If you're seeing many retries due to rate limiting:

```bash
# Reduce concurrency and increase delay
snapchat-export ./mydata~1234567890 -c 2 --delay 2000
```

### "Apple Photos is not available"

The `--photos` flag only works on macOS. On other platforms, export to a directory and import manually.

### Large exports timing out

For very large memory collections:

```bash
# Process in smaller batches
snapchat-export ./mydata~1234567890 --limit 100
# Run again to continue (resume capability will skip completed files)
snapchat-export ./mydata~1234567890
```

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Setup

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- ./path/to/export

# Run tests
npm test

# Lint and format
npm run lint
npm run format
```

---

## License

MIT
