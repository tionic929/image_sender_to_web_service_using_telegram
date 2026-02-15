require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const https = require('https');
const moment = require('moment');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const token = process.env.TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

if (!token) {
    console.error("❌ ERROR: TELEGRAM_TOKEN missing in .env file");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Security middleware
app.use(helmet({
    contentSecurityPolicy: false, // Allow inline scripts for Alpine.js
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

app.use(express.json());
app.use(express.static('public'));

const GALLERY_DIR = path.join(__dirname, 'public/gallery');
if (!fs.existsSync(GALLERY_DIR)) fs.mkdirSync(GALLERY_DIR, { recursive: true });

// Simple auth middleware (for production, use proper JWT/sessions)
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${ADMIN_PASSWORD}`) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// --- API ROUTES ---

// Get all files with timestamps and metadata
app.get('/api/history', (req, res) => {
    try {
        fs.readdir(GALLERY_DIR, (err, files) => {
            if (err) {
                console.error('Error reading gallery:', err);
                return res.status(500).json({ error: 'Failed to read gallery' });
            }
            
            const history = files
                .filter(file => !file.startsWith('.')) // Skip hidden files
                .map(file => {
                    try {
                        const stats = fs.statSync(path.join(GALLERY_DIR, file));
                        return {
                            url: `/gallery/${file}`,
                            filename: file,
                            date: moment(stats.mtime).format('MMMM D, YYYY'),
                            timestamp: stats.mtimeMs,
                            type: file.startsWith('vid') ? 'video' : 'image',
                            size: formatBytes(stats.size)
                        };
                    } catch (err) {
                        console.error(`Error stating file ${file}:`, err);
                        return null;
                    }
                })
                .filter(item => item !== null)
                .sort((a, b) => b.timestamp - a.timestamp);
            
            res.json(history);
        });
    } catch (err) {
        console.error('Error in /api/history:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all image URLs (for bulk download)
app.get('/api/all-images', (req, res) => {
    try {
        fs.readdir(GALLERY_DIR, (err, files) => {
            if (err) return res.status(500).json({ error: 'Failed to read gallery' });
            res.json(files
                .filter(file => !file.startsWith('.'))
                .map(file => `/gallery/${file}`)
            );
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete a file (protected)
app.delete('/api/media/:filename', authMiddleware, (req, res) => {
    try {
        const filename = path.basename(req.params.filename); // Prevent path traversal
        const filePath = path.join(GALLERY_DIR, filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        fs.unlinkSync(filePath);
        console.log(`🗑️  Deleted: ${filename}`);
        
        // Notify all clients
        io.emit('media-deleted', { filename });
        
        res.json({ success: true, message: 'File deleted' });
    } catch (err) {
        console.error('Error deleting file:', err);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

// Get storage stats
app.get('/api/stats', (req, res) => {
    try {
        fs.readdir(GALLERY_DIR, (err, files) => {
            if (err) return res.status(500).json({ error: 'Failed to read gallery' });
            
            let totalSize = 0;
            let imageCount = 0;
            let videoCount = 0;
            
            files.forEach(file => {
                try {
                    const stats = fs.statSync(path.join(GALLERY_DIR, file));
                    totalSize += stats.size;
                    if (file.startsWith('vid')) videoCount++;
                    else imageCount++;
                } catch (err) {
                    console.error(`Error stating ${file}:`, err);
                }
            });
            
            res.json({
                totalFiles: files.length,
                totalSize: formatBytes(totalSize),
                totalSizeBytes: totalSize,
                imageCount,
                videoCount
            });
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// --- TELEGRAM LOGIC ---
bot.on('photo', (msg) => {
    saveTelegramFile(msg.photo[msg.photo.length - 1].file_id, 'img');
    bot.sendMessage(msg.chat.id, '✅ Photo synced to gallery');
});

bot.on('video', (msg) => {
    saveTelegramFile(msg.video.file_id, 'vid');
    bot.sendMessage(msg.chat.id, '✅ Video synced to gallery');
});

bot.on('document', (msg) => {
    if (msg.document.mime_type?.startsWith('image/') || msg.document.mime_type?.startsWith('video/')) {
        const prefix = msg.document.mime_type.startsWith('video/') ? 'vid' : 'img';
        saveTelegramFile(msg.document.file_id, prefix);
        bot.sendMessage(msg.chat.id, '✅ Document synced to gallery');
    }
});

async function saveTelegramFile(fileId, prefix) {
    try {
        const file = await bot.getFile(fileId);
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        const ext = path.extname(file.file_path) || '.jpg';
        const fileName = `${prefix}_${Date.now()}${ext}`;
        const filePath = path.join(GALLERY_DIR, fileName);

        const fileStream = fs.createWriteStream(filePath);
        https.get(url, (res) => {
            res.pipe(fileStream);
            fileStream.on('finish', () => {
                fileStream.close();
                console.log(`📥 Disk Sync: ${fileName}`);
            });
        }).on('error', (err) => {
            console.error(`❌ Download error for ${fileName}:`, err);
            fs.unlinkSync(filePath); // Clean up partial file
        });
    } catch (err) { 
        console.error("❌ Telegram API Error:", err.message); 
    }
}

// --- FILE WATCHER ---
chokidar.watch(GALLERY_DIR, { 
    ignoreInitial: true, 
    awaitWriteFinish: { 
        stabilityThreshold: 2000, 
        pollInterval: 100 
    } 
}).on('add', (filePath) => {
    const fileName = path.basename(filePath);
    const stats = fs.statSync(filePath);
    
    io.emit('new-media', { 
        url: `/gallery/${fileName}`,
        filename: fileName,
        type: fileName.startsWith('vid') ? 'video' : 'image',
        date: moment().format('MMMM D, YYYY'),
        timestamp: Date.now(),
        size: formatBytes(stats.size)
    });
    
    console.log(`📡 Broadcast: ${fileName}`);
});

// Helper function
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, closing server...');
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 SYSTEM ONLINE: http://localhost:${PORT}`);
    console.log(`📂 Gallery: ${GALLERY_DIR}`);
});