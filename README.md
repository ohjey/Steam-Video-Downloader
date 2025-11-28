# Steam Video Downloader

A Chrome extension that lets you download trailer and gameplay videos from Steam store pages with one click.

## Features

- Download videos directly from any Steam store page
- Supports both MP4 and WEBM formats
- Automatically muxes video and audio tracks for DASH streams
- Shows download progress with cancel option
- Floating download button for easy access

## Installation

Since this extension is not on the Chrome Web Store, you'll need to install it manually:

1. **Download the extension**
   - Clone this repository or download it as a ZIP file
   - If downloaded as ZIP, extract it to a folder

2. **Open Chrome Extensions page**
   - Go to `chrome://extensions/` in your browser
   - Or click the three-dot menu → Extensions → Manage Extensions

3. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner

4. **Load the extension**
   - Click "Load unpacked"
   - Select the folder containing the extension files (the folder with `manifest.json`)

5. **Done!**
   - The extension is now installed and ready to use

## Usage

1. Navigate to any Steam store page (e.g., `https://store.steampowered.com/app/...`)
2. Look for the floating download button in the bottom-right corner of the page
3. Click it to see available videos
4. Choose your preferred format:
   - **Download** - Downloads the highest quality DASH video (automatically combines video + audio)
   - **MP4/WEBM** - Direct download of the selected format

## Supported Pages

- Steam store game pages (`https://store.steampowered.com/app/*`)

## Technical Details

- Uses mp4box.js for muxing DASH video and audio streams
- Runs as a Chrome Manifest V3 extension
- Uses an offscreen document for video processing

## Troubleshooting

**Extension not working?**
- Make sure you're on a Steam store page
- Try refreshing the page
- Check that the extension is enabled in `chrome://extensions/`

**Download button not appearing?**
- Some pages may not have downloadable videos
- Wait for the page to fully load

**Video won't play after download?**
- Try a different format (MP4 vs WEBM)
- Some videos may require a compatible media player like VLC

## License

MIT
