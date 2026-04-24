const socket = io();

const $ = (id) => document.getElementById(id);
const els = {
  toast: $('toast'), dot: $('dot'), clients: $('clients'), qr: $('qr'), phoneUrl: $('phoneUrl'), allUrls: $('allUrls'),
  themeToggle: $('themeToggle'), notifyToggle: $('notifyToggle'), testSound: $('testSound'), copyMainLink: $('copyMainLink'),
  statTexts: $('statTexts'), statFiles: $('statFiles'), statSize: $('statSize'),
  refreshTrust: $('refreshTrust'), trustDevices: $('trustDevices'),
  deviceName: $('deviceName'), saveDeviceName: $('saveDeviceName'), devices: $('devices'), targetDevice: $('targetDevice'), buzzBtn: $('buzzBtn'),
  textInput: $('textInput'), charCount: $('charCount'), pasteText: $('pasteText'), copyInput: $('copyInput'), shareInput: $('shareInput'), clearInput: $('clearInput'), sendText: $('sendText'),
  copyAllTexts: $('copyAllTexts'), clearTexts: $('clearTexts'), textSearch: $('textSearch'), textSort: $('textSort'), showPinnedOnly: $('showPinnedOnly'), texts: $('texts'),
  uploadForm: $('uploadForm'), fileInput: $('fileInput'), dropZone: $('dropZone'), selectedFilesPreview: $('selectedFilesPreview'), progress: $('progress'), uploadStatus: $('uploadStatus'), clearFilesInput: $('clearFilesInput'),
  refreshFiles: $('refreshFiles'), deleteSelectedFiles: $('deleteSelectedFiles'), clearFiles: $('clearFiles'), fileSearch: $('fileSearch'), fileSort: $('fileSort'), files: $('files'),
  events: $('events'), clearLocalEvents: $('clearLocalEvents')
};

let texts = [];
let files = [];
let events = [];
let devices = [];
let trustedDevices = [];
let selectedFiles = new Set();
let pinnedTexts = new Set(JSON.parse(localStorage.getItem('azudrop_pinned_texts') || '[]'));
let notifyOn = localStorage.getItem('azudrop_notify') === '1';
let soundOn = localStorage.getItem('azudrop_sound') === '1';
let audioCtx = null;
let autoCopyText = localStorage.getItem('azudrop_auto_copy') === '1';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
function fmtTime(value) { return new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); }
function absUrl(url) { return new URL(url, location.origin).href; }
function selfId() { return socket.id; }
function deviceKey() {
  let id = localStorage.getItem('azudrop_device_id');
  if (!id) {
    const random = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    id = 'dev_' + random.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    localStorage.setItem('azudrop_device_id', id);
  }
  return id;
}
function savePinned() { localStorage.setItem('azudrop_pinned_texts', JSON.stringify([...pinnedTexts])); }

function toast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1700);
}
async function copy(value) {
  const text = String(value || '');
  if (!text) return toast('Nothing to copy');
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { fallbackCopy(text); toast('Copied'); }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
function vibrate() { if (navigator.vibrate) navigator.vibrate(90); }
function notify(title, body) {
  if (notifyOn && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.svg' });
  }
}
function unlockAudio() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return false;
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return true;
  } catch { return false; }
}
function playSound(kind = 'default') {
  if (!soundOn) return;
  if (!unlockAudio() || !audioCtx) return;
  const now = audioCtx.currentTime;
  const tones = kind === 'buzz' ? [720, 520, 720] : kind === 'file' ? [520, 660] : [660, 880];
  tones.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now + i * 0.095);
    gain.gain.setValueAtTime(0.0001, now + i * 0.095);
    gain.gain.exponentialRampToValueAtTime(0.09, now + i * 0.095 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.095 + 0.075);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now + i * 0.095);
    osc.stop(now + i * 0.095 + 0.085);
  });
}
function alertUser(title, body, kind = 'default') {
  notify(title, body);
  playSound(kind);
  vibrate();
}
function applyTheme() {
  const theme = localStorage.getItem('azudrop_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.body.classList.toggle('dark', theme === 'dark');
  els.themeToggle.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
}
function applyNotify() { els.notifyToggle.textContent = (notifyOn || soundOn) ? 'Alerts on' : 'Alerts off'; }
function updateStats() {
  els.statTexts.textContent = texts.length;
  els.statFiles.textContent = files.length;
  els.statSize.textContent = fmtBytes(files.reduce((sum, file) => sum + file.size, 0));
}

async function loadInfo() {
  const data = await fetch('/api/info').then((r) => r.json());
  els.qr.src = data.qr;
  els.phoneUrl.textContent = data.url;
  els.phoneUrl.href = data.url;
  els.allUrls.innerHTML = (data.addresses || []).map((item) => `
    <div class="urlItem">
      <div><a href="${escapeHtml(item.url)}" target="_blank">${escapeHtml(item.url)}</a><div class="meta">${escapeHtml(item.name)}</div></div>
      <button class="btn small ghost" data-copy-url="${escapeHtml(item.url)}" type="button">Copy</button>
    </div>
  `).join('') || '<div class="empty">No network links found.</div>';
}
async function loadTexts() { texts = await fetch('/api/texts').then((r) => r.json()); renderTexts(); updateStats(); }
async function loadFiles() { files = await fetch('/api/files').then((r) => r.json()); renderFiles(); updateStats(); }
async function loadEvents() { events = await fetch('/api/events').then((r) => r.json()); renderEvents(); }
async function loadTrust() { trustedDevices = await fetch('/api/trust').then((r) => r.json()); renderTrust(); }
async function trustAction(id, action) {
  await fetch(`/api/trust/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
  await loadTrust();
}

function renderDevices() {
  const otherDevices = devices.filter((d) => d.id !== selfId() && !d.blocked);
  els.targetDevice.innerHTML = '<option value="all">All devices</option>' + otherDevices.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}${d.trusted ? ' · trusted' : ''}</option>`).join('');
  if (!devices.length) {
    els.devices.className = 'list compactList empty';
    els.devices.textContent = 'No devices yet.';
    return;
  }
  els.devices.className = 'list compactList';
  els.devices.innerHTML = devices.map((d) => `
    <div class="item">
      <div class="deviceRow">
        <div>
          <b>${escapeHtml(d.name)}${d.id === selfId() ? ' · this device' : ''}</b>
          <div class="meta">${escapeHtml(d.type)} · ${escapeHtml(d.ip)} · connected ${fmtTime(d.connectedAt)}</div>
          <div class="badgeRow">${d.trusted ? '<span class="badge good">Trusted</span>' : '<span class="badge">Untrusted</span>'}${d.blocked ? '<span class="badge bad">Blocked</span>' : ''}</div>
        </div>
        <div class="miniActions">
          <button class="btn small ghost" data-copy-ip="${escapeHtml(d.ip)}" type="button">Copy IP</button>
          ${d.id !== selfId() ? `<button class="btn small ghost" data-trust-action="${d.trusted ? 'untrust' : 'trust'}" data-trust-id="${escapeHtml(d.deviceKey)}" type="button">${d.trusted ? 'Untrust' : 'Trust'}</button>` : ''}
          ${d.id !== selfId() ? `<button class="btn small ${d.blocked ? 'ghost' : 'danger'}" data-trust-action="${d.blocked ? 'unblock' : 'block'}" data-trust-id="${escapeHtml(d.deviceKey)}" type="button">${d.blocked ? 'Unblock' : 'Block'}</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}
function renderTrust() {
  if (!trustedDevices.length) {
    els.trustDevices.className = 'list compactList empty';
    els.trustDevices.textContent = 'No known devices yet.';
    return;
  }
  els.trustDevices.className = 'list compactList';
  els.trustDevices.innerHTML = trustedDevices.map((d) => `
    <div class="item">
      <div class="deviceRow">
        <div>
          <b>${escapeHtml(d.name)}${d.id === deviceKey() ? ' · this device' : ''}</b>
          <div class="meta">${escapeHtml(d.type)} · ${escapeHtml(d.ip || 'unknown IP')} · last seen ${fmtTime(d.lastSeen || d.firstSeen)}</div>
          <div class="badgeRow">${d.online ? '<span class="badge good">Online</span>' : '<span class="badge">Offline</span>'}${d.trusted ? '<span class="badge good">Trusted</span>' : '<span class="badge">Untrusted</span>'}${d.blocked ? '<span class="badge bad">Blocked</span>' : ''}</div>
        </div>
        <div class="miniActions">
          <button class="btn small ghost" data-trust-action="${d.trusted ? 'untrust' : 'trust'}" data-trust-id="${escapeHtml(d.id)}" type="button">${d.trusted ? 'Untrust' : 'Trust'}</button>
          <button class="btn small ${d.blocked ? 'ghost' : 'danger'}" data-trust-action="${d.blocked ? 'unblock' : 'block'}" data-trust-id="${escapeHtml(d.id)}" type="button">${d.blocked ? 'Unblock' : 'Block'}</button>
          ${d.id !== deviceKey() ? `<button class="btn small ghost" data-trust-action="forget" data-trust-id="${escapeHtml(d.id)}" type="button">Forget</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}
function textMatches(item) {
  const q = els.textSearch.value.trim().toLowerCase();
  const matchesQuery = !q || item.text.toLowerCase().includes(q) || item.from.toLowerCase().includes(q) || item.toName.toLowerCase().includes(q);
  const matchesPinned = !els.showPinnedOnly.checked || pinnedTexts.has(item.id);
  return matchesQuery && matchesPinned;
}
function sortedTexts() {
  const pinned = texts.filter((t) => pinnedTexts.has(t.id) && textMatches(t));
  const normal = texts.filter((t) => !pinnedTexts.has(t.id) && textMatches(t));
  if (els.textSort.value === 'old') { pinned.reverse(); normal.reverse(); }
  return [...pinned, ...normal];
}
function renderTexts() {
  const list = sortedTexts();
  if (!list.length) {
    els.texts.className = 'list empty';
    els.texts.textContent = 'No text yet.';
    return;
  }
  els.texts.className = 'list';
  els.texts.innerHTML = list.map((t) => {
    const pinned = pinnedTexts.has(t.id);
    return `
      <article class="item ${pinned ? 'pinned' : ''}">
        <div class="itemTop">
          <div>
            <b>${pinned ? '<span class="pinBadge">Pinned · </span>' : ''}${escapeHtml(t.from)} → ${escapeHtml(t.toName || 'All devices')}</b>
            <div class="meta">${fmtTime(t.at)}</div>
          </div>
          <button class="btn small ghost" data-pin-text="${escapeHtml(t.id)}" type="button">${pinned ? 'Unpin' : 'Pin'}</button>
        </div>
        <div class="textBody">${escapeHtml(t.text)}</div>
        <div class="itemActions">
          <button class="btn small primary" data-copy-text="${escapeHtml(t.id)}" type="button">Copy</button>
          <button class="btn small ghost" data-use-text="${escapeHtml(t.id)}" type="button">Use again</button>
          <button class="btn small ghost" data-share-text="${escapeHtml(t.id)}" type="button">Share</button>
          <button class="btn small ghost" data-save-text="${escapeHtml(t.id)}" type="button">Save TXT</button>
          <button class="btn small danger" data-delete-text="${escapeHtml(t.id)}" type="button">Delete</button>
        </div>
      </article>
    `;
  }).join('');
}
function fileMatches(file) {
  const q = els.fileSearch.value.trim().toLowerCase();
  return !q || file.originalName.toLowerCase().includes(q) || file.type.toLowerCase().includes(q);
}
function sortedFiles() {
  const list = files.filter(fileMatches).slice();
  const s = els.fileSort.value;
  if (s === 'old') list.reverse();
  if (s === 'name') list.sort((a, b) => a.originalName.localeCompare(b.originalName));
  if (s === 'size') list.sort((a, b) => b.size - a.size);
  if (s === 'type') list.sort((a, b) => a.type.localeCompare(b.type));
  return list;
}
function fileVisualHtml(file) {
  const url = absUrl(file.url);
  if (file.type === 'image') {
    return `<a class="fileThumbLink" href="${url}" target="_blank" title="Open image"><img class="fileThumb" src="${url}" alt="Image preview" loading="lazy"></a>`;
  }
  return `<div class="fileIcon">${escapeHtml(file.type.slice(0, 4))}</div>`;
}
function previewHtml(file) {
  const url = absUrl(file.url);
  if (file.type === 'audio') return `<audio class="compactPreview" controls src="${url}"></audio>`;
  if (file.type === 'video') return `<a class="btn small ghost previewLink" href="${url}" target="_blank">Open video preview</a>`;
  if (file.type === 'pdf') return `<a class="btn small ghost previewLink" href="${url}" target="_blank">Open PDF</a>`;
  if (file.type === 'text') return `<a class="btn small ghost previewLink" href="${url}" target="_blank">Open text</a>`;
  return '';
}
function renderFiles() {
  const list = sortedFiles();
  if (!list.length) {
    els.files.className = 'list empty';
    els.files.textContent = 'No files yet.';
    return;
  }
  els.files.className = 'list';
  els.files.innerHTML = list.map((f) => {
    const checked = selectedFiles.has(f.name) ? 'checked' : '';
    return `
      <article class="item fileItem">
        <div class="fileCardTop">
          ${fileVisualHtml(f)}
          <div class="fileInfo">
            <label class="fileTitle"><input type="checkbox" data-select-file="${escapeHtml(f.name)}" ${checked}> <span>${escapeHtml(f.originalName)}</span></label>
            <div class="fileMeta"><span>${fmtBytes(f.size)}</span><span>${escapeHtml(f.type)}</span><span>${fmtTime(f.uploadedAt)}</span></div>
            ${previewHtml(f)}
          </div>
        </div>
        <div class="itemActions fileActions">
          <a class="buttonLike small primary" href="${f.url}" download>Download</a>
          <button class="btn small ghost" data-copy-file="${escapeHtml(f.url)}" type="button">Copy link</button>
          <button class="btn small ghost" data-share-file="${escapeHtml(f.url)}" type="button">Share</button>
          <button class="btn small ghost" data-rename-file="${escapeHtml(f.name)}" type="button">Rename</button>
          <button class="btn small danger" data-delete-file="${escapeHtml(f.name)}" type="button">Delete</button>
        </div>
      </article>
    `;
  }).join('');
}
function renderEvents() {
  if (!events.length) {
    els.events.className = 'list compactList empty';
    els.events.textContent = 'No activity yet.';
    return;
  }
  els.events.className = 'list compactList';
  els.events.innerHTML = events.slice(0, 5).map((e) => `
    <div class="item"><b>${escapeHtml(e.message)}</b><div class="meta">${fmtTime(e.at)} · ${escapeHtml(e.type)}</div></div>
  `).join('');
}

function sendHello() { socket.emit('device:hello', { name: els.deviceName.value.trim() || localStorage.getItem('azudrop_device_name') || '', deviceId: deviceKey() }); }
function sendText() {
  const text = els.textInput.value.trim();
  if (!text) return toast('Text is empty');
  socket.emit('text:send', { text, from: els.deviceName.value.trim(), toId: els.targetDevice.value });
  els.textInput.value = '';
  els.charCount.textContent = '0 characters';
}

function renderSelectedFiles(fileList) {
  const chosen = Array.from(fileList || els.fileInput.files || []);
  if (!els.selectedFilesPreview) return;
  if (!chosen.length) {
    els.selectedFilesPreview.className = 'selectedFilesPreview emptyMini';
    els.selectedFilesPreview.textContent = 'No files selected.';
    return;
  }
  const total = chosen.reduce((sum, file) => sum + file.size, 0);
  els.selectedFilesPreview.className = 'selectedFilesPreview';
  els.selectedFilesPreview.innerHTML = `
    <div class="selectedSummary"><b>${chosen.length} selected</b><span>${fmtBytes(total)}</span></div>
    <div class="selectedFileList">
      ${chosen.slice(0, 6).map((file) => `<div class="selectedFile"><span>${escapeHtml(file.name)}</span><em>${fmtBytes(file.size)}</em></div>`).join('')}
      ${chosen.length > 6 ? `<div class="selectedMore">+${chosen.length - 6} more file(s)</div>` : ''}
    </div>
  `;
}

function uploadFiles(fileList) {
  const chosen = Array.from(fileList || els.fileInput.files || []);
  if (!chosen.length) return toast('No files selected');
  const form = new FormData();
  chosen.forEach((file) => form.append('files', file));
  form.append('deviceName', els.deviceName.value.trim() || 'Unknown');
  form.append('deviceId', deviceKey());
  els.progress.value = 5;
  els.uploadStatus.textContent = `Uploading ${chosen.length} file(s)...`;
  els.uploadForm.classList.add('uploading');
  const xhr = new XMLHttpRequest();
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) els.progress.value = Math.round((e.loaded / e.total) * 100); };
  xhr.onload = async () => {
    els.progress.value = 0;
    els.uploadForm.classList.remove('uploading');
    els.uploadStatus.textContent = 'Upload complete';
    els.fileInput.value = '';
    renderSelectedFiles();
    await loadFiles();
    toast('Uploaded');
  };
  xhr.onerror = () => { els.progress.value = 0; els.uploadForm.classList.remove('uploading'); els.uploadStatus.textContent = 'Upload failed'; toast('Upload failed'); };
  xhr.open('POST', '/api/upload');
  xhr.send(form);
}

els.themeToggle.onclick = () => {
  const next = document.body.classList.contains('dark') ? 'light' : 'dark';
  localStorage.setItem('azudrop_theme', next);
  applyTheme();
};
els.notifyToggle.onclick = async () => {
  const turningOn = !(notifyOn || soundOn);
  unlockAudio();
  soundOn = turningOn;
  if (turningOn && 'Notification' in window && Notification.permission !== 'granted') {
    const permission = await Notification.requestPermission();
    notifyOn = permission === 'granted';
  } else {
    notifyOn = turningOn && (!('Notification' in window) || Notification.permission === 'granted');
  }
  localStorage.setItem('azudrop_notify', notifyOn ? '1' : '0');
  localStorage.setItem('azudrop_sound', soundOn ? '1' : '0');
  applyNotify();
  if (turningOn) { playSound('default'); toast(notifyOn ? 'Alerts enabled' : 'Sound enabled, browser notifications blocked'); }
  else toast('Alerts disabled');
};
els.testSound.onclick = () => { soundOn = true; localStorage.setItem('azudrop_sound', '1'); unlockAudio(); applyNotify(); playSound('default'); toast('Sound test'); };
els.saveDeviceName.onclick = () => { localStorage.setItem('azudrop_device_name', els.deviceName.value.trim()); sendHello(); toast('Device name saved'); };
els.copyMainLink.onclick = () => copy(els.phoneUrl.href);
els.refreshTrust.onclick = loadTrust;
els.sendText.onclick = sendText;
els.textInput.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') sendText(); });
els.textInput.oninput = () => { els.charCount.textContent = `${els.textInput.value.length} characters`; };
els.pasteText.onclick = async () => { try { els.textInput.value = await navigator.clipboard.readText(); els.textInput.oninput(); } catch { toast('Paste permission denied'); } };
els.copyInput.onclick = () => copy(els.textInput.value);
els.shareInput.onclick = async () => { if (navigator.share) await navigator.share({ text: els.textInput.value }); else copy(els.textInput.value); };
els.clearInput.onclick = () => { els.textInput.value = ''; els.textInput.oninput(); };
els.copyAllTexts.onclick = () => copy(texts.slice().reverse().map((t) => `${t.from}: ${t.text}`).join('\n\n'));
els.clearTexts.onclick = async () => { if (confirm('Clear all text history?')) { await fetch('/api/texts', { method: 'DELETE' }); texts = []; pinnedTexts.clear(); savePinned(); renderTexts(); updateStats(); } };
els.textSearch.oninput = renderTexts;
els.textSort.onchange = renderTexts;
els.showPinnedOnly.onchange = renderTexts;
els.uploadForm.onsubmit = (e) => { e.preventDefault(); uploadFiles(); };
els.clearFilesInput.onclick = () => { els.fileInput.value = ''; renderSelectedFiles(); els.uploadStatus.textContent = ''; els.progress.value = 0; };
els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('drag'); });
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('drag'));
els.fileInput.addEventListener('change', () => renderSelectedFiles());
els.dropZone.addEventListener('drop', (e) => { e.preventDefault(); els.dropZone.classList.remove('drag'); uploadFiles(e.dataTransfer.files); });
els.refreshFiles.onclick = loadFiles;
els.fileSearch.oninput = renderFiles;
els.fileSort.onchange = renderFiles;
els.clearFiles.onclick = async () => { if (confirm('Delete all files?')) { await fetch('/api/files', { method: 'DELETE' }); files = []; selectedFiles.clear(); renderFiles(); updateStats(); } };
els.deleteSelectedFiles.onclick = async () => {
  const names = [...selectedFiles];
  if (!names.length) return toast('No files selected');
  if (confirm(`Delete ${names.length} selected file(s)?`)) {
    await fetch('/api/files/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }) });
    selectedFiles.clear();
    await loadFiles();
  }
};
els.buzzBtn.onclick = () => socket.emit('buzz', { from: els.deviceName.value.trim(), toId: els.targetDevice.value });
els.clearLocalEvents.onclick = async () => { events = []; renderEvents(); updateStats(); };

document.addEventListener('click', async (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.copyUrl) copy(button.dataset.copyUrl);
  if (button.dataset.copyText) { const t = texts.find((x) => x.id === button.dataset.copyText); if (t) copy(t.text); }
  if (button.dataset.pinText) { pinnedTexts.has(button.dataset.pinText) ? pinnedTexts.delete(button.dataset.pinText) : pinnedTexts.add(button.dataset.pinText); savePinned(); renderTexts(); }
  if (button.dataset.useText) { const t = texts.find((x) => x.id === button.dataset.useText); if (t) { els.textInput.value = t.text; els.textInput.oninput(); els.textInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }
  if (button.dataset.saveText) { const t = texts.find((x) => x.id === button.dataset.saveText); if (t) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t.text], { type: 'text/plain' })); a.download = 'azudrop-text.txt'; a.click(); URL.revokeObjectURL(a.href); } }
  if (button.dataset.shareText) { const t = texts.find((x) => x.id === button.dataset.shareText); if (t && navigator.share) navigator.share({ text: t.text }); else if (t) copy(t.text); }
  if (button.dataset.deleteText) { if (confirm('Delete this text item?')) { await fetch('/api/texts/' + encodeURIComponent(button.dataset.deleteText), { method: 'DELETE' }); texts = texts.filter((x) => x.id !== button.dataset.deleteText); pinnedTexts.delete(button.dataset.deleteText); savePinned(); renderTexts(); updateStats(); } }
  if (button.dataset.copyFile) copy(absUrl(button.dataset.copyFile));
  if (button.dataset.shareFile) { const url = absUrl(button.dataset.shareFile); if (navigator.share) navigator.share({ url }); else copy(url); }
  if (button.dataset.deleteFile) { if (confirm('Delete this file?')) { await fetch('/api/files/' + encodeURIComponent(button.dataset.deleteFile), { method: 'DELETE' }); await loadFiles(); } }
  if (button.dataset.renameFile) { const old = files.find((f) => f.name === button.dataset.renameFile); const newName = prompt('New file name:', old?.originalName || ''); if (newName) { await fetch('/api/files/' + encodeURIComponent(button.dataset.renameFile), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ newName }) }); await loadFiles(); } }
  if (button.dataset.copyIp) copy(button.dataset.copyIp);
  if (button.dataset.trustAction && button.dataset.trustId) {
    const action = button.dataset.trustAction;
    if ((action === 'block' || action === 'forget') && !confirm(`${action === 'block' ? 'Block' : 'Forget'} this device?`)) return;
    await trustAction(button.dataset.trustId, action);
    toast(`Device ${action} updated`);
  }
});

document.addEventListener('change', (e) => {
  const checkbox = e.target.closest('[data-select-file]');
  if (checkbox) checkbox.checked ? selectedFiles.add(checkbox.dataset.selectFile) : selectedFiles.delete(checkbox.dataset.selectFile);
});

socket.on('connect', () => { els.dot.classList.add('ok'); sendHello(); });
socket.on('disconnect', () => { els.dot.classList.remove('ok'); els.clients.textContent = 'Disconnected'; });
socket.on('clients', (n) => { els.clients.textContent = `${n} online`; });
socket.on('devices:list', (list) => { devices = list; renderDevices(); });
socket.on('trust:list', (list) => { trustedDevices = list; renderTrust(); });
socket.on('text:new', (item) => {
  texts.unshift(item);
  renderTexts();
  updateStats();
  if (item.fromId !== selfId()) {
    toast('New text received');
    alertUser('AzuDrop', 'New text received', 'text');
    if (autoCopyText) copy(item.text);
  }
});
socket.on('text:deleted', (id) => { texts = texts.filter((x) => x.id !== id); pinnedTexts.delete(id); savePinned(); renderTexts(); updateStats(); });
socket.on('texts:cleared', () => { texts = []; pinnedTexts.clear(); savePinned(); renderTexts(); updateStats(); });
socket.on('file:new', async (list) => { await loadFiles(); toast(`${list.length} new file(s)`); alertUser('AzuDrop', 'New file received', 'file'); });
socket.on('file:deleted', loadFiles);
socket.on('file:renamed', loadFiles);
socket.on('files:batchDeleted', loadFiles);
socket.on('files:cleared', () => { files = []; selectedFiles.clear(); renderFiles(); updateStats(); });
socket.on('event:new', (event) => { events.unshift(event); if (events.length > 200) events.length = 200; renderEvents(); updateStats(); });
socket.on('events:cleared', () => { events = []; renderEvents(); });
socket.on('buzz', (data) => { toast(`${data.from} sent a ping`); alertUser('AzuDrop', `${data.from} sent a ping`, 'buzz'); });
socket.on('device:blocked', (data) => { toast(data.message || 'This device is blocked'); });
socket.on('blocked:action', (data) => { toast(data.message || 'Action blocked'); });
setInterval(() => socket.emit('device:ping'), 15000);

const panelLabels = ["home", "texts", "files", "devices", "activity"];

function getFirstPanelElement(panel) {
  return document.querySelector(".tabPanel[data-panel=\"" + panel + "\"]");
}

function setActivePanel(panel, options = {}) {
  const target = panelLabels.includes(panel)
    ? panel
    : (localStorage.getItem("azudrop_active_panel") || "home");
  const fromClick = Boolean(options.fromClick);
  const isMobile = window.matchMedia("(max-width: 760px)").matches;

  localStorage.setItem("azudrop_active_panel", target);

  document.querySelectorAll(".tabBtn").forEach((btn) => {
    const active = btn.dataset.panelTarget === target;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-current", active ? "page" : "false");
  });

  document.querySelectorAll(".tabPanel").forEach((section) => {
    section.classList.toggle("activePanel", section.dataset.panel === target);
  });

  if (!fromClick) return;

  if (isMobile) {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }

  const targetElement = getFirstPanelElement(target);
  if (targetElement) {
    targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

document.addEventListener("click", (event) => {
  const btn = event.target.closest(".tabBtn");
  if (!btn) return;
  event.preventDefault();
  setActivePanel(btn.dataset.panelTarget, { fromClick: true });
});

window.addEventListener("resize", () => {
  setActivePanel(localStorage.getItem("azudrop_active_panel") || "home");
});

(async function init() {
  setActivePanel();
  applyTheme();
  applyNotify();
  els.deviceName.value = localStorage.getItem('azudrop_device_name') || '';
  await Promise.all([loadInfo(), loadTexts(), loadFiles(), loadEvents(), loadTrust()]);
  sendHello();
})();
