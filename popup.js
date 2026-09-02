document.addEventListener('DOMContentLoaded', async () => {
  const downloadBtn = document.getElementById('download-btn');
  const copyBtn = document.getElementById('copy-btn');
  const optionSelect = document.getElementById('option-select');
  const optionSection = document.getElementById('option-section');
  const statusLabel = document.getElementById('status');
  const targetTitleLabel = document.getElementById('target-title');
  const targetTypeBadge = document.getElementById('target-type');
  const folderContent = document.getElementById('folder-content');
  const fileListContainer = document.getElementById('file-list-container');
  const selectAllCheckbox = document.getElementById('select-all-checkbox');
  const reloadBtn = document.getElementById('reload-btn');
  const bulkTip = document.getElementById('bulk-tip');
  const closeTipBtn = document.getElementById('close-tip');

  const audioCaptureSection = document.getElementById('audio-capture-section');
  const recordSpeedSelect = document.getElementById('record-speed-select');
  const outputSpeedSelect = document.getElementById('output-speed-select');
  const captureAudioBtn = document.getElementById('capture-audio-btn');
  const audioCaptureTitle = document.getElementById('audio-capture-title');

  const pdfCaptureSection = document.getElementById('pdf-capture-section');
  const capturePdfBtn = document.getElementById('capture-pdf-btn');

  chrome.storage.local.get(['tipDismissed'], (res) => {
    if (!res.tipDismissed) {
      bulkTip.style.display = 'block';
    }
  });

  closeTipBtn.addEventListener('click', () => {
    bulkTip.style.display = 'none';
    chrome.storage.local.set({ tipDismissed: true });
  });

  async function proxyFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH', url, options }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response && response.success) {
          resolve({
            text: () => Promise.resolve(response.text),
            status: response.status,
            ok: response.status >= 200 && response.status < 300
          });
        } else {
          reject(new Error(response ? response.error : 'Unknown error'));
        }
      });
    });
  }

  const ICONS = {
    chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
    chevronDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
    reload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`
  };

  reloadBtn.innerHTML = ICONS.reload;

  let currentTarget = {
    url: "", id: "", type: "file", title: "", downloadUrl: "", streams: [], folderTree: null, isScanning: false
  };
  let statusInterval = null;

  function updateStatusUI(progress) {
    const { current, total, lastFileName, statusText } = progress;
    const progressCount = total > 1 ? `(${current}/${total}) ` : "";
    let action = "Downloading";
    let warning = "";
    
    if (statusText) {
      if (statusText.includes('|')) {
        const parts = statusText.split('|');
        action = parts[0];
        warning = parts[1];
      } else {
        action = statusText;
      }
    }
    
    let fileDisplay = lastFileName ? `<b>${lastFileName}</b>` : "<i>Preparing...</i>";
    let finalHtml = `${progressCount}${action}: ${fileDisplay}`;
    if (action === "Starting...") finalHtml = `<i>Initializing queue...</i>`;
    if (warning) finalHtml += `<br><span style="color: #ef4444; font-weight: 600; margin-top: 6px; display: block;">⚠️ ${warning}</span>`;
    
    statusLabel.innerHTML = finalHtml;
    downloadBtn.disabled = true;
    targetTitleLabel.innerText = "Fetchy";
    targetTypeBadge.innerText = "BUSY";
    const targetHeader = document.querySelector('.target-header');
    if (targetHeader) targetHeader.style.marginBottom = "0";
    folderContent.style.display = "none";
    optionSection.style.display = "none";
  }

  async function init() {
    chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_STATUS' }, async response => {
      if (response && response.isProcessing) {
        updateStatusUI(response.progress);
        startPolling();
      } else {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return;
        const currentUrl = tab.url;
        const cache = await chrome.storage.local.get(['lastState']);
        if (cache.lastState && cache.lastState.url === currentUrl && !cache.lastState.isCourse) {
          currentTarget = cache.lastState;
          if (currentTarget.type === "folder") {
            renderState();
            if (!currentTarget.isScanning) statusLabel.innerText = "Ready.";
          } else {
            analyzeUrl(currentUrl, tab);
          }
        } else {
          analyzeUrl(currentUrl, tab);
        }
        startPolling();
      }
    });
  }

  function startPolling() {
    setInterval(() => {
      chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_STATUS' }, response => {
        if (response && response.isProcessing) {
          updateStatusUI(response.progress);
        } else if (downloadBtn.disabled && !currentTarget.isScanning && currentTarget.type !== "none") {
          statusLabel.innerText = "Complete.";
          downloadBtn.disabled = false;
          updateDownloadBtnState();
          saveState();
        }
      });
    }, 1000);
  }

  init();

  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url) {
      analyzeUrl(tab.url, tab);
    }
  });

  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.title) {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.id === tabId) {
        analyzeUrl(activeTab.url, activeTab);
      }
    }
  });

  async function analyzeUrl(url, tabObj) {
    currentTarget = {
      id: '', type: 'none', title: '', url: url,
      downloadUrl: '', folderTree: null, isScanning: false,
      streams: []
    };
    renderState();

    const fileId = extractFileId(url);
    const folderId = extractFolderId(url);
    const docInfo = extractDocInfo(url);

    if (folderId) {
      currentTarget.id = folderId; currentTarget.type = "folder";
      targetTitleLabel.innerText = "Folder";
      renderState();
      autoScanFolder();
    } else if (docInfo) {
      currentTarget.id = docInfo.id; currentTarget.type = docInfo.type;
      let cleanTitle = tabObj.title || "Document";
      cleanTitle = cleanTitle.replace(/ - Google (Docs|Sheets|Slides|Documents|Spreadsheets|Presentations)$/, "");
      currentTarget.title = cleanTitle;
      targetTitleLabel.innerText = currentTarget.title;
      renderState();
      let internalType = "doc";
      if (currentTarget.type === "spreadsheets") internalType = "sheet";
      if (currentTarget.type === "presentation") internalType = "slide";
      setupExportOptions(internalType);
      saveState();
      statusLabel.innerText = "Ready.";
    } else if (fileId) {
      currentTarget.id = fileId; currentTarget.type = "file";
      let cleanTitle = tabObj.title || "File";
      cleanTitle = cleanTitle.replace(/ - Google Drive$/, "");
      currentTarget.title = cleanTitle;
      targetTitleLabel.innerText = currentTarget.title;
      renderState();
      await checkFileInfo(fileId);
      saveState();
      statusLabel.innerText = "Complete.";
    } else {
      currentTarget.id = "";
      currentTarget.title = tabObj.title || "Web Page";
      statusLabel.innerText = "Analyzing page content...";

      chrome.scripting.executeScript({
        target: { tabId: tabObj.id, allFrames: false },
        func: scanKhokhoahocCourseInTab
      }, (results) => {
        if (results && results[0] && results[0].result) {
          const courseData = results[0].result;
          currentTarget.id = 'khokhoahoc_course';
          currentTarget.type = 'folder';
          currentTarget.isCourse = true;
          currentTarget.title = courseData.courseTitle;
          currentTarget.folderTree = courseData.rootNode;
          renderState();
          statusLabel.innerText = `Ready. Found ${courseData.totalLessons} lessons in course.`;
          saveState();
          return;
        }

        currentTarget.type = "video";
        renderState();
        statusLabel.innerText = "Scanning page for media...";
        detectPageMedia(tabObj.id);
      });
    }
  }

  function detectPageMedia(tabId) {
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: true },
      func: () => {
        const hasVideo = !!document.querySelector('video');
        const hasPDF = !!document.querySelector('.react-pdf__Page__canvas');
        return { hasVideo, hasPDF };
      }
    }, (results) => {
      let videoFound = false;
      let pdfFound = false;
      if (results && results.length > 0) {
        for (const res of results) {
          if (res.result) {
            if (res.result.hasVideo) videoFound = true;
            if (res.result.hasPDF) pdfFound = true;
          }
        }
      }

      audioCaptureSection.style.display = videoFound ? "block" : "none";
      pdfCaptureSection.style.display = pdfFound ? "block" : "none";

      if (videoFound && pdfFound) {
        statusLabel.innerText = "Ready. Video & PDF found!";
      } else if (videoFound) {
        statusLabel.innerText = "Ready to capture audio.";
      } else if (pdfFound) {
        statusLabel.innerText = "Ready to extract PDF.";
      } else {
        // Fallback
        audioCaptureSection.style.display = "block";
        statusLabel.innerText = "Ready to capture audio.";
      }
    });
  }

  function saveState() { chrome.storage.local.set({ lastState: currentTarget }); }

  function renderState() {
    const type = currentTarget.type.toLowerCase();
    targetTypeBadge.innerText = currentTarget.isCourse ? "COURSE" : type.toUpperCase();
    const cleanTitle = (currentTarget.title || "Item").replace(/\.(docx|xlsx|pptx|gdoc|gsheet|gslides)$/i, "");
    targetTitleLabel.innerText = cleanTitle;
    const selectAllGroup = document.getElementById('select-all-group');
    const targetHeader = document.querySelector('.target-header');
    targetHeader.style.marginBottom = "0";
    if (type === "video") {
      folderContent.style.display = "none";
      selectAllGroup.style.display = "none";
      optionSection.style.display = "none";
      downloadBtn.style.display = "none";
      copyBtn.style.display = "none";
      return;
    } else {
      audioCaptureSection.style.display = "none";
      pdfCaptureSection.style.display = "none";
      downloadBtn.style.display = "inline-flex";
      copyBtn.style.display = "inline-flex";
    }

    if (currentTarget.type === "folder") {
      folderContent.style.display = "block";
      selectAllGroup.style.display = "flex";
      if (!currentTarget.isScanning && currentTarget.folderTree) targetHeader.style.marginBottom = "12px";
      renderTree();
      updateDownloadBtnState();
      updateSelectAllState();
    } else {
      folderContent.style.display = "none";
      selectAllGroup.style.display = "none";
      targetHeader.style.marginBottom = "0";
      const isDoc = ["document", "spreadsheets", "presentation"].includes(currentTarget.type);
      const isDownloadable = currentTarget.downloadUrl || currentTarget.streams.length > 0 || isDoc;
      downloadBtn.disabled = !isDownloadable;
      downloadBtn.innerText = "Download";
      if (currentTarget.type === "document") {
        copyBtn.innerText = "Copy Text";
      } else {
        copyBtn.innerText = "Metadata";
      }
      if (isDoc) {
        let internalType = "doc";
        if (currentTarget.type === "spreadsheets") internalType = "sheet";
        if (currentTarget.type === "presentation") internalType = "slide";
        setupExportOptions(internalType);
      }
      else if (currentTarget.streams.length > 0) setupQualityOptions(currentTarget.streams, !!currentTarget.downloadUrl);
      else optionSection.style.display = "none";
    }
  }

  function renderTree() {
    fileListContainer.innerHTML = "";
    if (currentTarget.folderTree) {
      if (currentTarget.isCourse && currentTarget.folderTree.children && currentTarget.folderTree.children.length > 0) {
        currentTarget.folderTree.children.forEach(child => renderNode(child, fileListContainer, 0));
      } else {
        renderNode(currentTarget.folderTree, fileListContainer, 0);
      }
    }
  }

  function renderNode(node, container, depth) {
    if (!node) return;
    const isFolder = node.type === 'folder';
    const folderName = node.name || "Topic";
    const item = document.createElement('div');
    item.className = "folder-item";
    const row = document.createElement('div');
    row.className = "item-row";
    if (depth > 0) row.style.paddingLeft = `${depth * 16}px`;
    const toggleIconMarkup = isFolder ? (node.expanded ? ICONS.chevronDown : ICONS.chevronRight) : '';
    const displayName = isFolder ? folderName : (node.name || "Lesson").replace(/\.(docx|xlsx|pptx|gdoc|gsheet|gslides)$/i, "");
    row.innerHTML = `<span class="toggle-icon">${toggleIconMarkup}</span><input type="checkbox" class="node-checkbox" ${node.selected ? 'checked' : ''}><span class="${isFolder ? 'folder-name' : 'file-name'}">${displayName}</span>`;
    row.querySelector('.toggle-icon').addEventListener('click', (e) => { e.stopPropagation(); if (isFolder) { node.expanded = !node.expanded; renderTree(); saveState(); } });
    row.querySelector('.node-checkbox').addEventListener('click', (e) => { e.stopPropagation(); propagateDown(node, e.target.checked); propagateUp(currentTarget.folderTree); updateSelectAllState(); updateDownloadBtnState(); renderTree(); saveState(); });
    row.addEventListener('click', (e) => { if (e.target.closest('.toggle-icon') && isFolder) return; if (e.target.classList.contains('node-checkbox')) return; propagateDown(node, !node.selected); propagateUp(currentTarget.folderTree); updateSelectAllState(); updateDownloadBtnState(); renderTree(); saveState(); });
    item.appendChild(row);
    container.appendChild(item);
    if (isFolder && node.expanded && node.children) node.children.forEach(child => renderNode(child, container, depth + 1));
  }

  function propagateDown(node, selected) { node.selected = selected; if (node.children) node.children.forEach(child => propagateDown(child, selected)); }
  function propagateUp(node) { if (node.children && node.children.length > 0) { node.children.forEach(propagateUp); node.selected = node.children.every(child => child.selected); } }
  function updateDownloadBtnState() { if (currentTarget.type === "folder" && currentTarget.folderTree) { const allFiles = flattenFiles(currentTarget.folderTree); const selectedFiles = allFiles.filter(f => f.selected); downloadBtn.disabled = selectedFiles.length === 0; downloadBtn.innerText = selectedFiles.length === 0 ? "Select files" : (currentTarget.isCourse ? `Download Audio (${selectedFiles.length})` : `Download (${selectedFiles.length})`); } }
  function updateSelectAllState() { if (currentTarget.folderTree) { if (currentTarget.isCourse && currentTarget.folderTree.children && currentTarget.folderTree.children.length > 0) { selectAllCheckbox.checked = currentTarget.folderTree.children.every(c => c.selected); } else { selectAllCheckbox.checked = currentTarget.folderTree.selected; } } }
  function flattenFiles(node, path = "") { let files = []; const currentPath = path + (node.name && node.id !== 'course_root' ? node.name + "/" : ""); if (node.type !== 'folder') files.push({ ...node, path: path + node.name }); else if (node.children) node.children.forEach(child => { files = files.concat(flattenFiles(child, currentPath)); }); return files; }

  selectAllCheckbox.addEventListener('change', (e) => { if (currentTarget.folderTree) { propagateDown(currentTarget.folderTree, e.target.checked); renderTree(); updateDownloadBtnState(); saveState(); } });
  reloadBtn.addEventListener('click', async () => { statusLabel.innerText = "Reloading..."; await chrome.storage.local.remove(['lastState']); const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab && tab.url) analyzeUrl(tab.url, tab); });

  function startDynamicStatus() {
    if (statusInterval) clearInterval(statusInterval);
    const words = ["Scanning", "Mapping", "Indexing", "Fetching", "Parsing"];
    let wordIdx = 0, dotCount = 0, cycleCount = 0;
    statusInterval = setInterval(() => {
      if (!currentTarget.isScanning) { clearInterval(statusInterval); return; }
      dotCount++; if (dotCount > 3) { dotCount = 1; cycleCount++; }
      if (cycleCount >= 2) { cycleCount = 0; if (wordIdx < words.length - 1) wordIdx++; }
      statusLabel.innerText = words[wordIdx] + ".".repeat(dotCount);
    }, 500);
  }

  async function autoScanFolder() {
    if (currentTarget.isScanning) return;
    currentTarget.isScanning = true; startDynamicStatus(); renderState();
    try {
      currentTarget.folderTree = await recursiveScanTree(currentTarget.id, "");
      currentTarget.isScanning = false; currentTarget.title = currentTarget.folderTree.name;
      statusLabel.innerText = "Ready."; renderState(); saveState();
    } catch (e) { statusLabel.innerText = "Error: " + e.message; currentTarget.isScanning = false; }
  }

  async function recursiveScanTree(folderId, name) {
    const embeddedUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}`;
    const response = await proxyFetch(embeddedUrl);
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const folderName = name || (doc.title ? doc.title.replace(" - Google Drive", "") : "Folder");
    const node = { id: folderId, name: folderName, type: 'folder', children: [], expanded: true, selected: true };
    const links = doc.querySelectorAll('a[href]');
    const seenIds = new Set();
    const folderPromises = [];
    for (const link of links) {
      const href = link.getAttribute('href') || "";
      const childName = link.innerText.trim() || "Item";
      let id = "", type = "";
      if (href.includes("/folders/")) { const m = href.match(/\/folders\/([a-zA-Z0-9_-]+)/); if (m) { id = m[1]; type = "folder"; } }
      else if (href.includes("/file/d/")) { const m = href.match(/\/file\/d\/([a-zA-Z0-9_-]+)/); if (m) { id = m[1]; type = "file"; } }
      else if (href.includes("/d/")) { const m = href.match(/\/d\/([a-zA-Z0-9_-]+)/); if (m) { id = m[1]; type = "file"; } }
      if (id && type && !seenIds.has(id)) {
        seenIds.add(id);
        if (type === "folder") folderPromises.push(recursiveScanTree(id, childName).then(sub => { node.children.push(sub); renderTree(); }));
        else { const fullUrl = href.startsWith('http') ? href : `https://drive.google.com${href}`; node.children.push({ id, name: childName, type: 'file', url: fullUrl, selected: true }); renderTree(); }
      }
    }
    await Promise.all(folderPromises); return node;
  }

  downloadBtn.addEventListener('click', async () => {
    if (currentTarget.type === "folder") {
      const selectedFiles = flattenFiles(currentTarget.folderTree).filter(f => f.selected);
      if (selectedFiles.length === 0) { statusLabel.innerText = "No files selected."; return; }
      chrome.runtime.sendMessage({ type: 'START_DOWNLOAD_QUEUE', files: selectedFiles }, () => { statusLabel.innerText = "Processing in background..."; downloadBtn.disabled = true; });
    } else {
      const singleFile = { id: currentTarget.id, name: currentTarget.title, path: currentTarget.title, url: currentTarget.url };
      chrome.runtime.sendMessage({ type: 'START_DOWNLOAD_QUEUE', files: [singleFile] }, () => { statusLabel.innerText = "Processing in background..."; downloadBtn.disabled = true; });
    }
  });

  function extractConfirmLink(html) { const m = html.match(/href="(\/uc\?export=download[^"]+)/); if (m) return "https://docs.google.com" + m[1].replace(/&amp;/g, "&"); const dl = html.match(/"downloadUrl":"([^"]+)"/); if (dl) return dl[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&"); return null; }
  function extractFileId(url) { const m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/); return m ? m[1] : (url.includes('id=') ? new URLSearchParams(new URL(url).search).get('id') : null); }
  function extractFolderId(url) { const m = url.match(/\/folders\/([a-zA-Z0-9_-]+)/); return m ? m[1] : null; }
  function extractDocInfo(url) { const segs = ['document', 'spreadsheets', 'presentation']; for (const s of segs) { if (url.includes(`google.com/${s}/d/`)) { const m = url.match(new RegExp(`${s}/d/([a-zA-Z0-9_-]+)`)); if (m) return { id: m[1], type: s }; } } if (url.includes('google.com/docs/d/')) { const m = url.match(/\/docs\/d\/([a-zA-Z0-9_-]+)/); if (m) return { id: m[1], type: 'document' }; } return null; }
  function parseParams(text) { const p = {}; text.split('&').forEach(pair => { const [k, v] = pair.split('='); if (k && v) p[k] = v; }); return p; }
  function parseStreams(params) { const qMap = { '37': 1080, '22': 720, '59': 480, '18': 360 }; const sArr = []; if (params.fmt_stream_map) { decodeURIComponent(params.fmt_stream_map).split(',').forEach(s => { const p = s.split('|'); if (p.length >= 2) sArr.push({ priority: qMap[p[0]] || 0, url: p[1], itag: p[0] }); }); } return sArr.sort((a, b) => b.priority - a.priority); }

  async function checkFileInfo(id) {
    const ucUrl = `https://drive.google.com/uc?id=${id}&export=download`;
    const ucRes = await proxyFetch(ucUrl);
    const ucHtml = await ucRes.text();
    const tM = ucHtml.match(/<title>(.*?) - Google Drive<\/title>/);
    if (tM) { currentTarget.title = tM[1]; targetTitleLabel.innerText = currentTarget.title; }
    const cU = extractConfirmLink(ucHtml); if (cU) currentTarget.downloadUrl = cU;
    try {
      const infoRes = await proxyFetch(`https://drive.google.com/u/0/get_video_info?docid=${id}&drive_originator_app=303`);
      const infoT = await infoRes.text();
      const streams = parseStreams(parseParams(infoT));
      if (streams.length > 0) currentTarget.streams = streams;
    } catch (e) { }
    renderState();
  }

  function setupQualityOptions(streams, hasHighSpeedLink) { optionSelect.innerHTML = ""; if (hasHighSpeedLink) { const opt = document.createElement('option'); opt.value = "original"; opt.text = "Original Link"; optionSelect.appendChild(opt); } streams.forEach((s, i) => { const opt = document.createElement('option'); opt.value = i; opt.text = s.priority > 0 ? `${s.priority}p` : `itag ${s.itag}`; optionSelect.appendChild(opt); }); optionSection.style.display = "block"; }
  function setupExportOptions(type) { optionSelect.innerHTML = ""; let fmts = []; if (type === "doc") fmts = ["pdf", "docx", "txt", "odt"]; else if (type === "sheet") fmts = ["pdf", "xlsx", "csv", "ods"]; else if (type === "slide") fmts = ["pdf", "pptx", "txt"]; fmts.forEach(f => { const opt = document.createElement('option'); opt.value = f; opt.text = f.toUpperCase(); optionSelect.appendChild(opt); }); optionSection.style.display = "block"; }

  copyBtn.addEventListener('click', async () => {
    try {
      const isDoc = ["document", "spreadsheets", "presentation"].includes(currentTarget.type);
      if (isDoc && currentTarget.type === "document") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: extractGoogleDocTextInTab
          }, async (results) => {
            let extractedText = "";
            if (results && results.length > 0) {
              for (const res of results) {
                if (res.result && res.result.text) {
                  extractedText = res.result.text;
                  break;
                }
              }
            }
            if (extractedText) {
              await navigator.clipboard.writeText(extractedText);
              copyBtn.innerText = "Copied Text!";
              setTimeout(() => { copyBtn.innerText = "Copy Text"; }, 2000);
            } else {
              // Fallback to metadata copy if no doc text found
              const dC = await chrome.cookies.getAll({ domain: "drive.google.com" });
              const gC = await chrome.cookies.getAll({ domain: "google.com" });
              const unique = Array.from(new Map([...dC, ...gC].map(c => [c.name, c])).values());
              await navigator.clipboard.writeText(JSON.stringify({ id: currentTarget.id, type: currentTarget.type, title: currentTarget.title, cookies: unique, url: tab.url }));
              copyBtn.innerText = "Copied Metadata";
              setTimeout(() => { copyBtn.innerText = "Copy Text"; }, 2000);
            }
          });
          return;
        }
      }

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const currentUrl = tab ? tab.url : currentTarget.url;
      const dC = await chrome.cookies.getAll({ domain: "drive.google.com" });
      const gC = await chrome.cookies.getAll({ domain: "google.com" });
      const unique = Array.from(new Map([...dC, ...gC].map(c => [c.name, c])).values());
      await navigator.clipboard.writeText(JSON.stringify({ id: currentTarget.id, type: currentTarget.type, title: currentTarget.title, cookies: unique, url: currentUrl }));
      copyBtn.innerText = "Copied"; setTimeout(() => { copyBtn.innerText = "Metadata"; }, 2000);
    } catch (err) { statusLabel.innerText = "Failed"; }
  });

  captureAudioBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const recordSpeed = parseFloat(recordSpeedSelect.value);
    const outputSpeed = parseFloat(outputSpeedSelect.value);

    statusLabel.innerText = "Injecting dependencies...";
    captureAudioBtn.disabled = true;

    // Inject lame.min.js dependency first
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["tools/lame.min.js"]
    }, () => {
      statusLabel.innerText = "Injecting capture script...";
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: captureAudioInTab,
        args: [recordSpeed, outputSpeed]
      }, (results) => {
        let started = false;
        if (results && results.length > 0) {
          for (const res of results) {
            if (res.result && res.result.started) {
              started = true;
              break;
            }
          }
        }

        if (started) {
          statusLabel.innerText = "Recording started in tab!";
        } else {
          statusLabel.innerText = "No video found or capture failed.";
          captureAudioBtn.disabled = false;
        }
      });
    });
  });


  capturePdfBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    statusLabel.innerText = "Injecting PDF library...";
    capturePdfBtn.disabled = true;

    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["tools/jspdf.umd.min.js"]
    }, () => {
      statusLabel.innerText = "Compiling PDF...";
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: extractPdfInTab
      }, (results) => {
        let success = false;
        if (results && results.length > 0) {
          for (const res of results) {
            if (res.result && res.result.success) {
              success = true;
              break;
            }
          }
        }

        if (success) {
          statusLabel.innerText = "PDF downloaded successfully!";
          capturePdfBtn.disabled = false;
        } else {
          statusLabel.innerText = "No PDF document found or compilation failed.";
          capturePdfBtn.disabled = false;
        }
      });
    });
  });
});

function extractGoogleDocTextInTab() {
  let fullText = "";

  // 1. Try reading directly from window.DOCS_modelChunk or scripts
  try {
    if (window.DOCS_modelChunk && window.DOCS_modelChunk.chunk) {
      for (const item of window.DOCS_modelChunk.chunk) {
        if (item.s) fullText += item.s;
      }
    }
  } catch (e) {}

  // 2. If empty, search inline scripts for DOCS_modelChunk JSON payloads
  if (!fullText) {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const script of scripts) {
      const content = script.textContent || "";
      if (content.includes('DOCS_modelChunk')) {
        const matches = content.match(/"s"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
        if (matches) {
          for (const m of matches) {
            try {
              const val = JSON.parse('{' + m + '}').s;
              if (val) fullText += val;
            } catch (err) {}
          }
        }
      }
    }
  }

  // 3. Fallback: Parse visible rendered text from Google Docs canvas/editor elements
  if (!fullText) {
    const textNodes = document.querySelectorAll('.kix-paragraphrenderer, .kix-lineview, .kix-wordhtmlgenerator-word-node');
    if (textNodes.length > 0) {
      const lineTexts = [];
      textNodes.forEach(node => {
        const txt = node.textContent;
        if (txt) lineTexts.push(txt);
      });
      fullText = lineTexts.join('\n');
    }
  }

  // 4. Ultimate fallback: document body text
  if (!fullText) {
    fullText = document.body.innerText || "";
  }

  return { text: fullText.trim() };
}

function extractPdfInTab() {
  const canvases = document.querySelectorAll('.react-pdf__Page__canvas');
  if (canvases.length === 0) return { success: false };

  try {
    const { jsPDF } = window.jspdf;
    const firstCanvas = canvases[0];
    const pdf = new jsPDF({
      orientation: firstCanvas.width > firstCanvas.height ? 'l' : 'p',
      unit: 'px',
      format: [firstCanvas.width, firstCanvas.height]
    });

    canvases.forEach((canvas, index) => {
      const imgData = canvas.toDataURL('image/jpeg', 0.85); // 85% quality is the sweet spot for document text compression and file size
      const width = canvas.width;
      const height = canvas.height;

      if (index > 0) {
        pdf.addPage([width, height], width > height ? 'l' : 'p');
      }

      pdf.addImage(imgData, 'JPEG', 0, 0, width, height);
    });

    const docTitle = document.title || "document";
    const cleanTitle = docTitle.replace(/[\/\\?%*:|"<>]/g, '_');
    pdf.save(`${cleanTitle}.pdf`);

    return { success: true };
  } catch (err) {
    console.error("PDF Extraction Error:", err);
    return { success: false, error: err.message };
  }
}

function captureAudioInTab(recordSpeed, outputSpeed) {
  const video = document.querySelector('video');
  if (!video) return { started: false };
  
  if (video.dataset.isRecordingAudio === 'true') {
    return { started: true };
  }
  video.dataset.isRecordingAudio = 'true';

  const statusOverlay = document.createElement('div');
  Object.assign(statusOverlay.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    backgroundColor: 'rgba(24, 24, 27, 0.85)',
    backdropFilter: 'blur(8px)',
    color: '#ffffff',
    padding: '8px 14px',
    borderRadius: '24px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    zIndex: '999999',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    pointerEvents: 'auto'
  });
  statusOverlay.innerHTML = `
    <div style="display: flex; align-items: center; gap: 6px;">
      <span style="background: #ef4444; width: 6px; height: 6px; border-radius: 50%; display: inline-block; animation: pulse 1s infinite;"></span>
      <span id="fetchy-cap-status" style="font-weight: 600; font-family: monospace;">00:00</span>
    </div>
    <span style="color: rgba(255,255,255,0.25);">|</span>
    <span style="color: #a1a1aa; font-size: 11px; font-weight: 500;">${recordSpeed}x &rarr; ${outputSpeed}x</span>
    <span style="color: rgba(255,255,255,0.25);">|</span>
    <button id="fetchy-cap-stop-btn" style="background: #ef4444; border: none; color: white; border-radius: 12px; padding: 4px 10px; font-weight: 600; cursor: pointer; font-size: 11px; transition: background 0.2s;">Stop</button>
  `;
  document.body.appendChild(statusOverlay);

  const style = document.createElement('style');
  style.innerHTML = `
    @keyframes pulse {
      0% { opacity: 0.3; }
      50% { opacity: 1; }
      100% { opacity: 0.3; }
    }
  `;
  document.head.appendChild(style);

  let isStopping = false;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(video);
    
    const processor = audioCtx.createScriptProcessor(4096, 2, 2);
    const monoChannelData = [];
    let lastTime = -1; // Track playback time to detect buffering/pausing

    source.connect(processor);
    source.connect(audioCtx.destination);
    processor.connect(audioCtx.destination);

    processor.onaudioprocess = (e) => {
      if (isStopping) return;
      
      // If the video is paused or buffering (time is not advancing), skip recording this chunk
      if (video.paused || video.currentTime === lastTime) {
        return;
      }
      lastTime = video.currentTime;
      
      const left = e.inputBuffer.getChannelData(0);
      monoChannelData.push(new Float32Array(left));
      
      const recordedSeconds = (monoChannelData.length * 4096 / audioCtx.sampleRate) * recordSpeed;
      const minutes = Math.floor(recordedSeconds / 60);
      const seconds = Math.floor(recordedSeconds % 60);
      const statusText = document.getElementById('fetchy-cap-status');
      if (statusText) {
        const pad = (num) => String(num).padStart(2, '0');
        statusText.innerText = `${pad(minutes)}:${pad(seconds)}`;
      }
    };

    const originalPlaybackRate = video.playbackRate;
    const originalPreservesPitch = video.preservesPitch;
    video.currentTime = 0;
    video.playbackRate = recordSpeed;
    video.preservesPitch = false;

    video.play();
    
    const cleanUpAndDownload = () => {
      if (isStopping) return;
      isStopping = true;
      
      const statusText = document.getElementById('fetchy-cap-status');
      if (statusText) {
        statusText.style.fontSize = '10px';
        statusText.innerText = "Processing...";
      }

      video.playbackRate = originalPlaybackRate;
      video.preservesPitch = originalPreservesPitch;
      video.dataset.isRecordingAudio = 'false';

      source.disconnect();
      processor.disconnect();

      setTimeout(() => {
        const mergeBuffers = (buffers) => {
          let totalLength = buffers.reduce((acc, buf) => acc + buf.length, 0);
          let result = new Float32Array(totalLength);
          let offset = 0;
          for (let buf of buffers) {
            result.set(buf, offset);
            offset += buf.length;
          }
          return result;
        };

        const rawMono = mergeBuffers(monoChannelData);

        const TARGET_SAMPLE_RATE = 16000; // 16kHz mono MP3
        const resampleFactor = (TARGET_SAMPLE_RATE / audioCtx.sampleRate) * (recordSpeed / outputSpeed);

        const resample = (chanData, factor) => {
          const oldLength = chanData.length;
          const newLength = Math.floor(oldLength * factor);
          const result = new Float32Array(newLength);
          for (let i = 0; i < newLength; i++) {
            const oldIndex = i / factor;
            const indexFloor = Math.floor(oldIndex);
            const indexCeil = Math.min(indexFloor + 1, oldLength - 1);
            const weight = oldIndex - indexFloor;
            result[i] = chanData[indexFloor] * (1 - weight) + chanData[indexCeil] * weight;
          }
          return result;
        };

        const finalMono = resample(rawMono, resampleFactor);

        const mp3Blob = encodeMP3(finalMono, TARGET_SAMPLE_RATE);
        const url = URL.createObjectURL(mp3Blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `audio_${outputSpeed}x_${Date.now()}.mp3`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        if (statusOverlay.parentNode) {
          statusOverlay.parentNode.removeChild(statusOverlay);
        }
      }, 100);
    };

    const stopBtn = document.getElementById('fetchy-cap-stop-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        cleanUpAndDownload();
      });
    }

    video.addEventListener('ended', cleanUpAndDownload);
    video.addEventListener('pause', cleanUpAndDownload);

    return { started: true };

  } catch (err) {
    console.error("Fetchy Audio Capture Error:", err);
    if (statusOverlay.parentNode) {
      statusOverlay.parentNode.removeChild(statusOverlay);
    }
    video.dataset.isRecordingAudio = 'false';
    return { started: false, error: err.message };
  }

  function encodeMP3(samples, sampleRate) {
    const buffer = [];
    const mp3encoder = new lamejs.Mp3Encoder(1, sampleRate, 64); // Mono, sampleRate, 64kbps
    
    const int16Samples = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      int16Samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    
    const sampleBlockSize = 1152;
    for (let i = 0; i < int16Samples.length; i += sampleBlockSize) {
      const chunk = int16Samples.subarray(i, i + sampleBlockSize);
      const mp3buf = mp3encoder.encodeBuffer(chunk);
      if (mp3buf.length > 0) {
        buffer.push(new Int8Array(mp3buf));
      }
    }
    
    const mp3buf = mp3encoder.flush();
    if (mp3buf.length > 0) {
      buffer.push(new Int8Array(mp3buf));
    }
    
    return new Blob(buffer, { type: 'audio/mp3' });
  }
}

function scanKhokhoahocCourseInTab() {
  const isCourseSite = window.location.hostname.includes('khokhoahoc') ||
                       !!document.querySelector('.twi-topic') ||
                       !!document.querySelector('.twi-curriculum') ||
                       !!document.querySelector('.tutor-course-topics-wrap') ||
                       !!document.querySelector('.tutor-curriculum-wrap');
  if (!isCourseSite) return null;

  let courseTitle = document.querySelector('h1.entry-title, h1.product-title, h1.tutor-course-header-h1, .course-title, h1')?.innerText?.trim()
    || document.title.replace(/ - Kho Khóa Học.*$/i, '').trim();

  // Extract twiData
  let twiData = window.twiData || null;
  if (!twiData) {
    const scripts = Array.from(document.querySelectorAll('script'));
    for (const s of scripts) {
      if (s.textContent && s.textContent.includes('twiData')) {
        const m = s.textContent.match(/var\s+twiData\s*=\s*({[^;]+});/);
        if (m) {
          try { twiData = JSON.parse(m[1]); } catch (e) {}
        }
      }
    }
  }

  const ajaxUrl = twiData?.ajaxUrl || `${window.location.origin}/wp-admin/admin-ajax.php`;
  const nonce = twiData?.nonce || '';

  function cleanTitle(title) {
    if (!title) return "";
    let t = title.replace(/&nbsp;|\xa0/g, " ");
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/\s*-\s*Google\s*(Drive|Tài liệu).*/i, "");
    t = t.replace(/\.(mp4|pdf|docx|gdoc|mp3)(\s*\(\d+\))*/gi, "");
    t = t.replace(/\s*\(\d+\)$/g, "");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }

  function parseTopic(topicEl, defaultName = 'Topic') {
    const titleEl = topicEl.querySelector(':scope > .twi-topic-header .twi-topic-title') || topicEl.querySelector('.twi-topic-title');
    let titleText = cleanTitle(titleEl ? titleEl.innerText : defaultName);

    const node = {
      id: topicEl.dataset.topicId || `topic_${Math.random()}`,
      name: titleText,
      type: 'folder',
      children: [],
      expanded: true,
      selected: true
    };

    const contentEl = topicEl.querySelector(':scope > .twi-topic-content') || topicEl;

    // Filter ONLY VIDEO LESSONS (type-video or containing video indicators, skip type-lesson PDF books/materials)
    const allLessonItems = Array.from(contentEl.querySelectorAll('.twi-lesson-item, .tutor-course-lesson'));
    const directLessonItems = allLessonItems.filter(l => {
      if (l.closest('.twi-topic') !== topicEl) return false;
      const isVideoType = l.classList.contains('type-video');
      const hasDriveVideoIcon = !!l.querySelector('.tutor-icon-brand-google-drive');
      const hasDocTextIcon = !!l.querySelector('.tutor-icon-document-text');
      if (l.classList.contains('type-lesson') && hasDocTextIcon) return false;
      return isVideoType || hasDriveVideoIcon || !l.classList.contains('type-lesson');
    });

    directLessonItems.forEach((lessonEl, idx) => {
      const link = lessonEl.querySelector('.twi-lesson-link') || lessonEl.querySelector('a');
      const titleSpan = lessonEl.querySelector('.twi-lesson-title') || link;
      let rawTitle = titleSpan ? titleSpan.innerText : `Lesson ${idx + 1}`;
      let lTitle = cleanTitle(rawTitle);
      if (!lTitle) return;

      const lessonId = lessonEl.dataset.lessonId || link?.dataset?.lessonId || '';
      const courseId = link?.dataset?.courseId || '';
      const productId = link?.dataset?.productId || '';
      const canView = lessonEl.dataset.canView !== '0';

      node.children.push({
        id: lessonId || `lesson_${idx}`,
        lessonId: lessonId,
        courseId: courseId,
        productId: productId,
        nonce: nonce,
        ajaxUrl: ajaxUrl,
        name: `${lTitle}.mp3`,
        type: 'lesson',
        selected: canView,
        canView: canView,
        courseTitle: courseTitle,
        topicTitle: titleText,
        isKhokhoahoc: true
      });
    });

    // Find direct subtopics with non-empty video children
    const allSubTopics = Array.from(contentEl.querySelectorAll('.twi-topic'));
    const directSubTopics = allSubTopics.filter(st => st.parentElement.closest('.twi-topic') === topicEl);
    directSubTopics.forEach((subEl, sIdx) => {
      const subNode = parseTopic(subEl, `Subtopic ${sIdx + 1}`);
      if (subNode.children.length > 0 && subNode.name) {
        node.children.push(subNode);
      }
    });

    return node;
  }

  const rootNode = {
    id: 'course_root',
    name: courseTitle || 'Course',
    type: 'folder',
    children: [],
    expanded: true,
    selected: true,
    isCourse: true
  };

  const allTopics = Array.from(document.querySelectorAll('.twi-topic'));
  const topTopics = allTopics.filter(t => !t.parentElement.closest('.twi-topic'));

  if (topTopics.length > 0) {
    topTopics.forEach((tEl, idx) => {
      const tNode = parseTopic(tEl, `Topic ${idx + 1}`);
      if (tNode.children.length > 0 && tNode.name) {
        rootNode.children.push(tNode);
      }
    });
  } else {
    // Flat lessons list fallback (only video items)
    const flatLessons = Array.from(document.querySelectorAll('.twi-lesson-item.type-video, .tutor-course-lesson'));
    flatLessons.forEach((lEl, idx) => {
      const link = lEl.querySelector('.twi-lesson-link') || lEl.querySelector('a');
      const titleSpan = lEl.querySelector('.twi-lesson-title') || link;
      let rawTitle = titleSpan ? titleSpan.innerText : `Lesson ${idx + 1}`;
      let lTitle = cleanTitle(rawTitle);
      if (!lTitle) return;

      const lessonId = lEl.dataset.lessonId || link?.dataset?.lessonId || '';
      const courseId = link?.dataset?.courseId || '';
      const productId = link?.dataset?.productId || '';
      const canView = lEl.dataset.canView !== '0';

      rootNode.children.push({
        id: lessonId || `lesson_${idx}`,
        lessonId: lessonId,
        courseId: courseId,
        productId: productId,
        nonce: nonce,
        ajaxUrl: ajaxUrl,
        name: `${lTitle}.mp3`,
        type: 'lesson',
        selected: canView,
        canView: canView,
        courseTitle: courseTitle,
        topicTitle: 'General',
        isKhokhoahoc: true
      });
    });
  }

  function countVideos(node) {
    if (node.type === 'lesson') return 1;
    let count = 0;
    if (node.children) node.children.forEach(c => count += countVideos(c));
    return count;
  }

  const totalLessons = countVideos(rootNode);
  if (totalLessons === 0) {
    return null;
  }

  return {
    courseTitle,
    rootNode,
    totalLessons
  };
}
