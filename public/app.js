document.addEventListener('DOMContentLoaded', () => {
  // ── UI Elements ──────────────────────────────────────────────────────────
  const ytUrlInput         = document.getElementById('ytUrlInput');
  const fetchBtn           = document.getElementById('fetchBtn');
  const fetchBtnText       = document.getElementById('fetchBtnText');
  const pasteBtn           = document.getElementById('pasteBtn');
  const errorToast         = document.getElementById('errorToast');
  const errorMessage       = document.getElementById('errorMessage');
  const videoInfoCard      = document.getElementById('videoInfoCard');
  const videoThumb         = document.getElementById('videoThumb');
  const videoDuration      = document.getElementById('videoDuration');
  const videoTitle         = document.getElementById('videoTitle');
  const videoChannel       = document.getElementById('videoChannel');
  const qualitySelect      = document.getElementById('qualitySelect');
  const qualitySelectorGroup = document.getElementById('qualitySelectorGroup');
  const mp3InfoGroup       = document.getElementById('mp3InfoGroup');
  const startDownloadBtn   = document.getElementById('startDownloadBtn');
  const activeList         = document.getElementById('activeList');
  const emptyActiveState   = document.getElementById('emptyActiveState');
  const activeCountBadge   = document.getElementById('activeCountBadge');

  let currentVideoInfo = null;
  let selectedFormat   = 'video';

  // downloadId -> { card, pollTimer, format }
  const downloadsMap = new Map();

  // ── WebSocket ─────────────────────────────────────────────────────────────
  let ws = null;
  let wsReconnectDelay = 1000;
  const WS_MAX_DELAY = 15000;

  function connectWs() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      ws = new WebSocket(`${protocol}//${window.location.host}`);
    } catch (e) {
      console.error('[WS] Creation failed:', e);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[WS] Connected');
      wsReconnectDelay = 1000; // reset delay on success
    };

    ws.onmessage = (event) => {
      try {
        handleServerEvent(JSON.parse(event.data));
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };

    ws.onclose = () => {
      console.log('[WS] Closed');
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  function scheduleReconnect() {
    setTimeout(() => {
      connectWs();
      wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, WS_MAX_DELAY);
    }, wsReconnectDelay);
  }

  connectWs();

  // ── Central event handler (WS + polling share this) ──────────────────────
  function handleServerEvent(data) {
    switch (data.event) {
      case 'progress':
        updateProgress(data);
        break;
      case 'status_update':
        updateStatusBadge(data.downloadId, data.message);
        break;
      case 'complete':
        onComplete(data);
        break;
      case 'error':
        onError(data);
        break;
      case 'cancelled':
        removeCard(data.downloadId);
        break;
    }
  }

  // ── Paste Button ──────────────────────────────────────────────────────────
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        ytUrlInput.value = text.trim();
        fetchVideoInfo();
      }
    } catch {
      showError('Panoya erişim izni verilmedi. Lütfen bağlantıyı elle yapıştırın.');
    }
  });

  // ── Fetch Button / Enter ──────────────────────────────────────────────────
  fetchBtn.addEventListener('click', fetchVideoInfo);
  ytUrlInput.addEventListener('keypress', e => { if (e.key === 'Enter') fetchVideoInfo(); });

  ytUrlInput.addEventListener('input', () => {
    const v = ytUrlInput.value.trim();
    if (v.includes('youtube.com/watch') || v.includes('youtu.be/')) {
      fetchVideoInfo();
    }
  });

  function isValidYoutubeUrl(url) {
    if (!url) return false;
    const lower = url.trim().toLowerCase();
    return lower.includes('youtube.com') || lower.includes('youtu.be');
  }

  async function fetchVideoInfo() {
    const url = ytUrlInput.value.trim();
    if (!url) { showError('Lütfen bir YouTube bağlantısı girin.'); return; }
    if (!isValidYoutubeUrl(url)) { showError('Geçersiz bağlantı! Lütfen geçerli bir YouTube adresi girin.'); return; }

    hideError();
    setFetchLoading(true);

    try {
      const resp = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Video bilgileri alınamadı.');
      currentVideoInfo = data;
      renderVideoInfo(data);
    } catch (err) {
      showError(err.message);
      videoInfoCard.classList.add('hidden');
    } finally {
      setFetchLoading(false);
    }
  }

  function renderVideoInfo(info) {
    videoThumb.src = info.thumbnail;
    videoDuration.textContent = info.duration;
    videoTitle.textContent = info.title;
    videoChannel.querySelector('span').textContent = info.uploader;

    qualitySelect.innerHTML = '';
    const bestOpt = document.createElement('option');
    bestOpt.value = 'best';
    bestOpt.textContent = 'En Yüksek Kalite (Otomatik)';
    qualitySelect.appendChild(bestOpt);

    if (info.availableResolutions && info.availableResolutions.length > 0) {
      info.availableResolutions.forEach(res => {
        const opt = document.createElement('option');
        opt.value = res;
        const label = res === '2160p' ? '4K Ultra HD (2160p)'
                    : res === '1440p' ? 'Quad HD (1440p)'
                    : res === '1080p' ? 'Full HD (1080p)'
                    : res === '720p'  ? 'HD (720p)'
                    : res;
        opt.textContent = label;
        if (res === '1080p') opt.selected = true;
        qualitySelect.appendChild(opt);
      });
    }

    videoInfoCard.classList.remove('hidden');
    videoInfoCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── Format Toggle ─────────────────────────────────────────────────────────
  document.querySelectorAll('.segment-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      selectedFormat = e.currentTarget.dataset.type;
      if (selectedFormat === 'mp3') {
        qualitySelectorGroup.classList.add('hidden');
        mp3InfoGroup.classList.remove('hidden');
      } else {
        qualitySelectorGroup.classList.remove('hidden');
        mp3InfoGroup.classList.add('hidden');
      }
    });
  });

  // ── Start Download ────────────────────────────────────────────────────────
  startDownloadBtn.addEventListener('click', async () => {
    const url = ytUrlInput.value.trim();
    if (!url) return;

    startDownloadBtn.disabled = true;
    startDownloadBtn.style.opacity = '0.6';

    try {
      const resp = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, formatType: selectedFormat, quality: qualitySelect.value })
      });

      const data = await resp.json();
      if (!resp.ok) {
        showError(data.error || 'İndirme başlatılamadı.');
        return;
      }

      const { downloadId } = data;
      const title = currentVideoInfo ? currentVideoInfo.title : 'YouTube Medya';

      // Create the download card
      createCard(downloadId, title, selectedFormat);

      // Start HTTP polling as backup (WS is primary)
      startPolling(downloadId);

      // Reset UI
      ytUrlInput.value = '';
      videoInfoCard.classList.add('hidden');
      currentVideoInfo = null;
    } catch (err) {
      console.error(err);
      showError('Sunucu bağlantı hatası. Lütfen tekrar deneyin.');
    } finally {
      startDownloadBtn.disabled = false;
      startDownloadBtn.style.opacity = '1';
    }
  });

  // ── Card Creation ─────────────────────────────────────────────────────────
  function createCard(downloadId, title, format) {
    emptyActiveState.classList.add('hidden');

    const card = document.createElement('div');
    card.className = 'download-item';
    card.id = `card-${downloadId}`;
    card.innerHTML = `
      <div class="download-item-top">
        <div class="download-item-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="download-item-actions">
          <span class="pill-badge preparing">Hazırlanıyor</span>
          <button class="cancel-download-btn" data-id="${downloadId}" title="İptal Et">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            İptal
          </button>
        </div>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: 0%"></div>
      </div>
      <div class="download-meta-row">
        <span class="speed-text">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/></svg>
          —
        </span>
        <span class="size-text">%0 / —</span>
        <span class="eta-text">Kalan: —</span>
      </div>
    `;

    card.querySelector('.cancel-download-btn').addEventListener('click', () => {
      cancelDownload(downloadId);
    });

    activeList.prepend(card);
    downloadsMap.set(downloadId, { card, format, pollTimer: null });
    updateBadge();
    return card;
  }

  // ── Polling (fallback if WS misses events) ────────────────────────────────
  function startPolling(downloadId) {
    const entry = downloadsMap.get(downloadId);
    if (!entry) return;

    const timer = setInterval(async () => {
      if (!downloadsMap.has(downloadId)) { clearInterval(timer); return; }

      try {
        const resp = await fetch(`/api/status/${downloadId}`);
        if (resp.status === 404) { clearInterval(timer); return; }
        if (!resp.ok) return;
        const data = await resp.json();
        handleServerEvent(data);
        if (data.event === 'complete' || data.event === 'error') {
          clearInterval(timer);
        }
      } catch (e) { /* network error — keep polling */ }
    }, 2000);

    entry.pollTimer = timer;
  }

  // ── Progress Update ───────────────────────────────────────────────────────
  function updateProgress(data) {
    const entry = downloadsMap.get(data.downloadId);
    if (!entry) return;
    const { card } = entry;

    const fill  = card.querySelector('.progress-fill');
    const badge = card.querySelector('.pill-badge');
    const speed = card.querySelector('.speed-text');
    const size  = card.querySelector('.size-text');
    const eta   = card.querySelector('.eta-text');

    if (fill)  fill.style.width = `${data.percent}%`;
    if (badge) { badge.className = 'pill-badge downloading'; badge.textContent = 'İndiriliyor'; }
    if (speed) {
      speed.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/></svg>
        ${data.speed || '—'}
      `;
    }
    if (size)  size.textContent = `%${parseFloat(data.percent || 0).toFixed(1)} / ${data.totalSize || '—'}`;
    if (eta)   eta.textContent  = `Kalan: ${data.eta || '—'}`;
  }

  function updateStatusBadge(downloadId, message) {
    const entry = downloadsMap.get(downloadId);
    if (!entry) return;
    const badge = entry.card.querySelector('.pill-badge');
    if (badge) { badge.className = 'pill-badge converting'; badge.textContent = message || 'İşleniyor...'; }
  }

  // ── Complete ──────────────────────────────────────────────────────────────
  function onComplete(data) {
    const entry = downloadsMap.get(data.downloadId);
    if (!entry) return;

    const { card, pollTimer } = entry;
    if (pollTimer) clearInterval(pollTimer);

    const fill  = card.querySelector('.progress-fill');
    const badge = card.querySelector('.pill-badge');
    const meta  = card.querySelector('.download-meta-row');
    const cancelBtn = card.querySelector('.cancel-download-btn');

    if (fill)      fill.style.width = '100%';
    if (badge)     { badge.className = 'pill-badge completed'; badge.textContent = 'Hazır!'; }
    if (cancelBtn) cancelBtn.remove();

    const ext = entry.format === 'mp3' ? 'mp3' : 'mp4';
    const displayName = data.filename || ('download.' + ext);

    if (meta) {
      meta.innerHTML = `
        <span class="completed-filename">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#30d158" stroke-width="2.5" stroke-linecap="round"><polyline points="20,6 9,17 4,12"/></svg>
          ${escapeHtml(displayName)}
        </span>
        <a href="${data.downloadUrl}" class="save-device-btn" download="${escapeHtml(displayName)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21,15v4a2,2,0,0,1-2,2H5a2,2,0,0,1-2-2V15"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Cihazına Kaydet (${ext.toUpperCase()})
        </a>
      `;
    }
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  function onError(data) {
    const entry = downloadsMap.get(data.downloadId);
    if (!entry) return;

    const { card, pollTimer } = entry;
    if (pollTimer) clearInterval(pollTimer);

    const badge = card.querySelector('.pill-badge');
    const meta  = card.querySelector('.download-meta-row');
    const cancelBtn = card.querySelector('.cancel-download-btn');

    if (badge)     { badge.className = 'pill-badge failed'; badge.textContent = 'Hata'; }
    if (cancelBtn) cancelBtn.remove();
    if (meta) {
      meta.innerHTML = `
        <span class="error-message-text">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff6b6b" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          ${escapeHtml(data.error || 'İndirme hatası')}
        </span>
      `;
    }

    downloadsMap.delete(data.downloadId);
    updateBadge();
  }

  // ── Cancel ────────────────────────────────────────────────────────────────
  async function cancelDownload(downloadId) {
    const entry = downloadsMap.get(downloadId);
    if (entry && entry.pollTimer) clearInterval(entry.pollTimer);

    try {
      await fetch('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ downloadId })
      });
    } catch (e) { console.error('Cancel failed:', e); }

    removeCard(downloadId);
  }

  function removeCard(downloadId) {
    const entry = downloadsMap.get(downloadId);
    if (entry) {
      if (entry.pollTimer) clearInterval(entry.pollTimer);
      entry.card.remove();
      downloadsMap.delete(downloadId);
      updateBadge();
    }
  }

  function updateBadge() {
    const count = downloadsMap.size;
    activeCountBadge.textContent = `${count} İşlem`;
    if (count === 0) emptyActiveState.classList.remove('hidden');
    else emptyActiveState.classList.add('hidden');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function setFetchLoading(on) {
    const icon = fetchBtn.querySelector('svg, i');
    if (on) {
      fetchBtn.disabled = true;
      fetchBtnText.textContent = 'Yükleniyor...';
      if (icon) icon.classList.add('spin-icon');
    } else {
      fetchBtn.disabled = false;
      fetchBtnText.textContent = 'Hazırla';
      if (icon) icon.classList.remove('spin-icon');
    }
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    errorToast.classList.remove('hidden');
  }

  function hideError() {
    errorToast.classList.add('hidden');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
});
