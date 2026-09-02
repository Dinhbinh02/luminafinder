let isProcessing = false;
let currentProgress = { total: 0, current: 0, lastFileName: "", statusText: "" };
let pdfLock = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FETCH') {
    fetch(request.url, { ...request.options, credentials: 'include' })
      .then(async response => {
        const text = await response.text();
        sendResponse({ success: true, text: text, status: response.status });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }

  if (request.type === 'START_DOWNLOAD_QUEUE') {
    const files = request.files;
    currentProgress = { total: files.length, current: 0, lastFileName: "", statusText: "Starting..." };
    isProcessing = true;
    
    (async () => {
      const concurrencyLimit = 5;
      const queue = [...files];
      const workers = [];

      async function worker() {
        while (queue.length > 0 && isProcessing) {
          const item = queue.shift();
          try {
            await downloadFile(item);
          } catch (err) {
            console.error("Queue item failed:", err);
          }
        }
      }

      for (let i = 0; i < Math.min(concurrencyLimit, files.length); i++) {
        workers.push(worker());
      }
      
      await Promise.all(workers);
      isProcessing = false;
    })();
    
    sendResponse({ success: true });
  }

  if (request.type === 'GET_DOWNLOAD_STATUS') {
    sendResponse({ isProcessing, progress: currentProgress });
  }
});

async function ensureOffscreenDocument() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    if (await chrome.offscreen.hasDocument()) return;
  }
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existingContexts && existingContexts.length > 0) return;
  } catch (e) {}

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
      justification: 'Decode audio stream and convert to MP3'
    });
  } catch (e) {
    if (!e.message || !e.message.includes('Only a single offscreen document')) {
      console.warn("Offscreen creation error:", e);
    }
  }
}

function sanitizePath(pathStr) {
  return (pathStr || 'Audio')
    .split('/')
    .map(seg => seg.replace(/[\\*?:"<>|]/g, '').trim())
    .filter(Boolean)
    .join('/');
}

async function downloadKhokhoahocLesson(item) {
  console.log(`[Fetchy Background] Processing lesson: "${item.name}" (ID: ${item.lessonId})...`);
  currentProgress.lastFileName = item.name;
  currentProgress.statusText = "Getting video stream...";

  let videoSrc = "";
  try {
    const formData = new URLSearchParams();
    formData.append('action', 'twi_load_lesson');
    formData.append('lesson_id', item.lessonId);
    if (item.courseId) formData.append('course_id', item.courseId);
    if (item.productId) formData.append('product_id', item.productId);
    if (item.nonce) formData.append('nonce', item.nonce);

    const ajaxUrl = item.ajaxUrl || 'https://khokhoahoc.org/wp-admin/admin-ajax.php';
    const ajaxRes = await fetch(ajaxUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
      credentials: 'include'
    });

    const json = await ajaxRes.json();
    if (json && json.success && json.data) {
      const dataStr = typeof json.data === 'string' ? json.data : JSON.stringify(json.data);
      const videoHtml = (json.data.video || dataStr);

      // 1. SharePoint direct download link (Fastest, full 56MB MP4, pristine quality)
      const spMatch = videoHtml.match(/(https:\/\/[a-z0-9\.\-]+\.sharepoint\.com\/[^\s"'<>]+)/i) ||
                      dataStr.match(/(https:\/\/[a-z0-9\.\-]+\.sharepoint\.com\/[^\s"'<>]+)/i);

      // 2. Google Drive video link
      const gdMatch = videoHtml.match(/(https:\/\/(?:drive|docs)\.google\.com\/[^\s"'<>]+)/i);

      // 3. Direct HTML video/source tag
      const srcMatch = videoHtml.match(/src="([^"]+)"/i);
      const iframeMatch = videoHtml.match(/<iframe[^>]+src="([^"]+)"/i);
      const streamMatch = videoHtml.match(/data-stream-url="([^"]+)"/i);

      if (spMatch && spMatch[1]) {
        videoSrc = spMatch[1].replace(/&amp;/g, '&');
      } else if (gdMatch && gdMatch[1]) {
        videoSrc = gdMatch[1].replace(/&amp;/g, '&');
      } else if (srcMatch && srcMatch[1] && !srcMatch[1].startsWith('blob:')) {
        videoSrc = srcMatch[1].replace(/&amp;/g, '&');
      } else if (iframeMatch && iframeMatch[1]) {
        videoSrc = iframeMatch[1].replace(/&amp;/g, '&');
      } else if (streamMatch && streamMatch[1]) {
        videoSrc = streamMatch[1].replace(/&amp;/g, '&');
      }
    }
  } catch (err) {
    console.warn("[Fetchy Background] AJAX twi_load_lesson failed:", err);
  }

  if (!videoSrc) {
    throw new Error(`Could not find video stream for lesson: ${item.name}`);
  }

  // If videoSrc is a proxy endpoint (twi_sp_stream), fetch the JSON to get the real Microsoft CDN URL!
  if (videoSrc.includes('twi_sp_stream')) {
    try {
      console.log(`[Fetchy Background] Resolving Microsoft CDN URL from twi_sp_stream JSON endpoint...`);
      const proxyRes = await fetch(videoSrc, { credentials: 'include' });
      const proxyText = await proxyRes.text();
      try {
        const proxyJson = JSON.parse(proxyText);
        const directUrl = proxyJson.url || proxyJson.src || proxyJson.stream_url || (proxyJson.data && (proxyJson.data.url || proxyJson.data.src));
        if (directUrl) {
          videoSrc = directUrl.replace(/&amp;/g, '&');
          console.log(`[Fetchy Background] Resolved Microsoft CDN URL: ${videoSrc.substring(0, 100)}...`);
        }
      } catch (jsonErr) {
        const urlMatch = proxyText.match(/https:\/\/[^\s"'<>]+/);
        if (urlMatch) {
          videoSrc = urlMatch[0].replace(/&amp;/g, '&');
        }
      }
    } catch (proxyErr) {
      console.warn("[Fetchy Background] Failed to resolve twi_sp_stream:", proxyErr);
    }
  }

  console.log(`[Fetchy Background] Resolved stream URL for "${item.name}": ${videoSrc.substring(0, 100)}...`);

  if (videoSrc.includes('drive.google.com')) {
    const gdId = extractFileId(videoSrc);
    if (gdId) {
      try {
        const infoUrl = `https://drive.google.com/u/0/get_video_info?docid=${gdId}&drive_originator_app=303`;
        const infoRes = await fetch(infoUrl, { credentials: 'include' });
        const infoText = await infoRes.text();
        const params = parseParams(infoText);
        const streams = parseStreams(params);
        if (streams.length > 0) {
          videoSrc = streams[0].url;
        } else {
          videoSrc = `https://drive.google.com/uc?id=${gdId}&export=download`;
        }
      } catch (e) {
        videoSrc = `https://drive.google.com/uc?id=${gdId}&export=download`;
      }
    }
  }

  currentProgress.statusText = "Extracting Audio (MP3)...";
  await ensureOffscreenDocument();

  const safeFilename = sanitizePath(item.path || item.name);
  console.log(`[Fetchy Background] Sending PROCESS_AUDIO_STREAM to offscreen document for: ${safeFilename}`);

  await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: 'PROCESS_AUDIO_STREAM',
      url: videoSrc,
      filename: safeFilename
    }, async response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (response && response.success && response.dataUrl) {
        const downloadFilename = response.filename || safeFilename;
        console.log(`[Fetchy Background] Audio processing complete. Downloading: ${downloadFilename}`);
        try {
          const downloadId = await chrome.downloads.download({
            url: response.dataUrl,
            filename: downloadFilename,
            saveAs: false
          });
          resolve({ success: true, downloadId });
        } catch (dlErr) {
          console.warn("[Fetchy Background] chrome.downloads error:", dlErr);
          reject(dlErr);
        }
      } else {
        reject(new Error(response ? response.error : 'Audio extraction failed'));
      }
    });
  });

  currentProgress.current++;
}

async function downloadFile(item) {
  if (item.isKhokhoahoc || item.type === 'lesson') {
    return await downloadKhokhoahocLesson(item);
  }
  currentProgress.lastFileName = item.name;
  try {
    let finalUrl = "";
    let forceExtension = "";

    const isDoc = (item.url && item.url.includes('/document/')) || item.name.toLowerCase().endsWith('.gdoc') || item.name.toLowerCase().endsWith('.docx');
    const isSheet = (item.url && item.url.includes('/spreadsheets/')) || item.name.toLowerCase().endsWith('.gsheet') || item.name.toLowerCase().endsWith('.xlsx');
    const isSlide = (item.url && item.url.includes('/presentation/')) || item.name.toLowerCase().endsWith('.gslides') || item.name.toLowerCase().endsWith('.pptx');

    if (isDoc || isSheet || isSlide) {
      const type = isDoc ? 'document' : (isSheet ? 'spreadsheets' : 'presentation');
      const exportUrl = `https://docs.google.com/${type}/d/${item.id}/export?format=pdf`;
      
      try {
        const res = await fetch(exportUrl, { method: 'HEAD', credentials: 'include' });
        if (res.ok) {
          finalUrl = exportUrl;
          if (!item.name.toLowerCase().endsWith('.pdf')) forceExtension = ".pdf";
        } else {
          const bypassUrl = isDoc 
            ? `https://docs.google.com/document/d/${item.id}/mobilebasic`
            : (isSheet ? `https://docs.google.com/spreadsheets/d/${item.id}/htmlview` : `https://docs.google.com/presentation/d/${item.id}/htmlview`);
          
          const bypassRes = await fetch(bypassUrl, { credentials: 'include' });
          let bypassHtml = await bypassRes.text();
          bypassHtml = await inlineImages(bypassHtml, bypassUrl);

          await convertHtmlToPdf(bypassHtml, item.path || item.name);
          currentProgress.current++;
          return;
        }
      } catch (e) {
        finalUrl = `https://drive.google.com/uc?id=${item.id}&export=download`;
      }
    } else {
      const infoUrl = `https://drive.google.com/u/0/get_video_info?docid=${item.id}&drive_originator_app=303`;
      const infoRes = await fetch(infoUrl, { credentials: 'include' });
      const infoText = await infoRes.text();
      const params = parseParams(infoText);
      const streams = parseStreams(params);

      if (streams.length > 0) {
        finalUrl = streams[0].url;
      } else {
        const ucUrl = `https://drive.google.com/uc?id=${item.id}&export=download`;
        const ucRes = await fetch(ucUrl, { credentials: 'include' });
        const ucHtml = await ucRes.text();
        finalUrl = extractConfirmLink(ucHtml) || ucUrl;
      }
    }

    let cleanName = item.path.trim();
    const exts = ['.docx', '.xlsx', '.pptx', '.gdoc', '.gsheet', '.gslides', '.pdf', '.html', '.htm'];
    let found = true;
    while (found) {
      found = false;
      for (const ext of exts) {
        if (cleanName.toLowerCase().endsWith(ext)) {
          cleanName = cleanName.substring(0, cleanName.length - ext.length);
          found = true;
          break;
        }
      }
    }

    let saveName = cleanName;
    if (!forceExtension && cleanName !== item.path.trim()) {
      saveName = item.path.trim(); 
    } else if (forceExtension && !saveName.toLowerCase().endsWith(forceExtension)) {
      saveName += forceExtension;
    }

    await new Promise((resolve) => {
      chrome.downloads.download({
        url: finalUrl,
        filename: saveName.replace(/[\\*?:"<>|]/g, "").trim(),
        saveAs: false
      }, resolve);
    });
    
    currentProgress.current++;
  } catch (e) {
    console.error("Download error", e);
    currentProgress.current++; 
  }
}

async function inlineImages(html, baseUrl) {
  const imgRegex = /<img[^>]+src="([^">]+)"/g;
  let match;
  let newHtml = html;
  const matches = [];
  while ((match = imgRegex.exec(html)) !== null) {
    matches.push({ full: match[0], src: match[1] });
  }
  for (const m of matches) {
    try {
      let imgSrc = m.src;
      if (imgSrc.startsWith('/')) imgSrc = new URL(imgSrc, baseUrl).href;
      const res = await fetch(imgSrc, { credentials: 'include' });
      const blob = await res.blob();
      const reader = new FileReader();
      const base64Data = await new Promise((resolve) => {
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      newHtml = newHtml.replace(m.src, base64Data);
    } catch (e) {
      console.warn("Failed to inline image:", m.src, e);
    }
  }
  return newHtml;
}

function parseParams(text) {
  const params = {};
  text.split('&').forEach(pair => { const [k, v] = pair.split('='); if (k && v) params[k] = v; });
  return params;
}

function parseStreams(params) {
  const qMap = { '37': 1080, '22': 720, '59': 480, '18': 360 };
  const streams = [];
  if (params.fmt_stream_map) {
    decodeURIComponent(params.fmt_stream_map).split(',').forEach(s => {
      const p = s.split('|');
      if (p.length >= 2) streams.push({ priority: qMap[p[0]] || 0, url: p[1], itag: p[0] });
    });
  }
  return streams.sort((a, b) => b.priority - a.priority);
}

function extractConfirmLink(html) {
  const hrefMatch = html.match(/href="(\/uc\?export=download[^"]+)/);
  if (hrefMatch) return "https://docs.google.com" + hrefMatch[1].replace(/&amp;/g, "&");
  const dlMatch = html.match(/"downloadUrl":"([^"]+)"/);
  if (dlMatch) return dlMatch[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
  return null;
}

async function convertHtmlToPdf(html, filePath) {
  while (pdfLock) {
    await new Promise(r => setTimeout(r, 500));
  }
  pdfLock = true;

  try {
    currentProgress.statusText = "Converting to PDF|Don't close the debug bar";
    const prettyCss = `
      <style>
        * { box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Arial, sans-serif;
          font-size: 12pt;
          line-height: 1.7;
          color: #1a1a1a;
          background: white;
          margin: 0; padding: 0;
        }
        ol, ul { margin: 0.4em 0; padding-left: 2em; }
        ol { list-style-type: decimal; }
        ul { list-style-type: disc; }
        li { margin: 0.3em 0; padding-left: 0.3em; display: list-item !important; }
        p, div { margin: 0.3em 0; }
        p:empty { display: none !important; }
        h1 { font-size: 18pt; font-weight: bold; margin: 0.8em 0 0.3em; }
        table { width: 100%; border-collapse: collapse; margin: 0.5em 0; }
        td, th { border: 1px solid #ccc; padding: 6px 10px; vertical-align: top; }
        img { max-width: 100%; height: auto; display: block; margin: 0.5em auto; }
      </style>
    `;

    if (!html.includes('charset=')) {
      if (html.includes('<head>')) html = html.replace('<head>', '<head><meta charset="utf-8">');
      else html = '<meta charset="utf-8">' + html;
    }

    if (html.includes('</head>')) html = html.replace('</head>', prettyCss + '</head>');
    else html = prettyCss + html;

    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    await new Promise(r => setTimeout(r, 500));
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');

    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable');
      const frameTree = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.getFrameTree');
      const frameId = frameTree.frameTree.frame.id;
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.setDocumentContent', { frameId: frameId, html: html });
      await new Promise(r => setTimeout(r, 3000));

      const result = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.printToPDF', {
        printBackground: true, paperWidth: 8.27, paperHeight: 11.69,
        marginTop: 0.6, marginBottom: 0.6, marginLeft: 0.7, marginRight: 0.7, scale: 0.9
      });

      const pdfUrl = `data:application/pdf;base64,${result.data}`;
      let cleanName = filePath.trim();
      const exts = ['.docx', '.xlsx', '.pptx', '.gdoc', '.gsheet', '.gslides', '.pdf', '.html', '.htm'];
      let found = true;
      while (found) {
        found = false;
        for (const ext of exts) {
          if (cleanName.toLowerCase().endsWith(ext)) {
            cleanName = cleanName.substring(0, cleanName.length - ext.length);
            found = true;
            break;
          }
        }
      }
      const safeName = (cleanName + '.pdf').replace(/[\\*?:"<>|]/g, "").trim();
      chrome.downloads.download({ url: pdfUrl, filename: safeName, saveAs: false });
    } finally {
      await chrome.debugger.detach({ tabId: tab.id });
      chrome.tabs.remove(tab.id);
    }
  } finally {
    pdfLock = false;
    currentProgress.statusText = "";
  }
}
