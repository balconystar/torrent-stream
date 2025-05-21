const express = require('express');
const cors = require('cors');
const path = require('path');
const peerflix = require('peerflix');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Store active torrent engines
const activeStreams = new Map();

// Video file extensions
const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v'];

// Create HLS segments directory if it doesn't exist
const hlsOutputDir = path.join(__dirname, 'public', 'hls');
if (!fs.existsSync(hlsOutputDir)) {
    fs.mkdirSync(hlsOutputDir, { recursive: true });
}

// Helper function to check if a file is a video
function isVideoFile(filename) {
    const ext = path.extname(filename).toLowerCase();
    return videoExtensions.includes(ext);
}

// Helper function to get video files from torrent
function getVideoFiles(engine) {
    return engine.files
        .filter(file => isVideoFile(file.name))
        .map(file => ({
            name: file.name,
            length: file.length,
            path: file.path,
            index: engine.files.indexOf(file)
        }))
        .sort((a, b) => b.length - a.length); // Sort by size, largest first
}

// Initialize torrent engine
function initializeTorrent(magnetLink) {
    return new Promise((resolve, reject) => {
        const engine = peerflix(magnetLink, {
            connections: 100,
            path: path.join(__dirname, 'downloads')
        });

        engine.on('ready', () => {
            resolve(engine);
        });

        engine.on('error', (err) => {
            reject(err);
        });
    });
}

// List files in torrent
app.post('/files', async (req, res) => {
    const { magnetLink } = req.body;
    if (!magnetLink) {
        return res.status(400).json({ error: 'Magnet link is required' });
    }

    try {
        const engine = await initializeTorrent(magnetLink);
        const videoFiles = getVideoFiles(engine);
        
        // Store engine temporarily
        const tempId = Date.now().toString();
        activeStreams.set(tempId, { engine, selected: false });

        // Cleanup after 5 minutes if no file is selected
        setTimeout(() => {
            const stream = activeStreams.get(tempId);
            if (stream && !stream.selected) {
                engine.destroy();
                activeStreams.delete(tempId);
            }
        }, 5 * 60 * 1000);

        res.json({
            torrentId: tempId,
            files: videoFiles
        });
    } catch (error) {
        console.error('Error getting files:', error);
        res.status(500).json({ error: 'Failed to get files from torrent' });
    }
});

// Start streaming specific file
app.post('/stream', async (req, res) => {
    const { torrentId, fileIndex } = req.body;
    if (!torrentId || fileIndex === undefined) {
        return res.status(400).json({ error: 'Torrent ID and file index are required' });
    }

    try {
        const streamData = activeStreams.get(torrentId);
        if (!streamData) {
            return res.status(404).json({ error: 'Torrent not found' });
        }

        const { engine } = streamData;
        const file = engine.files[fileIndex];
        
        if (!file) {
            return res.status(404).json({ error: 'File not found in torrent' });
        }

        // Mark this file as selected for streaming
        streamData.selected = true;
        
        // Deselect all files except the chosen one
        engine.files.forEach((f, index) => {
            if (index === fileIndex) {
                f.select();
            } else {
                f.deselect();
            }
        });

        // Generate a unique ID for this stream
        const streamId = `${torrentId}_${fileIndex}`;
        
        engine.server.on('listening', () => {
            const sourceUrl = `http://localhost:${engine.server.address().port}`;
            
            // Create HLS output directory for this stream
            const streamHlsDir = path.join(hlsOutputDir, streamId);
            if (!fs.existsSync(streamHlsDir)) {
                fs.mkdirSync(streamHlsDir, { recursive: true });
            }

            // Convert stream to HLS
            ffmpeg(sourceUrl)
                .outputOptions([
                    '-c:v copy',
                    '-c:a copy',
                    '-hls_time 10',
                    '-hls_list_size 6',
                    '-hls_flags delete_segments',
                    '-f hls'
                ])
                .output(path.join(streamHlsDir, 'playlist.m3u8'))
                .on('end', () => {
                    console.log('Streaming ended');
                })
                .on('error', (err) => {
                    console.error('FFmpeg error:', err);
                })
                .run();

            res.json({
                streamId,
                playlistUrl: `/hls/${streamId}/playlist.m3u8`,
                fileName: file.name
            });
        });

    } catch (error) {
        console.error('Error starting stream:', error);
        res.status(500).json({ error: 'Failed to start stream' });
    }
});

// Cleanup endpoint
app.delete('/stream/:streamId', (req, res) => {
    const { streamId } = req.params;
    const [torrentId] = streamId.split('_');
    const streamData = activeStreams.get(torrentId);
    
    if (streamData) {
        streamData.engine.destroy();
        activeStreams.delete(torrentId);
        
        // Clean up HLS segments
        const streamHlsDir = path.join(hlsOutputDir, streamId);
        if (fs.existsSync(streamHlsDir)) {
            fs.rmSync(streamHlsDir, { recursive: true, force: true });
        }
        
        res.json({ message: 'Stream destroyed successfully' });
    } else {
        res.status(404).json({ error: 'Stream not found' });
    }
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 