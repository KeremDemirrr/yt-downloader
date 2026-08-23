const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execSync } = require('child_process');
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

// ── ffmpeg detection (using ffmpeg-static npm package as primary) ───────────
function findFfmpeg() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
      return ffmpegStatic;
    }
  } catch (_) {}

  const systemPaths = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg'
  ];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

const FFMPEG_PATH = findFfmpeg();
console.log('Using ffmpeg at:', FFMPEG_PATH);

// ── yt-dlp binary detection ────────────────────────────────────────────────
function findYtdlp() {
  const candidates = [
    path.join(__dirname, 'yt-dlp'),                          // standalone binary downloaded in build
    path.join(__dirname, 'venv', 'bin', 'yt-dlp'),           // local venv
    path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),      // pip install --user (Render)
    '/usr/local/bin/yt-dlp',                                  // pip global
    '/usr/bin/yt-dlp',                                        // system package
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const which = execSync('which yt-dlp 2>/dev/null').toString().trim();
    if (which) return which;
  } catch (_) {}
  return 'yt-dlp';
}

const YTDLP_PATH = findYtdlp();
console.log('Using yt-dlp at:', YTDLP_PATH);

const CUSTOM_ENV = {
  ...process.env,
  PATH: `${path.dirname(FFMPEG_PATH)}:/opt/homebrew/bin:/usr/local/bin:${os.homedir()}/.local/bin:/usr/bin:/bin:${process.env.PATH || ''}`
};

// Common yt-dlp args
const COMMON_YTDLP_ARGS = [
  '--force-ipv4',
  '--no-warnings',
  '--no-check-certificates',
  '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  '--add-header', 'Accept-Language: tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
  '--ffmpeg-location', FFMPEG_PATH
];

const activeDownloads = new Map();
const readyDownloads = new Map();

// ── WebSocket ping/pong to keep connections alive on Render ────────────────
const WS_PING_INTERVAL = 25000;
setInterval(() => {
  wss.clients.forEach(client => {
    if (client.isAlive === false) return client.terminate();
    client.isAlive = false;
    client.ping();
  });
}, WS_PING_INTERVAL);

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ event: 'connected' }));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(msg); } catch (_) {}
    }
  });
}

// ── Temp directory cleanup ─────────────────────────────────────────────────
setInterval(() => {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(TEMP_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 30 * 60 * 1000) {
          fs.unlinkSync(fp);
        }
      } catch (_) {}
    }
  } catch (_) {}
}, 10 * 60 * 1000);

// ── Helpers ────────────────────────────────────────────────────────────────
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

// ════════════════════════════════════════════════════════════════════════════
// API 1: Fetch Video Info
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/info', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'Lütfen geçerli bir YouTube adresi girin.' });
  }

  const videoId = getYouTubeVideoId(videoUrl);
  const args = [
    '--dump-json',
    ...COMMON_YTDLP_ARGS,
    videoUrl
  ];
  
  let proc;
  try {
    proc = spawn(YTDLP_PATH, args, { env: CUSTOM_ENV, timeout: 30000 });
  } catch (err) {
    console.error('yt-dlp spawn failed:', err.message);
    return fallbackOembed(videoId, res);
  }

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
      console.error('yt-dlp info failed, code:', code, stderr.slice(0, 500));
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

// ════════════════════════════════════════════════════════════════════════════
// API 2: Start Download
// ════════════════════════════════════════════════════════════════════════════
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
    ...COMMON_YTDLP_ARGS,
    '--restrict-filenames',
    '-o', outputTemplate
  ];

  if (isMp3) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    const maxH = quality && quality !== 'best' ? quality.replace('p', '') : '1080';
    args.push(
      '-f', `bv*[height<=${maxH}][ext=mp4]+ba[ext=m4a]/bv*[height<=${maxH}]+ba/b[height<=${maxH}]/b`,
      '--merge-output-format', 'mp4'
    );
  }
  args.push(url);

  console.log(`[${downloadId}] Starting download: ${formatType} (${quality || 'best'})`);

  let proc;
  try {
    proc = spawn(YTDLP_PATH, args, { env: CUSTOM_ENV });
  } catch (err) {
    console.error(`[${downloadId}] spawn error:`, err.message);
    activeDownloads.delete(downloadId);
    broadcast({ event: 'error', downloadId, error: 'İndirme başlatılamadı.' });
    return;
  }

  state.proc = proc;
  let stderrBuf = '';
  let lastFilePath = '';

  proc.stdout.on('data', chunk => {
    const text = chunk.toString();
    const lines = text.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      // Progress match
      const pm = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\s*\w+)\s+at\s+([\d.]+\s*\w+\/s)\s+ETA\s+([\d:]+)/);
      if (pm) {
        state.percent = parseFloat(pm[1]);
        state.totalSize = pm[2].trim();
        state.speed = pm[3].trim();
        state.eta = pm[4].trim();
        state.status = 'downloading';
        broadcast({
          event: 'progress', downloadId,
          percent: state.percent,
          totalSize: state.totalSize,
          speed: state.speed,
          eta: state.eta
        });
        continue;
      }

      // 100% match
      const pm100 = line.match(/\[download\]\s+100%\s+of\s+([\d.]+\s*\w+)/);
      if (pm100) {
        state.percent = 100;
        state.totalSize = pm100[1].trim();
        state.status = 'downloading';
        broadcast({ event: 'progress', downloadId, percent: 100, totalSize: state.totalSize, speed: '—', eta: '00:00' });
        continue;
      }

      if (line.includes('has already been downloaded')) {
        state.percent = 100;
        state.status = 'downloading';
        continue;
      }

      // Destination
      const destM = line.match(/\[download\]\s+Destination:\s+(.+)/);
      if (destM) {
        lastFilePath = destM[1].trim();
        state.filePath = lastFilePath;
        state.filename = path.basename(lastFilePath).replace(new RegExp(`^${downloadId}_`), '');
        continue;
      }

      // Merger
      const mergeM = line.match(/\[Merger\]\s+Merging formats into\s+"(.+)"/);
      if (mergeM) {
        state.filePath = mergeM[1].trim();
        state.filename = path.basename(state.filePath).replace(new RegExp(`^${downloadId}_`), '');
        state.status = 'converting';
        broadcast({ event: 'status_update', downloadId, message: 'Video birleştiriliyor...' });
        continue;
      }

      // ExtractAudio
      const audioM = line.match(/\[ExtractAudio\]\s+Destination:\s+(.+)/);
      if (audioM) {
        state.filePath = audioM[1].trim();
        state.filename = path.basename(state.filePath).replace(new RegExp(`^${downloadId}_`), '');
        state.status = 'converting';
        broadcast({ event: 'status_update', downloadId, message: 'MP3 dönüştürülüyor...' });
        continue;
      }
    }
  });

  proc.stderr.on('data', d => { stderrBuf += d.toString(); });

  proc.on('error', err => {
    console.error(`[${downloadId}] spawn error:`, err.message);
    activeDownloads.delete(downloadId);
    broadcast({ event: 'error', downloadId, error: 'İndirme işlemi başlatılamadı.' });
  });

  proc.on('close', code => {
    activeDownloads.delete(downloadId);

    console.log(`[${downloadId}] yt-dlp exited with code ${code}`);
    if (stderrBuf.trim()) {
      console.log(`[${downloadId}] stderr: ${stderrBuf.slice(0, 800)}`);
    }

    if (code === 0) {
      let finalPath = state.filePath;
      if (!finalPath || !fs.existsSync(finalPath)) {
        finalPath = findDownloadedFile(downloadId, fileExt);
      }

      if (!finalPath || !fs.existsSync(finalPath)) {
        console.error(`[${downloadId}] File not found after completion`);
        broadcast({ event: 'error', downloadId, error: 'İndirme tamamlandı ama dosya oluşturulamadı. Lütfen tekrar deneyin.' });
        return;
      }

      state.filePath = finalPath;
      state.filename = path.basename(finalPath).replace(new RegExp(`^${downloadId}_`), '');

      readyDownloads.set(downloadId, {
        filePath: state.filePath,
        filename: state.filename || `download.${fileExt}`
      });

      console.log(`[${downloadId}] Ready: ${state.filename}`);
      broadcast({
        event: 'complete', downloadId,
        filename: state.filename,
        percent: 100,
        downloadUrl: `/api/download-file/${downloadId}`
      });
    } else {
      let userError = 'İndirme tamamlanamadı. Lütfen tekrar deneyin.';
      
      if (stderrBuf.includes('Sign in to confirm your age')) {
        userError = 'Bu video yaş sınırlamasına sahiptir (+18).';
      } else if (stderrBuf.includes('Private video') || stderrBuf.includes('Video unavailable')) {
        userError = 'Bu video gizli veya kullanılamıyor.';
      } else if (stderrBuf.includes('HTTP Error 429')) {
        userError = 'Sunucu yoğunluğu. Lütfen birkaç saniye sonra tekrar deneyin.';
      }

      broadcast({ event: 'error', downloadId, error: userError });
    }
  });
});

function findDownloadedFile(downloadId, preferredExt) {
  try {
    const allFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(downloadId));
    if (allFiles.length === 0) return null;

    const finalFiles = allFiles.filter(f => !f.match(/\.f\d+\./));
    const candidates = finalFiles.length > 0 ? finalFiles : allFiles;

    const extPriority = [`.${preferredExt}`, '.mp4', '.mp3', '.m4a', '.webm', '.mkv', '.opus'];
    candidates.sort((a, b) => {
      const extA = path.extname(a).toLowerCase();
      const extB = path.extname(b).toLowerCase();
      const idxA = extPriority.indexOf(extA);
      const idxB = extPriority.indexOf(extB);
      return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
    });

    const chosen = path.join(TEMP_DIR, candidates[0]);
    if (fs.existsSync(chosen)) return chosen;
  } catch (e) {
    console.error('findDownloadedFile error:', e.message);
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// API 3: Status
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/status/:id', (req, res) => {
  const { id } = req.params;
  const active = activeDownloads.get(id);
  if (active) {
    return res.json({
      event: 'progress', downloadId: id,
      percent: active.percent,
      totalSize: active.totalSize,
      speed: active.speed,
      eta: active.eta,
      status: active.status
    });
  }
  const ready = readyDownloads.get(id);
  if (ready) {
    return res.json({
      event: 'complete', downloadId: id,
      filename: ready.filename,
      percent: 100,
      downloadUrl: `/api/download-file/${id}`
    });
  }
  res.status(404).json({ error: 'İndirme bulunamadı' });
});

// ════════════════════════════════════════════════════════════════════════════
// API 4: Serve file
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/download-file/:id', (req, res) => {
  const item = readyDownloads.get(req.params.id);
  if (!item || !fs.existsSync(item.filePath)) {
    return res.status(404).send('Dosya bulunamadı veya süresi doldu.');
  }

  const stat = fs.statSync(item.filePath);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(item.filename)}"`);

  res.download(item.filePath, item.filename, err => {
    if (err && !res.headersSent) {
      console.error('File send error:', err.message);
    }
    setTimeout(() => {
      try {
        if (fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath);
        readyDownloads.delete(req.params.id);
      } catch (e) { console.error('Cleanup error:', e.message); }
    }, 5000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// API 5: Cancel
// ════════════════════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════════════════════
// Health check endpoint for Render
// ════════════════════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ytdlp: YTDLP_PATH,
    ffmpeg: FFMPEG_PATH,
    activeDownloads: activeDownloads.size,
    readyDownloads: readyDownloads.size
  });
});

const PORT = process.env.PORT || 3820;
server.listen(PORT, () => {
  console.log(`YouTube Downloader running on port ${PORT}`);
  console.log(`yt-dlp: ${YTDLP_PATH}`);
  console.log(`ffmpeg: ${FFMPEG_PATH}`);
});
