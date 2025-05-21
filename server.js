const express = require('express');
const cors = require('cors');
const path = require('path');
const peerflix = require('peerflix');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

const app = express();
const port = 3000;
const serverIP = '52.168.128.120'; // Your server IP

// Configure CORS
app.use(cors({
    origin: [
        `http://${serverIP}`,
        `http://${serverIP}:${port}`,
        'http://localhost',
        'http://localhost:3000'
    ],
    methods: ['GET', 'POST', 'DELETE'],
    credentials: true
}));

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

// Initialize torrent engine with better error handling and progress monitoring
function initializeTorrent(magnetLink) {
    return new Promise((resolve, reject) => {
        const engine = peerflix(magnetLink, {
            connections: 100,
            path: path.join(__dirname, 'downloads'),
            buffer: (1024 * 1024 * 2), // 2MB buffer
            uploads: 10,
            tmp: path.join(__dirname, 'tmp'), // Temporary directory
            trackers: [
                'udp://tracker.opentrackr.org:1337/announce',
                'udp://9.rarbg.com:2810/announce',
                'udp://tracker.openbittorrent.com:6969/announce',
                'udp://tracker.internetwarriors.net:1337/announce'
            ]
        });

        let isResolved = false;

        engine.on('ready', () => {
            console.log('Torrent engine ready');
            if (!isResolved) {
                isResolved = true;
                resolve(engine);
            }
        });

        engine.on('error', (err) => {
            console.error('Torrent engine error:', err);
            if (!isResolved) {
                isResolved = true;
                reject(err);
            }
        });

        // Monitor download progress
        engine.on('download', (pieceIndex) => {
            const progress = Math.round((engine.swarm.downloaded / engine.torrent.length) * 100);
            console.log(`Download progress: ${progress}%`);
        });

        // Monitor peer connections
        engine.on('peer', (peer) => {
            console.log(`Connected to peer: ${peer.address}`);
        });

        // Set a timeout for engine initialization
        setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                engine.destroy();
                reject(new Error('Torrent engine initialization timeout'));
            }
        }, 30000); // 30 seconds timeout
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
        
        if (videoFiles.length === 0) {
            engine.destroy();
            return res.status(404).json({ error: 'No video files found in torrent' });
        }

        // Store engine temporarily
        const tempId = Date.now().toString();
        activeStreams.set(tempId, { 
            engine,
            selected: false,
            progress: 0,
            peers: 0
        });

        // Monitor this specific stream
        engine.on('download', () => {
            const progress = Math.round((engine.swarm.downloaded / engine.torrent.length) * 100);
            const streamData = activeStreams.get(tempId);
            if (streamData) {
                streamData.progress = progress;
                streamData.peers = engine.swarm.wires.length;
            }
        });

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
        res.status(500).json({ error: 'Failed to get files from torrent: ' + error.message });
    }
});

// Get stream status
app.get('/status/:torrentId', (req, res) => {
    const { torrentId } = req.params;
    const streamData = activeStreams.get(torrentId);
    
    if (!streamData) {
        return res.status(404).json({ error: 'Stream not found' });
    }

    const { engine, progress, peers } = streamData;
    res.json({
        progress,
        peers,
        downloaded: engine.swarm.downloaded,
        downloadSpeed: engine.swarm.downloadSpeed(),
        uploadSpeed: engine.swarm.uploadSpeed()
    });
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
                console.log(`Selected file: ${f.name} (${f.length} bytes)`);
            } else {
                f.deselect();
            }
        });

        // Generate a unique ID for this stream
        const streamId = `${torrentId}_${fileIndex}`;
        
        // Create HLS output directory for this stream
        const streamHlsDir = path.join(hlsOutputDir, streamId);
        if (!fs.existsSync(streamHlsDir)) {
            fs.mkdirSync(streamHlsDir, { recursive: true });
        }

        let initialDataReceived = false;
        const maxRetries = 3;
        let retryCount = 0;

        // Function to wait for initial data with retry
        const waitForInitialData = async () => {
            return new Promise((resolve, reject) => {
                const checkProgress = () => {
                    const downloaded = engine.swarm.downloaded;
                    const peers = engine.swarm.wires.length;
                    console.log(`Download progress: ${downloaded} bytes, Peers: ${peers}`);

                    // Check if we have any data at all
                    if (downloaded > 0) {
                        initialDataReceived = true;
                        resolve();
                        return;
                    }

                    // If no data and no peers, we might need to retry
                    if (peers === 0 && !initialDataReceived) {
                        if (retryCount < maxRetries) {
                            retryCount++;
                            console.log(`No peers found, retry ${retryCount}/${maxRetries}`);
                            // Add more trackers on retry
                            engine.discovery.announce([
                                'udp://tracker.opentrackr.org:1337/announce',
                                'udp://open.tracker.cl:1337/announce',
                                'udp://9.rarbg.com:2810/announce',
                                'udp://tracker.openbittorrent.com:6969/announce'
                            ]);
                        } else {
                            reject(new Error('No peers found after retries'));
                            return;
                        }
                    }

                    setTimeout(checkProgress, 1000);
                };

                checkProgress();

                // Set a timeout for the entire retry process
                setTimeout(() => {
                    if (!initialDataReceived) {
                        reject(new Error('Timeout waiting for initial data'));
                    }
                }, 45000); // 45 seconds total timeout
            });
        };

        // Wait for initial data
        await waitForInitialData();

        // Start the server and get the URL
        const serverPort = await new Promise((resolve) => {
            engine.server.once('listening', () => {
                resolve(engine.server.address().port);
            });
        });

        const sourceUrl = `http://${serverIP}:${serverPort}`;
        console.log(`Starting stream from: ${sourceUrl}`);

        // Convert stream to HLS with more detailed logging
        const ffmpeg = require('fluent-ffmpeg');
        ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path);

        const ffmpegProcess = ffmpeg(sourceUrl)
            .outputOptions([
                '-c:v copy',
                '-c:a copy',
                '-hls_time 10',
                '-hls_list_size 6',
                '-hls_flags delete_segments+append_list',
                '-f hls'
            ])
            .output(path.join(streamHlsDir, 'playlist.m3u8'))
            .on('start', (cmd) => {
                console.log('Started FFmpeg with command:', cmd);
            })
            .on('progress', (progress) => {
                console.log('FFmpeg Progress:', progress);
            })
            .on('end', () => {
                console.log('Streaming ended');
            })
            .on('error', (err, stdout, stderr) => {
                console.error('FFmpeg error:', err.message);
                console.error('FFmpeg stderr:', stderr);
            });

        // Start FFmpeg
        ffmpegProcess.run();

        // Monitor download progress for this specific stream
        const progressInterval = setInterval(() => {
            const downloaded = engine.swarm.downloaded;
            const speed = engine.swarm.downloadSpeed();
            const peers = engine.swarm.wires.length;
            console.log(`Stream status - Downloaded: ${downloaded} bytes, Speed: ${speed} bytes/s, Peers: ${peers}`);
        }, 5000);

        // Clean up interval when stream ends
        engine.server.once('close', () => {
            clearInterval(progressInterval);
        });

        res.json({
            streamId,
            playlistUrl: `/hls/${streamId}/playlist.m3u8`,
            fileName: file.name
        });

    } catch (error) {
        console.error('Error starting stream:', error);
        res.status(500).json({ 
            error: 'Failed to start stream: ' + error.message,
            details: {
                peers: engine?.swarm?.wires?.length || 0,
                downloaded: engine?.swarm?.downloaded || 0,
                message: error.message
            }
        });
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

// Listen on all network interfaces
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://${serverIP}:${port}`);
}); 