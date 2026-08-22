const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, exec } = require('child_process');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Set temp directory for downloads
const TEMP_DIR = path.join(os.tmpdir(), 'yt-downloader-temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Path to yt-dlp binary in venv
const YTDLP_PATH = path.join(__dirname, 'venv', 'bin', 'yt-dlp');

// Custom PATH environment to ensure ffmpeg and node are found
const CUSTOM_ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`
};

// Active download tasks and completed temp files
const activeDownloads = new Map();
const readyDownloads = new Map();

// Helper to broadcast WS messages
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// Format duration in seconds to MM:SS or HH:MM:SS
function formatDuration(sec) {
  if (!sec) return '00:00';
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);

  const pad = num => String(num).padStart(2, '0');
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

const ytdl = require('@distube/ytdl-core');

// API 1: Fetch Video Details
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'URL parametresi gerekli.' });
  }

  if (fs.existsSync(YTDLP_PATH)) {
    const args = [
      '--js-runtimes', 'node',
      '--dump-single-json',
      '--no-playlist',
      videoUrl
    ];

    const process = spawn(YTDLP_PATH, args, { env: CUSTOM_ENV });
    let stdoutData = '';
    let stderrData = '';

    process.stdout.on('data', data => { stdoutData += data; });
    process.stderr.on('data', data => { stderrData += data; });

    process.on('close', code => {
      if (code === 0) {
        try {
          const json = JSON.parse(stdoutData);
          const heights = new Set();
          if (json.formats && Array.isArray(json.formats)) {
            json.formats.forEach(f => {
              if (f.height && f.vcodec !== 'none') heights.add(f.height);
            });
          }
          const availableResolutions = Array.from(heights).sort((a, b) => b - a).map(h => `${h}p`);
          return res.json({
            id: json.id,
            title: json.title,
            uploader: json.uploader || json.channel || 'Bilinmeyen Kanal',
            duration: formatDuration(json.duration),
            durationSec: json.duration,
            thumbnail: json.thumbnail || (json.thumbnails && json.thumbnails.length ? json.thumbnails[json.thumbnails.length - 1].url : ''),
            viewCount: json.view_count ? json.view_count.toLocaleString() : null,
            availableResolutions: availableResolutions.length ? availableResolutions : ['1080p', '720p', '480p', '360p']
          });
        } catch (e) {}
      }
      fallbackInfoWithYtdl(videoUrl, res);
    });
  } else {
    fallbackInfoWithYtdl(videoUrl, res);
  }
});

async function fallbackInfoWithYtdl(url, res) {
  try {
    const info = await ytdl.getInfo(url);
    const details = info.videoDetails;
    res.json({
      id: details.videoId,
      title: details.title,
      uploader: details.author ? details.author.name : 'Bilinmeyen Kanal',
      duration: formatDuration(parseInt(details.lengthSeconds)),
      durationSec: parseInt(details.lengthSeconds),
      thumbnail: details.thumbnails && details.thumbnails.length ? details.thumbnails[details.thumbnails.length - 1].url : '',
      viewCount: details.viewCount ? parseInt(details.viewCount).toLocaleString() : null,
      availableResolutions: ['1080p', '720p', '480p', '360p']
    });
  } catch (e) {
    console.error('ytdl fallback info error:', e);
    res.status(500).json({ error: 'Video bilgileri alınamadı. Geçersiz veya korumalı YouTube bağlantısı olabilir.' });
  }
}

// API Stream: Direct Browser Stream Download for Vercel & Local
app.get('/api/stream', async (req, res) => {
  const { url, formatType, quality, title } = req.query;
  if (!url) return res.status(400).send('URL gerekli.');

  const isMp3 = formatType === 'mp3';
  const fileExt = isMp3 ? 'mp3' : 'mp4';
  const cleanTitle = (title || 'youtube_download').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
  const filename = `${cleanTitle || 'download'}.${fileExt}`;

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', isMp3 ? 'audio/mpeg' : 'video/mp4');

  if (fs.existsSync(YTDLP_PATH)) {
    const args = [
      '--js-runtimes', 'node',
      '--no-playlist',
      '-o', '-'
    ];
    if (isMp3) {
      args.push('-x', '--audio-format', 'mp3');
    } else {
      args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
    }
    args.push(url);

    const proc = spawn(YTDLP_PATH, args, { env: CUSTOM_ENV });
    proc.stdout.pipe(res);
    proc.stderr.on('data', data => console.error('yt-dlp stream:', data.toString()));
  } else {
    try {
      const options = isMp3
        ? { filter: 'audioonly', quality: 'highestaudio' }
        : { filter: 'audioandvideo', quality: quality === 'best' ? 'highest' : quality };

      const stream = ytdl(url, options);
      stream.pipe(res);
      stream.on('error', err => {
        console.error('ytdl stream error:', err);
        if (!res.headersSent) res.status(500).send('İndirme akışında hata oluştu.');
      });
    } catch (e) {
      console.error('Stream handler error:', e);
      if (!res.headersSent) res.status(500).send('İndirme başlatılamadı.');
    }
  }
});

// API 2: Start Download Task
app.post('/api/download', (req, res) => {
  const { url, formatType, quality } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL gerekli.' });
  }

  const downloadId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  
  const args = [
    '--js-runtimes', 'node',
    '--newline',
    '--progress',
    '--ffmpeg-location', '/opt/homebrew/bin',
    '-o', path.join(TEMP_DIR, `${downloadId}_%(title)s.%(ext)s`)
  ];

  if (formatType === 'mp3') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0', '--embed-thumbnail', '--add-metadata');
  } else {
    // Video format
    let maxHeights = quality ? quality.replace('p', '') : '1080';
    if (quality === 'best' || !quality) {
      args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
    } else {
      args.push('-f', `bestvideo[height<=${maxHeights}]+bestaudio/best[height<=${maxHeights}]/best`, '--merge-output-format', 'mp4');
    }
  }

  args.push(url);

  console.log(`Starting download ${downloadId}:`, YTDLP_PATH, args.join(' '));

  const proc = spawn(YTDLP_PATH, args, { env: CUSTOM_ENV });
  
  const downloadState = {
    id: downloadId,
    url,
    formatType,
    quality,
    percent: 0,
    speed: '0 KiB/s',
    eta: '--:--',
    totalSize: 'Bilinmiyor',
    status: 'starting',
    filePath: '',
    filename: '',
    proc
  };

  activeDownloads.set(downloadId, downloadState);

  // Return download ID immediately
  res.json({ success: true, downloadId, message: 'İndirme yanıtı oluşturuldu' });

  // Broadcast initial status
  broadcast({
    event: 'start',
    downloadId,
    formatType,
    quality,
    status: 'starting'
  });

  proc.stdout.on('data', data => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      // Progress pattern: [download]  45.3% of ~  25.10MiB at  3.42MiB/s ETA 00:04
      const progressMatch = line.match(/\[download\]\s+([\d\.]+)%\s+of\s+([~~\d\.\w]+)\s+at\s+([\d\.\w\/]+)\s+ETA\s+([\d:]+)/);
      if (progressMatch) {
        const percent = parseFloat(progressMatch[1]);
        const totalSize = progressMatch[2];
        const speed = progressMatch[3];
        const eta = progressMatch[4];

        downloadState.percent = percent;
        downloadState.totalSize = totalSize;
        downloadState.speed = speed;
        downloadState.eta = eta;
        downloadState.status = 'downloading';

        broadcast({
          event: 'progress',
          downloadId,
          percent,
          totalSize,
          speed,
          eta,
          status: 'downloading'
        });
      }

      // Destination line: [download] Destination: /path/to/file.mp4
      const destMatch = line.match(/\[download\]\s+Destination:\s+(.+)/);
      if (destMatch) {
        downloadState.filePath = destMatch[1].trim();
        downloadState.filename = path.basename(downloadState.filePath).replace(`${downloadId}_`, '');
      }
      
      // Merged file line: [Merger] Merging formats into "/path/to/file.mp4"
      const mergeMatch = line.match(/\[Merger\]\s+Merging formats into\s+"(.+)"/);
      if (mergeMatch) {
        downloadState.filePath = mergeMatch[1].trim();
        downloadState.filename = path.basename(downloadState.filePath).replace(`${downloadId}_`, '');
      }

      // FFmpeg merge/conversion line: [ExtractAudio] Destination: /path/to/file.mp3
      const audioMatch = line.match(/\[ExtractAudio\]\s+Destination:\s+(.+)/);
      if (audioMatch) {
        downloadState.filePath = audioMatch[1].trim();
        downloadState.filename = path.basename(downloadState.filePath).replace(`${downloadId}_`, '');
        downloadState.status = 'converting';
        broadcast({
          event: 'status_update',
          downloadId,
          status: 'converting',
          message: 'MP3 hazırlanıyor...'
        });
      }
    });
  });

  let stderrLog = '';
  proc.stderr.on('data', data => {
    stderrLog += data.toString();
  });

  proc.on('close', code => {
    activeDownloads.delete(downloadId);
    if (code === 0) {
      // Find downloaded file if not caught by log parsing
      if (!downloadState.filePath || !fs.existsSync(downloadState.filePath)) {
        const foundFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(downloadId));
        if (foundFiles.length > 0) {
          downloadState.filePath = path.join(TEMP_DIR, foundFiles[0]);
          downloadState.filename = foundFiles[0].replace(`${downloadId}_`, '');
        }
      }

      readyDownloads.set(downloadId, {
        filePath: downloadState.filePath,
        filename: downloadState.filename || 'media_file'
      });

      broadcast({
        event: 'complete',
        downloadId,
        filename: downloadState.filename || 'İndirilen Medya',
        percent: 100,
        status: 'completed',
        downloadUrl: `/api/download-file/${downloadId}`
      });
    } else {
      console.error('Download process failed with code', code, stderrLog);
      broadcast({
        event: 'error',
        downloadId,
        error: 'İndirme hatası oluştu. Lütfen bağlantıyı kontrol edin.',
        details: stderrLog,
        status: 'failed'
      });
    }
  });
});

// API 3: Get Status of Active or Ready Download (HTTP Polling fallback for Vercel)
app.get('/api/status/:id', (req, res) => {
  const downloadId = req.params.id;
  const activeItem = activeDownloads.get(downloadId);

  if (activeItem) {
    return res.json({
      event: 'progress',
      downloadId,
      percent: activeItem.percent,
      totalSize: activeItem.totalSize,
      speed: activeItem.speed,
      eta: activeItem.eta,
      status: activeItem.status,
      filename: activeItem.filename
    });
  }

  const readyItem = readyDownloads.get(downloadId);
  if (readyItem) {
    return res.json({
      event: 'complete',
      downloadId,
      filename: readyItem.filename,
      percent: 100,
      status: 'completed',
      downloadUrl: `/api/download-file/${downloadId}`
    });
  }

  res.status(404).json({ error: 'İndirme bulunamadı' });
});

// API 4: Serve direct file download to client browser
app.get('/api/download-file/:id', (req, res) => {
  const downloadId = req.params.id;
  const item = readyDownloads.get(downloadId);

  if (!item || !fs.existsSync(item.filePath)) {
    return res.status(404).send('Dosya bulunamadı veya süresi doldu.');
  }

  res.download(item.filePath, item.filename, (err) => {
    // Delete temp file after serving
    try {
      if (fs.existsSync(item.filePath)) {
        fs.unlinkSync(item.filePath);
      }
      readyDownloads.delete(downloadId);
    } catch (e) {
      console.error('Error cleaning up temp file:', e);
    }
  });
});

// API 5: Cancel Active Download
app.post('/api/cancel', (req, res) => {
  const { downloadId } = req.body;
  const item = activeDownloads.get(downloadId);
  if (item && item.proc) {
    item.proc.kill('SIGKILL');
    activeDownloads.delete(downloadId);
    broadcast({ event: 'cancelled', downloadId });
    return res.json({ success: true, message: 'İndirme iptal edildi' });
  }
  res.status(404).json({ error: 'Aktif indirme bulunamadı' });
});

// WebSocket Connection logging
wss.on('connection', ws => {
  ws.send(JSON.stringify({ event: 'connected', message: 'WebSocket Bağlandı' }));
});

const PORT = 3820;
server.listen(PORT, () => {
  console.log(`YouTube Downloader Backend listening on http://localhost:${PORT}`);
});

