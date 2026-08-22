document.addEventListener('DOMContentLoaded', () => {
  // UI Elements
  const ytUrlInput = document.getElementById('ytUrlInput');
  const fetchBtn = document.getElementById('fetchBtn');
  const fetchBtnText = document.getElementById('fetchBtnText');
  const pasteBtn = document.getElementById('pasteBtn');
  const errorToast = document.getElementById('errorToast');
  const errorMessage = document.getElementById('errorMessage');
  
  const videoInfoCard = document.getElementById('videoInfoCard');
  const videoThumb = document.getElementById('videoThumb');
  const videoDuration = document.getElementById('videoDuration');
  const videoTitle = document.getElementById('videoTitle');
  const videoChannel = document.getElementById('videoChannel');
  const qualitySelect = document.getElementById('qualitySelect');
  const qualitySelectorGroup = document.getElementById('qualitySelectorGroup');
  const mp3InfoGroup = document.getElementById('mp3InfoGroup');
  const startDownloadBtn = document.getElementById('startDownloadBtn');
  
  const activeList = document.getElementById('activeList');
  const emptyActiveState = document.getElementById('emptyActiveState');
  const activeCountBadge = document.getElementById('activeCountBadge');

  let currentVideoInfo = null;
  let selectedFormat = 'video'; // 'video' or 'mp3'
  const activeDownloadsMap = new Map(); // downloadId -> element map

  // Setup WebSocket connection
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  let ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('WebSocket connection established');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWsEvent(data);
    } catch (e) {
      console.error('Error parsing WS message', e);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket closed, attempting reconnect in 3s...');
    setTimeout(() => {
      ws = new WebSocket(wsUrl);
    }, 3000);
  };

  // 1. Handle Paste Button
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        ytUrlInput.value = text.trim();
        fetchVideoInfo();
      }
    } catch (err) {
      showError('Panodan okuma izni verilemedi. Lütfen bağlantıyı elle yapıştırın.');
    }
  });

  // 2. Fetch Video Info on Button Click or Enter
  fetchBtn.addEventListener('click', fetchVideoInfo);
  ytUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') fetchVideoInfo();
  });

  // Auto-fetch on input change if full YouTube URL is pasted
  ytUrlInput.addEventListener('input', () => {
    const val = ytUrlInput.value.trim();
    if (val.includes('youtube.com/watch') || val.includes('youtu.be/')) {
      fetchVideoInfo();
    }
  });

  function isValidYoutubeUrl(url) {
    const trimmed = url.trim();
    return (
      trimmed.includes('youtube.com/watch') ||
      trimmed.includes('youtu.be/') ||
      trimmed.includes('youtube.com/shorts/') ||
      trimmed.includes('music.youtube.com/')
    );
  }

  async function fetchVideoInfo() {
    const url = ytUrlInput.value.trim();
    if (!url) {
      showError('Lütfen bir YouTube bağlantısı girin.');
      return;
    }

    if (!isValidYoutubeUrl(url)) {
      showError('Geçersiz bağlantı! Lütfen geçerli bir YouTube video veya müzik adresi girin.');
      return;
    }

    hideError();
    setFetchLoading(true);

    try {
      const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Video bilgileri alınamadı. Geçersiz veya gizli YouTube bağlantısı olabilir.');
      }

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

    // Populate available resolutions
    qualitySelect.innerHTML = '';
    
    // Add "En Yüksek Kalite"
    const defaultOpt = document.createElement('option');
    defaultOpt.value = 'best';
    defaultOpt.textContent = 'En Yüksek Kalite (Otomatik)';
    qualitySelect.appendChild(defaultOpt);

    if (info.availableResolutions && info.availableResolutions.length > 0) {
      info.availableResolutions.forEach(res => {
        const opt = document.createElement('option');
        opt.value = res;
        opt.textContent = `${res} High-Def`;
        if (res === '1080p') opt.selected = true;
        qualitySelect.appendChild(opt);
      });
    }

    videoInfoCard.classList.remove('hidden');
  }

  // 3. Toggle Format (Video vs MP3)
  document.querySelectorAll('.segment-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
      const target = e.currentTarget;
      target.classList.add('active');

      selectedFormat = target.dataset.type;

      if (selectedFormat === 'mp3') {
        qualitySelectorGroup.classList.add('hidden');
        mp3InfoGroup.classList.remove('hidden');
      } else {
        qualitySelectorGroup.classList.remove('hidden');
        mp3InfoGroup.classList.add('hidden');
      }
    });
  });

  // 4. Start Download Request
  startDownloadBtn.addEventListener('click', () => {
    if (!ytUrlInput.value.trim()) return;

    const url = ytUrlInput.value.trim();
    const quality = qualitySelect.value;
    const title = currentVideoInfo ? currentVideoInfo.title : 'YouTube_Medya';

    const downloadId = 'dl_' + Date.now();
    createActiveDownloadCard(downloadId, title);

    const streamUrl = `/api/stream?url=${encodeURIComponent(url)}&formatType=${selectedFormat}&quality=${quality}&title=${encodeURIComponent(title)}`;

    const card = activeDownloadsMap.get(downloadId);
    if (card) {
      if (card._pollInterval) clearInterval(card._pollInterval);
      const cancelBtn = card.querySelector('.cancel-download-btn');
      if (cancelBtn) cancelBtn.remove();

      const badge = card.querySelector('.pill-badge');
      badge.className = 'pill-badge completed';
      badge.textContent = 'İndiriliyor';

      const fill = card.querySelector('.progress-fill');
      fill.style.width = '100%';

      const metaRow = card.querySelector('.download-meta-row');
      metaRow.innerHTML = `
        <span><i class="ri-check-line"></i> ${title}</span>
        <a href="${streamUrl}" class="save-device-btn" download>
          <i class="ri-download-2-line"></i> Cihazına Kaydet
        </a>
      `;
    }

    // Trigger immediate direct browser download
    triggerBrowserDownload(streamUrl, `${title}.${selectedFormat === 'mp3' ? 'mp3' : 'mp4'}`);

    // Reset input
    ytUrlInput.value = '';
    videoInfoCard.classList.add('hidden');
  });

  // 5. Handle WebSocket Progress & Status Events
  function handleWsEvent(data) {
    if (data.event === 'start') {
      createActiveDownloadCard(data.downloadId, currentVideoInfo ? currentVideoInfo.title : 'Medya Hazırlanıyor...');
    } else if (data.event === 'progress') {
      updateActiveDownloadCard(data);
    } else if (data.event === 'status_update') {
      updateActiveStatusText(data.downloadId, data.message);
    } else if (data.event === 'complete') {
      completeActiveDownloadCard(data);
    } else if (data.event === 'error') {
      markActiveDownloadError(data.downloadId, data.error);
    } else if (data.event === 'cancelled') {
      removeActiveDownloadCard(data.downloadId);
    }
  }

  function createActiveDownloadCard(downloadId, title) {
    emptyActiveState.classList.add('hidden');

    const card = document.createElement('div');
    card.className = 'download-item';
    card.id = downloadId;

    card.innerHTML = `
      <div class="download-item-top">
        <div class="download-item-title" title="${title}">${title}</div>
        <div class="download-item-actions">
          <span class="pill-badge downloading">Hazırlanıyor</span>
          <button class="cancel-download-btn" title="İndirmeyi İptal Et">
            <i class="ri-close-line"></i> İptal
          </button>
        </div>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: 0%"></div>
      </div>
      <div class="download-meta-row">
        <span class="speed-text"><i class="ri-pulse-line"></i> 0.0 KiB/s</span>
        <span class="size-text">%0 / --</span>
        <span class="eta-text">Kalan: --:--</span>
      </div>
    `;

    // Attach cancel click handler
    const cancelBtn = card.querySelector('.cancel-download-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', async () => {
        try {
          cancelBtn.disabled = true;
          cancelBtn.style.opacity = '0.5';
          if (pollInterval) clearInterval(pollInterval);
          await fetch('/api/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ downloadId })
          });
        } catch (e) {
          console.error('Cancel request failed', e);
        }
      });
    }

    // HTTP Polling fallback for Vercel (every 1 second)
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${downloadId}`);
        if (!res.ok) {
          if (res.status === 404 && activeDownloadsMap.has(downloadId)) {
            // Check if card is completed, else ignore
          }
          return;
        }
        const data = await res.json();
        if (data.event === 'progress') {
          updateActiveDownloadCard(data);
        } else if (data.event === 'complete') {
          clearInterval(pollInterval);
          completeActiveDownloadCard(data);
        }
      } catch (e) {
        // Polling error silently ignored
      }
    }, 1200);

    card._pollInterval = pollInterval;

    activeList.prepend(card);
    activeDownloadsMap.set(downloadId, card);
    updateActiveCountBadge();
  }

  function updateActiveDownloadCard(data) {
    const card = activeDownloadsMap.get(data.downloadId);
    if (!card) return;

    const fill = card.querySelector('.progress-fill');
    const badge = card.querySelector('.pill-badge');
    const speedText = card.querySelector('.speed-text');
    const sizeText = card.querySelector('.size-text');
    const etaText = card.querySelector('.eta-text');

    badge.className = 'pill-badge downloading';
    badge.textContent = 'İndiriliyor';

    fill.style.width = `${data.percent}%`;
    speedText.innerHTML = `<i class="ri-pulse-line"></i> ${data.speed}`;
    sizeText.textContent = `%${data.percent.toFixed(1)} / ${data.totalSize}`;
    etaText.textContent = `Kalan: ${data.eta}`;
  }

  function updateActiveStatusText(downloadId, message) {
    const card = activeDownloadsMap.get(downloadId);
    if (!card) return;
    const badge = card.querySelector('.pill-badge');
    badge.className = 'pill-badge converting';
    badge.textContent = message || 'Dönüştürülüyor';
  }

  function markActiveDownloadError(downloadId, errorMsg) {
    const card = activeDownloadsMap.get(downloadId);
    if (!card) return;
    const badge = card.querySelector('.pill-badge');
    badge.className = 'pill-badge failed';
    badge.textContent = 'Hata';
  }

  function completeActiveDownloadCard(data) {
    const card = activeDownloadsMap.get(data.downloadId);
    if (!card) return;

    if (card._pollInterval) clearInterval(card._pollInterval);

    const cancelBtn = card.querySelector('.cancel-download-btn');
    if (cancelBtn) cancelBtn.remove();

    const badge = card.querySelector('.pill-badge');
    badge.className = 'pill-badge completed';
    badge.textContent = 'Hazır!';

    const fill = card.querySelector('.progress-fill');
    fill.style.width = '100%';

    const metaRow = card.querySelector('.download-meta-row');
    metaRow.innerHTML = `
      <span><i class="ri-check-line"></i> ${data.filename}</span>
      <a href="${data.downloadUrl}" class="save-device-btn" download="${data.filename}">
        <i class="ri-download-2-line"></i> Cihazına Kaydet
      </a>
    `;

    // Trigger automatic browser download
    triggerBrowserDownload(data.downloadUrl, data.filename);
  }

  function triggerBrowserDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function removeActiveDownloadCard(downloadId) {
    const card = activeDownloadsMap.get(downloadId);
    if (card) {
      if (card._pollInterval) clearInterval(card._pollInterval);
      card.remove();
      activeDownloadsMap.delete(downloadId);
      updateActiveCountBadge();
    }
  }

  function updateActiveCountBadge() {
    const count = activeDownloadsMap.size;
    activeCountBadge.textContent = `${count} İşlem`;
    if (count === 0) {
      emptyActiveState.classList.remove('hidden');
    }
  }

  // Helper Functions
  function setFetchLoading(isLoading) {
    if (isLoading) {
      fetchBtn.disabled = true;
      fetchBtnText.textContent = 'Hazırlanıyor...';
      fetchBtn.querySelector('i').className = 'ri-loader-4-line spin-icon';
    } else {
      fetchBtn.disabled = false;
      fetchBtnText.textContent = 'Hazırla';
      fetchBtn.querySelector('i').className = 'ri-arrow-right-s-line';
    }
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    errorToast.classList.remove('hidden');
  }

  function hideError() {
    errorToast.classList.add('hidden');
  }
});
