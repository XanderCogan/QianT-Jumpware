# GoTo (Docs + GitHub)

A Chrome MV3 extension that lets you quickly jump to your Google Docs and GitHub repositories by typing `;` in the address bar.

## Features

- **Fast access**: Type `;` followed by a doc/repo name to instantly find and open it
- **Fuzzy matching**: Subsequence-based matching finds your docs/repos even with typos
- **Auto-complete**: Shows up to 6 suggestions as you type
- **Smart defaults**: Press Enter to automatically open the first suggestion
- **No servers**: Everything runs client-side using Chrome APIs only
- **Auto-indexing**: Automatically indexes from bookmarks and browsing history

## Installation

1. Clone or download this repository
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `go-to-ext/` folder

## Usage

1. Press `Ctrl+L` (or `Cmd+L` on Mac) to focus the address bar
2. Type `;` followed by part of a doc or repo name
   - Example: `; proposal draft`
   - Example: `; owner/repo`
3. Press **Enter** to open the first suggestion, or use arrow keys to select a different one

## How It Works

- Indexes URLs from your Chrome bookmarks and history
- Filters to only `docs.google.com` and `github.com` domains
- Uses fuzzy subsequence matching to find relevant results
- Caches index in Chrome storage for fast access
- Auto-refreshes index when you visit new Docs/GitHub pages

## Permissions

- `history`: To index visited Docs/GitHub pages
- `bookmarks`: To include bookmarked Docs/GitHub links
- `storage`: To cache the index for performance

## License

MIT

