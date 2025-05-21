# Torrent Video Streamer

A Node.js web application that streams torrent videos using Peerflix and HLS.

## Prerequisites

- Node.js (v14 or higher)
- FFmpeg installed on your system
- A modern web browser that supports HLS.js

## Installation

1. Clone this repository
2. Install dependencies:
```bash
npm install
```

## Usage

1. Start the server:
```bash
node server.js
```

2. Open your web browser and navigate to:
```
http://localhost:3000
```

3. Paste a magnet link into the input field and click "Start Streaming"

## Features

- Torrent streaming using Peerflix
- HLS video streaming support
- Automatic video transcoding
- Clean and responsive user interface
- Automatic cleanup of temporary files

## Important Notes

- This application is for educational purposes only
- Make sure you have the right to stream the content
- The application requires FFmpeg to be installed on your system
- Temporary files are stored in the `public/hls` directory
- Downloaded torrent files are stored in the `downloads` directory

## Technical Details

- Backend: Node.js with Express
- Frontend: HTML5, JavaScript with HLS.js
- Video Processing: FFmpeg
- Torrent Client: Peerflix

## License

ISC 