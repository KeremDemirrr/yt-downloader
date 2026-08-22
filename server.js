const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TEMP_DIR = path.join(os.tmpdir(), 'yt-downloader-temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const LINUX_YTDLP = path.join(__dirname, 'yt-dlp-linux');
const MAC_YTDLP = path.join(__dirname, 'venv', 'bin', 'yt-dlp');

let YTDLP_PATH = 'yt-dlp';
if (fs.existsSync(LINUX_YTDLP)) {
  YTDLP_PATH = LINUX_YTDLP;
} else if (fs.existsSync(MAC_YTDLP)) {
  YTDLP_PATH = MAC_YTDLP;
}

console.log('Using yt-dlp at:', YTDLP_PATH);

const CUSTOM_ENV = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`
};

const activeDownloads = new Map();
const readyDownloads = new Map();

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '00:00';
  const s = Math.floor(sec);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = n => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}

function getYouTubeVideoId(url) {
  if (!url) return null;
  const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.trim().match(regExp);
  return (match && match[2].length === 11) ? match[2] : null;
}

// API 1: Fetch Video Info
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'Lütfen geçerli bir YouTube adresi girin.' });
  }

  const videoId = getYouTubeVideoId(videoUrl);
  const args = ['--dump-json', '--no-warnings', '--no-check-certificates', videoUrl];
  const proc = spawn(YTDLP_PATH, args, { env: CUSTOM_ENV });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', d => { stdout += d.toString(); });
  proc.stderr.on('data', d => { stderr += d.toString(); });

  proc.on('close', async code => {
    if (code === 0 && stdout.trim()) {
      try {
        const json = JSON.parse(stdout.trim());
        const heights = new Set();
        if (json.formats && Array.isArray(json.formats)) {
          json.formats.forEach(f => {
            if (f.height && f.vcodec && f.vcodec !== 'none') heights.add(f.height);
          });
        }
        const availableResolutions = Array.from(heights)
          .sort((a, b) => b - a).map(h => `${h}p`);

        return res.json({
          id: json.id || videoId,
          title: json.title || 'YouTube Video',
          uploader: json.uploader || json.channel || 'Bilinmeyen Kanal',
          duration: formatDuration(json.duration),
          durationSec: json.duration || 0,
          thumbnail: json.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          viewCount: json.view_count ? json.view_count.toLocaleString('tr-TR') : null,
          availableResolutions: availableResolutions.length ? availableResolutions : ['1080p', '720p', '480p', '360p']
        });
      } catch (e) {
        console.error('JSON parse error:', e.message);
        return fallbackOembed(videoId, res);
      }
    } else {
      console.error('yt-dlp info failed, code:', code, stderr.slice(0, 300));
      return fallbackOembed(videoId, res);
    }
  });

  proc.on('error', err => {
    console.error('yt-dlp spawn error:', err.message);
    return fallbackOembed(videoId, res);
  });
});

async function fallbackOembed(videoId, res) {
  if (!videoId) {
    return res.status(500).json({ error: 'Video bilgileri alınamadı.' });
  }
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (r.ok) {
      const d = await r.json();
      return res.json({
        id: videoId,
        title: d.title || 'YouTube Video',
        uploader: d.author_name || 'YouTube Kanalı',
        duration: '—',
        durationSec: 0,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        viewCount: null,
        availableResolutions: ['1080p', '720p', '480p', '360p']
      });
    }
  } catch (e) {
    console.error('oEmbed error:', e.message);
  }
  return res.status(500).json({ error: 'Video bilgileri alınamadı. Geçersiz veya gizli YouTube adresi olabilir.' });
}

// API 2: Start Download
app.post('/api/download', (req, res) => {
  const { url, formatType, quality } = req.body;
  if (!url) return res.status(400).json({ error: 'URL gerekli.' });

  const downloadId = 'dl_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const isMp3 = formatType === 'mp3';
  const fileExt = isMp3 ? 'mp3' : 'mp4';

  const state = {
    id: downloadId,
    url, formatType, quality,
    percent: 0, speed: '—', eta: '—', totalSize: '—',
    status: 'preparing',
    filePath: '',
    filename: `media_${downloadId}.${fileExt}`,
    proc: null
  };

  activeDownloads.set(downloadId, state);
  res.json({ success: true, downloadId });

  const outputTemplate = path.join(TEMP_DIR, `${downloadId}_%(title)s.%(ext)s`);
  const args = [
    '--newline', '--progress',
    '--no-warnings', '--no-check-certificates',
    '--ffmpeg-location', '/opt/homebrew/bin',
    '-o', outputTemplate
  ];

  if (isMp3) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    const maxH = quality && quality !== 'best' ? quality.replace('p', '') : '1080';
    args.push(
      '-f', `bestvideo[height<=${maxH}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${maxH}]+bestaudio/best`,
      '--merge-output-format', 'mp4'
    );
  }
  args.push(url);

  console.log('Starting download:', downloadId, 'format:', formatType, 'quality:', quality);

  const proc = spawn(YTDLP_PATH, args, { env: CUSTOM_ENV });
  state.proc = proc;
  let stderrBuf = '';

  proc.stdout.on('data', chunk => {
    chunk.toString().split('\n').forEach(line => {
      // Progress: [download]  45.3% of  50.00MiB at   2.13MiB/s ETA 00:18
      const pm = line.match(/\[download\]\s+([\d.]+)%\s+of\s+([\d.~\s\w]+)\s+at\s+([\d.]+\s*\w+\/s)\s+ETA\s+([\d:]+)/);
      if (pm) {
        state.percent = parseFloat(pm[1]);
        state.totalSize = pm[2].trim();
        state.speed = pm[3].trim();
        state.eta = pm[4].trim();
        state.status = 'downloading';
        broadcast({ event: 'progress', downloadId, percent: state.percent, totalSize: state.totalSize, speed: state.speed, eta: state.eta });
        return;
      }

      const destM = line.match(/\[download\]\s+Destination:\s+(.+)/);
      if (destM) {
        state.filePath = destM[1].trim();
        state.filename = path.basename(state.filePath).replace(`${downloadId}_`, '');
      }

      const mergeM = line.match(/\[Merger\]\s+Merging formats into\s+"(.+)"/);
      if (mergeM) {
        state.filePath = mergeM[1].trim();
        state.filename = path.basename(state.filePath).replace(`${downloadId}_`, '');
        broadcast({ event: 'status_update', downloadId, message: 'Video birleştiriliyor...' });
      }

      const audioM = line.match(/\[ExtractAudio\]\s+Destination:\s+(.+)/);
      if (audioM) {
        state.filePath = audioM[1].trim();
        state.filename = path.basename(state.filePath).replace(`${downloadId}_`, '');
        state.status = 'converting';
        broadcast({ event: 'status_update', downloadId, message: 'MP3 dönüştürülüyor...' });
      }
    });
  });

  proc.stderr.on('data', d => { stderrBuf += d.toString(); });

  proc.on('error', err => {
    console.error('yt-dlp spawn error:', err.message);
    activeDownloads.delete(downloadId);
    broadcast({ event: 'error', downloadId, error: 'yt-dlp çalıştırılamadı.' });
  });

  proc.on('close', code => {
    activeDownloads.delete(downloadId);
    if (code === 0) {
      if (!state.filePath || !fs.existsSync(state.filePath)) {
        const files = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(downloadId));
        if (files.length > 0) {
          const sorted = files.sort((a, b) => {
            const pref = ['.mp4', '.mp3', '.m4a', '.webm', '.mkv'];
            return pref.indexOf(path.extname(b)) - pref.indexOf(path.extname(a));
          });
          state.filePath = path.join(TEMP_DIR, sorted[0]);
          state.filename = sorted[0].replace(`${downloadId}_`, '');
        }
      }

      if (!state.filePath || !fs.existsSync(state.filePath)) {
        console.error('File not found! stderr:', stderrBuf.slice(0, 500));
        broadcast({ event: 'error', downloadId, error: 'İndirme tamamlandı ama dosya bulunamadı.' });
        return;
      }

      readyDownloads.set(downloadId, { filePath: state.filePath, filename: state.filename || `download.${fileExt}` });
      broadcast({ event: 'complete', downloadId, filename: state.filename, percent: 100, downloadUrl: `/api/download-file/${downloadId}` });
    } else {
      console.error('yt-dlp failed code:', code, '\nstderr:', stderrBuf.slice(0, 500));
      broadcast({ event: 'error', downloadId, error: 'İndirme tamamlanamadı. Lütfen tekrar deneyin.' });
    }
  });
});

// API 3: Status (polling fallback)
app.get('/api/status/:id', (req, res) => {
  const { id } = req.params;
  const active = activeDownloads.get(id);
  if (active) {
    return res.json({ event: 'progress', downloadId: id, percent: active.percent, totalSize: active.totalSize, speed: active.speed, eta: active.eta, status: active.status });
  }
  const ready = readyDownloads.get(id);
  if (ready) {
    return res.json({ event: 'complete', downloadId: id, filename: ready.filename, percent: 100, downloadUrl: `/api/download-file/${id}` });
  }
  res.status(404).json({ error: 'İndirme bulunamadı' });
});

// API 4: Serve file
app.get('/api/download-file/:id', (req, res) => {
  const item = readyDownloads.get(req.params.id);
  if (!item || !fs.existsSync(item.filePath)) {
    return res.status(404).send('Dosya bulunamadı veya süresi doldu.');
  }
  res.download(item.filePath, item.filename, err => {
    if (err) console.error('File send error:', err.message);
    try {
      if (fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath);
      readyDownloads.delete(req.params.id);
    } catch (e) { console.error('Cleanup error:', e.message); }
  });
});

// API 5: Cancel
app.post('/api/cancel', (req, res) => {
  const { downloadId } = req.body;
  const item = activeDownloads.get(downloadId);
  if (item && item.proc) {
    try { item.proc.kill('SIGKILL'); } catch (_) {}
    activeDownloads.delete(downloadId);
    broadcast({ event: 'cancelled', downloadId });
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Aktif indirme bulunamadı' });
});

wss.on('connection', ws => {
  ws.send(JSON.stringify({ event: 'connected' }));
});

const PORT = process.env.PORT || 3820;
server.listen(PORT, () => {
  console.log(`YouTube Downloader çalışıyor: http://localhost:${PORT}`);
});
