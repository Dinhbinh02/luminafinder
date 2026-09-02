chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CONVERT_TO_PDF') {
    convertToPdf(request.html, request.filename).then(sendResponse);
    return true;
  }
  if (request.type === 'PROCESS_AUDIO_STREAM') {
    processAudioStream(request.url, request.filename)
      .then(res => sendResponse({ success: true, ...res }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function processAudioStream(url, filename) {
  let response = await fetch(url, {
    credentials: 'include',
    headers: { 'Range': 'bytes=0-' }
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status}: Failed to fetch audio/video stream`);
  }
  let arrayBuffer = await response.arrayBuffer();

  // If the endpoint returned a JSON descriptor (like twi_sp_stream) instead of raw video bytes
  if (arrayBuffer.byteLength < 10000) {
    try {
      const text = new TextDecoder().decode(arrayBuffer);
      const json = JSON.parse(text);
      const directUrl = json.url || json.src || json.stream_url || (json.data && (json.data.url || json.data.src));
      if (directUrl) {
        console.log(`[Fetchy Audio] Following JSON stream redirect to Microsoft CDN: ${directUrl.substring(0, 80)}...`);
        response = await fetch(directUrl.replace(/&amp;/g, '&'), {
          credentials: 'include',
          headers: { 'Range': 'bytes=0-' }
        });
        if (!response.ok && response.status !== 206) {
          throw new Error(`HTTP ${response.status} fetching direct stream: ${directUrl}`);
        }
        arrayBuffer = await response.arrayBuffer();
      }
    } catch (e) {
      // not JSON
    }
  }

  console.log(`[Fetchy Audio] 2/5 Stream downloaded (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)} MB)`);
  
  if (arrayBuffer.byteLength < 5000) {
    throw new Error(`Stream data is empty or invalid (${arrayBuffer.byteLength} bytes). The video URL might have expired or requires authentication.`);
  }

  const uint8 = new Uint8Array(arrayBuffer);

  // Attempt to demux AAC track from MP4 container directly
  let audioToDecode = arrayBuffer;
  let aacExtracted = null;
  try {
    aacExtracted = extractAacFromMp4(uint8);
    if (aacExtracted && aacExtracted.aacBuffer) {
      console.log(`[Fetchy Audio] 3/5 AAC Demux Success! AAC size: ${(aacExtracted.aacBuffer.byteLength / 1024 / 1024).toFixed(2)} MB, SampleRate: ${aacExtracted.sampleRate} Hz`);
      audioToDecode = aacExtracted.aacBuffer.buffer;
    }
  } catch (e) {
    console.warn("[Fetchy Audio] Direct MP4 AAC demux skipped/failed:", e);
  }

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AudioContext();
  let audioBuffer = null;
  try {
    console.log(`[Fetchy Audio] 4/5 Decoding PCM Audio with Web Audio API (buffer length: ${audioToDecode.byteLength} bytes)...`);
    audioBuffer = await audioCtx.decodeAudioData(audioToDecode);
    console.log(`[Fetchy Audio] PCM Decoded! Duration: ${audioBuffer.duration.toFixed(1)}s, Native SampleRate: ${audioBuffer.sampleRate} Hz`);
  } catch (decodeErr) {
    console.warn("[Fetchy Audio] AudioContext decodeAudioData failed, falling back to direct audio stream download:", decodeErr);
    let fallbackBlob = null;
    let fallbackExt = '.aac';

    if (aacExtracted && aacExtracted.aacBuffer && aacExtracted.aacBuffer.byteLength > 1000) {
      console.log("[Fetchy Audio] Saving extracted pure AAC audio stream directly...");
      fallbackBlob = new Blob([aacExtracted.aacBuffer], { type: 'audio/aac' });
      fallbackExt = '.aac';
    } else {
      throw new Error(`Failed to decode audio track: ${decodeErr.message}`);
    }

    const reader = new FileReader();
    const dataUrl = await new Promise((resolve, reject) => {
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(fallbackBlob);
    });

    let cleanName = filename.replace(/\.(mp4|m4v|mkv|webm|ts|mov|mp3|aac|m4a)$/i, '').trim() + fallbackExt;
    return { success: true, dataUrl, filename: cleanName };
  } finally {
    try { await audioCtx.close(); } catch (e) {}
  }

  if (!audioBuffer) {
    throw new Error("Could not decode audio track from video stream");
  }

  // Optimize for AI Speech Ingestion (Gemini / Whisper / AI Studio):
  // 16,000 Hz Mono captures 100% voice clarity while reducing file size by 75-80%!
  const TARGET_SAMPLE_RATE = 16000;
  const TARGET_BITRATE = 32; // 32 kbps mono -> ~3.5MB per 15 min

  let pcmData = null;
  try {
    const offlineCtx = new OfflineAudioContext(1, Math.max(1, Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE)), TARGET_SAMPLE_RATE);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    const resampledBuffer = await offlineCtx.startRendering();
    pcmData = resampledBuffer.getChannelData(0);
  } catch (resampleErr) {
    console.warn("OfflineAudioContext resampling fallback:", resampleErr);
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : left;
    const factor = TARGET_SAMPLE_RATE / audioBuffer.sampleRate;
    const targetLen = Math.floor(audioBuffer.length * factor);
    pcmData = new Float32Array(targetLen);
    for (let i = 0; i < targetLen; i++) {
      const srcIdx = i / factor;
      const idxFloor = Math.floor(srcIdx);
      const idxCeil = Math.min(idxFloor + 1, audioBuffer.length - 1);
      const weight = srcIdx - idxFloor;
      const val0 = (left[idxFloor] + right[idxFloor]) * 0.5;
      const val1 = (left[idxCeil] + right[idxCeil]) * 0.5;
      pcmData[i] = val0 * (1 - weight) + val1 * weight;
    }
  }

  const mp3encoder = new lamejs.Mp3Encoder(1, TARGET_SAMPLE_RATE, TARGET_BITRATE);
  const mp3Data = [];

  const sampleBlockSize = 1152;
  const numSamples = pcmData.length;
  const sampleInt16 = new Int16Array(sampleBlockSize);

  for (let i = 0; i < numSamples; i += sampleBlockSize) {
    const chunkLen = Math.min(sampleBlockSize, numSamples - i);
    for (let j = 0; j < chunkLen; j++) {
      const s = Math.max(-1, Math.min(1, pcmData[i + j]));
      sampleInt16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    for (let j = chunkLen; j < sampleBlockSize; j++) {
      sampleInt16[j] = 0;
    }

    const mp3buf = mp3encoder.encodeBuffer(sampleInt16.subarray(0, chunkLen));
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }
  }

  const flushBuf = mp3encoder.flush();
  if (flushBuf.length > 0) {
    mp3Data.push(flushBuf);
  }

  const mp3Blob = new Blob(mp3Data, { type: 'audio/mp3' });
  const reader = new FileReader();
  const dataUrl = await new Promise((resolve, reject) => {
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(mp3Blob);
  });

  let cleanName = filename.replace(/\.(mp4|m4v|mkv|webm|ts|mov)$/i, '').trim();
  if (!cleanName.toLowerCase().endsWith('.mp3')) {
    cleanName += '.mp3';
  }

  return { success: true, dataUrl, filename: cleanName };
}

function extractAacFromMp4(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  function readBoxes(offset, end) {
    const boxes = [];
    let p = offset;
    while (p < end && p + 8 <= buffer.length) {
      let size = view.getUint32(p);
      const type = String.fromCharCode(buffer[p+4], buffer[p+5], buffer[p+6], buffer[p+7]);
      let headerSize = 8;
      if (size === 1) {
        size = Number(view.getBigUint64(p + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < headerSize) break;
      boxes.push({ type, offset: p, size, headerSize, end: p + size });
      p += size;
    }
    return boxes;
  }

  const rootBoxes = readBoxes(0, buffer.length);
  const moov = rootBoxes.find(b => b.type === "moov");
  if (!moov) return null;

  const moovBoxes = readBoxes(moov.offset + moov.headerSize, moov.end);
  const traks = moovBoxes.filter(b => b.type === "trak");

  let soundTrak = null;
  for (const trak of traks) {
    const mdia = readBoxes(trak.offset + trak.headerSize, trak.end).find(b => b.type === "mdia");
    if (!mdia) continue;
    const hdlr = readBoxes(mdia.offset + mdia.headerSize, mdia.end).find(b => b.type === "hdlr");
    if (!hdlr) continue;
    const hdlrText = String.fromCharCode(...buffer.subarray(hdlr.offset, hdlr.end));
    if (hdlrText.includes("soun")) {
      soundTrak = { trak, mdia };
      break;
    }
  }

  if (!soundTrak) return null;

  const minf = readBoxes(soundTrak.mdia.offset + soundTrak.mdia.headerSize, soundTrak.mdia.end).find(b => b.type === "minf");
  if (!minf) return null;
  const stbl = readBoxes(minf.offset + minf.headerSize, minf.end).find(b => b.type === "stbl");
  if (!stbl) return null;
  const stblBoxes = readBoxes(stbl.offset + stbl.headerSize, stbl.end);

  const stsd = stblBoxes.find(b => b.type === "stsd");
  const stsc = stblBoxes.find(b => b.type === "stsc");
  const stsz = stblBoxes.find(b => b.type === "stsz");
  const stco = stblBoxes.find(b => b.type === "stco");
  const co64 = stblBoxes.find(b => b.type === "co64");

  if (!stsd || !stsc || !stsz || (!stco && !co64)) return null;

  const stsdEntries = readBoxes(stsd.offset + 16, stsd.end);
  const audioEntry = stsdEntries.find(b => ["mp4a", "aac ", "samr", "sawb", "enca", ".mp3", "alac", "opus"].includes(b.type)) || stsdEntries[0];
  if (!audioEntry) return null;

  const audioHeader = audioEntry.offset + audioEntry.headerSize;
  const channelCount = view.getUint16(audioHeader + 16) || 1;
  const sampleRate = (view.getUint32(audioHeader + 24) >>> 16) || 44100;

  let chunkOffsets = [];
  if (stco) {
    const p = stco.offset + stco.headerSize + 4;
    const count = view.getUint32(p);
    for (let i = 0; i < count; i++) chunkOffsets.push(view.getUint32(p + 4 + i * 4));
  } else if (co64) {
    const p = co64.offset + co64.headerSize + 4;
    const count = view.getUint32(p);
    for (let i = 0; i < count; i++) chunkOffsets.push(Number(view.getBigUint64(p + 4 + i * 8)));
  }

  const stscEntries = [];
  {
    const p = stsc.offset + stsc.headerSize + 4;
    const count = view.getUint32(p);
    for (let i = 0; i < count; i++) {
      stscEntries.push({
        firstChunk: view.getUint32(p + 4 + i * 12),
        samplesPerChunk: view.getUint32(p + 4 + i * 12 + 4),
        sampleDescIdx: view.getUint32(p + 4 + i * 12 + 8)
      });
    }
  }

  const sampleSizes = [];
  {
    const p = stsz.offset + stsz.headerSize + 4;
    const defaultSize = view.getUint32(p);
    const count = view.getUint32(p + 4);
    if (defaultSize > 0) {
      for (let i = 0; i < count; i++) sampleSizes.push(defaultSize);
    } else {
      for (let i = 0; i < count; i++) sampleSizes.push(view.getUint32(p + 8 + i * 4));
    }
  }

  const sampleOffsets = [];
  let curSample = 0;
  for (let c = 0; c < chunkOffsets.length; c++) {
    const chunkNum = c + 1;
    let stscEntry = stscEntries[0];
    for (let s = stscEntries.length - 1; s >= 0; s--) {
      if (chunkNum >= stscEntries[s].firstChunk) {
        stscEntry = stscEntries[s];
        break;
      }
    }
    let offset = chunkOffsets[c];
    for (let s = 0; s < stscEntry.samplesPerChunk && curSample < sampleSizes.length; s++) {
      sampleOffsets.push(offset);
      offset += sampleSizes[curSample];
      curSample++;
    }
  }

  const freqTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let freqIndex = freqTable.indexOf(sampleRate);
  if (freqIndex === -1) freqIndex = 4;

  const profile = 1;
  const chanCfg = channelCount;

  let totalSize = 0;
  for (let i = 0; i < sampleSizes.length; i++) totalSize += 7 + sampleSizes[i];

  const aacBuffer = new Uint8Array(totalSize);
  let outPos = 0;

  for (let i = 0; i < sampleSizes.length; i++) {
    const sLen = sampleSizes[i];
    const frameLen = sLen + 7;
    const sOffset = sampleOffsets[i];

    if (sOffset + sLen > buffer.length) break;

    aacBuffer[outPos] = 0xFF;
    aacBuffer[outPos + 1] = 0xF1;
    aacBuffer[outPos + 2] = ((profile & 0x3) << 6) | ((freqIndex & 0xF) << 2) | ((chanCfg >> 2) & 0x1);
    aacBuffer[outPos + 3] = ((chanCfg & 0x3) << 6) | ((frameLen >> 11) & 0x3);
    aacBuffer[outPos + 4] = (frameLen >> 3) & 0xFF;
    aacBuffer[outPos + 5] = ((frameLen & 0x7) << 5) | 0x1F;
    aacBuffer[outPos + 6] = 0xFC;

    aacBuffer.set(buffer.subarray(sOffset, sOffset + sLen), outPos + 7);
    outPos += frameLen;
  }

  return { aacBuffer: aacBuffer.slice(0, outPos), sampleRate, channelCount };
}

async function convertToPdf(html, filename) {
  const cleanHtml = cleanupHtml(html);

  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (content) => { document.open(); document.write(content); document.close(); },
    args: [cleanHtml]
  });

  await new Promise(r => setTimeout(r, 1500));

  await chrome.debugger.attach({ tabId: tab.id }, '1.3');

  let pdfData = null;
  try {
    const result = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      'Page.printToPDF',
      {
        printBackground: true,
        paperWidth: 8.27,
        paperHeight: 11.69,
        marginTop: 0.6,
        marginBottom: 0.6,
        marginLeft: 0.7,
        marginRight: 0.7,
        scale: 0.9
      }
    );
    pdfData = result.data;
  } finally {
    await chrome.debugger.detach({ tabId: tab.id });
    await chrome.tabs.remove(tab.id);
  }

  if (pdfData) {
    const pdfUrl = `data:application/pdf;base64,${pdfData}`;
    const safeName = filename.replace(/\.[^.]+$/, '') + '.pdf';
    chrome.downloads.download({ url: pdfUrl, filename: safeName, saveAs: false });
    return { success: true };
  }

  return { success: false, error: 'No PDF data returned' };
}

function cleanupHtml(html) {
  const prettyCss = `
    <style>
      * { box-sizing: border-box; }

      body {
        font-family: 'Segoe UI', Arial, sans-serif;
        font-size: 12pt;
        line-height: 1.7;
        color: #1a1a1a;
        margin: 0;
        padding: 0;
        background: white;
      }

      ol, ul {
        margin: 0.4em 0 0.4em 0;
        padding-left: 2em;
      }
      ol { list-style-type: decimal; }
      ul { list-style-type: disc; }

      li {
        margin: 0.3em 0;
        padding-left: 0.3em;
        display: list-item !important;
      }

      p, div {
        margin: 0.3em 0;
      }

      h1, h2, h3 {
        margin-top: 0.8em;
        margin-bottom: 0.3em;
        font-weight: bold;
      }
      h1 { font-size: 18pt; }
      h2 { font-size: 15pt; }
      h3 { font-size: 13pt; }

      table {
        width: 100%;
        border-collapse: collapse;
        margin: 0.5em 0;
      }
      td, th {
        border: 1px solid #ccc;
        padding: 6px 10px;
        vertical-align: top;
      }

      img {
        max-width: 100%;
        height: auto;
        display: block;
        margin: 0.5em auto;
      }

      .doc-content, .kix-page-content-wrapper {
        padding: 0 !important;
        margin: 0 !important;
      }
    </style>
  `;

  if (html.includes('</head>')) {
    html = html.replace('</head>', prettyCss + '</head>');
  } else if (html.includes('<body')) {
    html = html.replace('<body', prettyCss + '<body');
  } else {
    html = prettyCss + html;
  }

  return html;
}
