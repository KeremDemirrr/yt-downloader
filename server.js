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

// Path to yt-dlp binary (Render Linux build binary or local Mac venv)
const LINUX_YTDLP = path.join(__dirname, 'yt-dlp-linux');
const MAC_YTDLP = path.join(__dirname, 'venv', 'bin', 'yt-dlp');

let YTDLP_PATH = 'yt-dlp';
if (fs.existsSync(LINUX_YTDLP)) {
  YTDLP_PATH = LINUX_YTDLP;
} else if (fs.existsSync(MAC_YTDLP)) {
  YTDLP_PATH = MAC_YTDLP;
}

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

const youtubedl = require('youtube-dl-exec');

// Helper to extract YouTube Video ID
function getYouTubeVideoId(url) {
  if (!url) return null;
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|\&v=)([^#\&\?]*).*/;
  const match = url.trim().match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

// API 1: Fetch Video Details (youtube-dl-exec + oEmbed fallback)
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'Lütfen geçerli bir YouTube adresi girin.' });
  }

  const videoId = getYouTubeVideoId(videoUrl);

  try {
    const json = await youtubedl(videoUrl, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      preferFreeFormats: true
    });

    const heights = new Set();
    if (json.formats && Array.isArray(json.formats)) {
      json.formats.forEach(f => {
        if (f.height && f.vcodec !== 'none') heights.add(f.height);
      });
    }
    const availableResolutions = Array.from(heights).sort((a, b) => b - a).map(h => `${h}p`);

    return res.json({
      id: json.id || videoId,
      title: json.title || 'YouTube Video',
      uploader: json.uploader || json.channel || 'Bilinmeyen Kanal',
      duration: formatDuration(json.duration),
      durationSec: json.duration,
      thumbnail: json.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      viewCount: json.view_count ? json.view_count.toLocaleString() : null,
      availableResolutions: availableResolutions.length ? availableResolutions : ['1080p', '720p', '480p', '360p']
    });
  } catch (e) {
    console.error('youtubedl info error, trying oEmbed:', e);
    await fallbackInfoOembed(videoId, videoUrl, res);
  }
});

async function fallbackInfoOembed(videoId, fullUrl, res) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(oembedUrl);
    if (response.ok) {
      const data = await response.json();
      return res.json({
        id: videoId,
        title: data.title || 'YouTube Video',
        uploader: data.author_name || 'YouTube Kanalı',
        duration: 'HD Video',
        durationSec: 0,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        viewCount: null,
        availableResolutions: ['1080p', '720p', '480p', '360p']
      });
    }
  } catch (e) {
    console.error('oEmbed fetch error:', e);
  }
  res.status(500).json({ error: 'Video bilgileri alınamadı. Geçersiz veya gizli bir YouTube adresi olabilir.' });
}

// API Stream: Direct Stream Download via youtube-dl-exec
app.get('/api/stream', async (req, res) => {
  const { url, formatType, quality, title } = req.query;
  if (!url) return res.status(400).send('URL gerekli.');

  const isMp3 = formatType === 'mp3';
  const fileExt = isMp3 ? 'mp3' : 'mp4';
  const cleanTitle = (title || 'youtube_download').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
  const filename = `${cleanTitle || 'download'}.${fileExt}`;

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', isMp3 ? 'audio/mpeg' : 'video/mp4');

  try {
    const options = {
      output: '-',
      noWarnings: true,
      noCheckCertificates: true
    };

    if (isMp3) {
      options.extractAudio = true;
      options.audioFormat = 'mp3';
    } else {
      let maxHeights = quality ? quality.replace('p', '') : '1080';
      options.format = `bestvideo[height<=${maxHeights}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`;
    }

    const subprocess = youtubedl.exec(url, options);
    subprocess.stdout.pipe(res);
    subprocess.stderr.on('data', data => console.error('stream stderr:', data.toString()));
    subprocess.on('error', err => {
      console.error('Subprocess error:', err);
      if (!res.headersSent) res.status(500).send('İndirme akışında hata oluştu.');
    });
  } catch (e) {
    console.error('Stream handler error:', e);
    if (!res.headersSent) res.status(500).send('İndirme başlatılamadı.');
  }
});

// API 2: Start Download Task (Supports local yt-dlp & Vercel fallback)
app.post('/api/download', (req, res) => {
  const { url, formatType, quality } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL gerekli.' });
  }

  const downloadId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const isMp3 = formatType === 'mp3';
  const fileExt = isMp3 ? 'mp3' : 'mp4';

  const downloadState = {
    id: downloadId,
    url,
    formatType,
    quality,
    percent: 0,
    speed: '1.2 MiB/s',
    eta: '00:05',
    totalSize: 'İndiriliyor...',
    status: 'downloading',
    filePath: '',
    filename: `media_${downloadId}.${fileExt}`,
    proc: null
  };

  activeDownloads.set(downloadId, downloadState);
  res.json({ success: true, downloadId, message: 'İndirme başlatıldı' });

  broadcast({
    event: 'start',
    downloadId,
    formatType,
    quality,
    status: 'downloading'
  });

  if (fs.existsSync(YTDLP_PATH)) {
    const args = [
      '--js-runtimes', 'node',
      '--newline',
      '--progress',
      '--ffmpeg-location', '/opt/homebrew/bin',
      '-o', path.join(TEMP_DIR, `${downloadId}_%(title)s.%(ext)s`)
    ];

    if (isMp3) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      let maxHeights = quality ? quality.replace('p', '') : '1080';
      args.push('-f', `bestvideo[height<=${maxHeights}]+bestaudio/best[height<=${maxHeights}]/best`, '--merge-output-format', 'mp4');
    }
    args.push(url);

    const proc = spawn(YTDLP_PATH, args, { env: CUSTOM_ENV });
    downloadState.proc = proc;

    proc.stdout.on('data', data => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        const progressMatch = line.match(/\[download\]\s+([\d\.]+)%\s+of\s+([~~\d\.\w]+)\s+at\s+([\d\.\w\/]+)\s+ETA\s+([\d:]+)/);
        if (progressMatch) {
          downloadState.percent = parseFloat(progressMatch[1]);
          downloadState.totalSize = progressMatch[2];
          downloadState.speed = progressMatch[3];
          downloadState.eta = progressMatch[4];
          downloadState.status = 'downloading';

          broadcast({
            event: 'progress',
            downloadId,
            percent: downloadState.percent,
            totalSize: downloadState.totalSize,
            speed: downloadState.speed,
            eta: downloadState.eta,
            status: 'downloading'
          });
        }

        const destMatch = line.match(/\[download\]\s+Destination:\s+(.+)/);
        if (destMatch) {
          downloadState.filePath = destMatch[1].trim();
          downloadState.filename = path.basename(downloadState.filePath).replace(`${downloadId}_`, '');
        }

        const mergeMatch = line.match(/\[Merger\]\s+Merging formats into\s+"(.+)"/);
        if (mergeMatch) {
          downloadState.filePath = mergeMatch[1].trim();
          downloadState.filename = path.basename(downloadState.filePath).replace(`${downloadId}_`, '');
        }

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
    proc.stderr.on('data', data => { stderrLog += data.toString(); });

    proc.on('close', code => {
      activeDownloads.delete(downloadId);
      if (code === 0) {
        if (!downloadState.filePath || !fs.existsSync(downloadState.filePath)) {
          const foundFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(downloadId));
          if (foundFiles.length > 0) {
            downloadState.filePath = path.join(TEMP_DIR, foundFiles[0]);
            downloadState.filename = foundFiles[0].replace(`${downloadId}_`, '');
          }
        }

        readyDownloads.set(downloadId, {
          filePath: downloadState.filePath,
          filename: downloadState.filename || `download_${downloadId}.${fileExt}`
        });

        broadcast({
          event: 'complete',
          downloadId,
          filename: downloadState.filename || `download_${downloadId}.${fileExt}`,
          percent: 100,
          status: 'completed',
          downloadUrl: `/api/download-file/${downloadId}`
        });
      } else {
        console.error('Download process failed code:', code, stderrLog);
        broadcast({
          event: 'error',
          downloadId,
          error: 'İndirme tamamlanamadı. Lütfen tekrar deneyin.',
          status: 'failed'
        });
      }
    });
  } else {
    // Vercel / Cloud Fallback using ytdl-core stream to file
    const targetFilePath = path.join(TEMP_DIR, `${downloadId}_media.${fileExt}`);
    downloadState.filePath = targetFilePath;
    downloadState.filename = `youtube_media_${Date.now()}.${fileExt}`;

    try {
      const options = {
        ...YTDL_OPTIONS,
        ...(isMp3
          ? { filter: 'audioonly', quality: 'highestaudio' }
          : { filter: 'audioandvideo', quality: quality === 'best' ? 'highest' : quality })
      };

      const stream = ytdl(url, options);
      const outStream = fs.createWriteStream(targetFilePath);

      let downloadedBytes = 0;
      stream.on('data', chunk => {
        downloadedBytes += chunk.length;
        const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
        downloadState.totalSize = `${mb} MB`;
        downloadState.percent = Math.min(95, downloadState.percent + 5);
        broadcast({
          event: 'progress',
          downloadId,
          percent: downloadState.percent,
          totalSize: downloadState.totalSize,
          speed: '2.5 MiB/s',
          eta: '00:02',
          status: 'downloading'
        });
      });

      stream.pipe(outStream);

      outStream.on('finish', () => {
        activeDownloads.delete(downloadId);
        readyDownloads.set(downloadId, {
          filePath: targetFilePath,
          filename: downloadState.filename
        });

        broadcast({
          event: 'complete',
          downloadId,
          filename: downloadState.filename,
          percent: 100,
          status: 'completed',
          downloadUrl: `/api/download-file/${downloadId}`
        });
      });

      stream.on('error', err => {
        console.error('ytdl cloud download error:', err);
        activeDownloads.delete(downloadId);
        broadcast({
          event: 'error',
          downloadId,
          error: 'İndirme sırasında bir hata oluştu.',
          status: 'failed'
        });
      });
    } catch (e) {
      console.error('ytdl cloud catch error:', e);
      activeDownloads.delete(downloadId);
      broadcast({
        event: 'error',
        downloadId,
        error: 'İndirme başlatılamadı.',
        status: 'failed'
      });
    }
  }
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

const PORT = process.env.PORT || 3820;
server.listen(PORT, () => {
  console.log(`YouTube Downloader Backend listening on port ${PORT}`);
});

