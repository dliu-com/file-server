import {
  api, copyText, el, formatDate, formatDuration, formatSize, getListing, isOwner, renderNav, signInUrl, toast, urlPath,
} from './common.js';

const $ = (id) => document.getElementById(id);
const CONCURRENCY = 4;
const SIGN_BATCH = 20;
const RETRIES = 4;
// Files the operating system leaves in folders; never worth uploading.
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const TEXT_TYPES = /^(text\/[\w.+-]+|application\/(json|javascript|xml|[\w.+-]+\+(json|xml)))$/;
const VALID_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
const ICONS = [
  [/^image\//, '🖼️'], [/^video\//, '🎬'], [/^audio\//, '🎵'], [/^application\/pdf$/, '📕'],
  [/zip|compressed|x-tar|gzip|x-7z|x-rar/, '📦'], [/^text\/|json|xml|javascript/, '📝'],
];

const owner = isOwner();
let listing = { files: [] };
let folder = '';
let current = null; // the upload in progress: { cancelled, xhrs }

const name = (path) => path.slice(path.lastIndexOf('/') + 1);
const join = (...parts) => parts.filter(Boolean).join('/');
const folderUrl = (path) => (path ? `${urlPath(path)}/` : '/');
const iconFor = (type) => (ICONS.find(([pattern]) => pattern.test(type)) || [null, '📄'])[1];
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** The folder (or, without a trailing slash, the folder or file) in the address bar. */
function pathFromLocation() {
  const raw = location.pathname === '/index.html' ? '/' : location.pathname;
  try {
    return { path: raw.split('/').filter(Boolean).map(decodeURIComponent).join('/').normalize('NFC'), slash: raw.endsWith('/') };
  } catch {
    return { path: raw, slash: false, invalid: true };
  }
}

function setStatus(text, kind = 'muted') {
  $('status').className = kind;
  $('status').textContent = text;
  $('status').hidden = !text;
}

/** Folders and files directly in `path`, or everything below it that matches `query`. */
function contents(path, query) {
  const prefix = path ? `${path}/` : '';
  const below = listing.files.filter((f) => f.path.startsWith(prefix));
  if (query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return { folders: [], files: below.filter((f) => words.every((w) => f.path.slice(prefix.length).toLowerCase().includes(w))) };
  }
  const folders = new Map();
  const files = [];
  for (const file of below) {
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      files.push(file);
    } else {
      const sub = rest.slice(0, slash);
      const info = folders.get(sub) || { name: sub, path: prefix + sub, count: 0, size: 0, modified: '' };
      info.count += 1;
      info.size += file.size;
      if (file.modified > info.modified) info.modified = file.modified;
      folders.set(sub, info);
    }
  }
  return { folders: [...folders.values()].sort((a, b) => byName(a.name, b.name)), files: files.sort((a, b) => byName(name(a.path), name(b.path))) };
}

function renderCrumbs() {
  const parts = folder ? folder.split('/') : [];
  const crumbs = [el('a', { href: '/', 'data-folder': '' }, 'Files')];
  parts.forEach((part, i) => {
    const path = parts.slice(0, i + 1).join('/');
    crumbs.push(el('span', { class: 'sep', 'aria-hidden': 'true' }, '/'));
    crumbs.push(i === parts.length - 1
      ? el('span', { 'aria-current': 'page' }, part)
      : el('a', { href: folderUrl(path), 'data-folder': path }, part));
  });
  $('crumbs').replaceChildren(...crumbs);
  document.title = `${folder ? `${name(folder)} · ` : ''}Files · dliu.com`;
}

function actionsFor(item, isFolder) {
  const link = location.origin + (isFolder ? folderUrl(item.path) : urlPath(item.path));
  const buttons = [el('button', { type: 'button', title: 'Copy link', onclick: () => copyText(link) }, 'Copy link')];
  if (!isFolder) buttons.push(el('a', { class: 'button', href: urlPath(item.path), download: name(item.path), title: 'Download' }, 'Download'));
  if (owner) {
    buttons.push(
      el('button', { type: 'button', onclick: () => move(item.path) }, 'Move'),
      el('button', { type: 'button', class: 'danger', onclick: () => remove(item.path, isFolder ? item.count : 0) }, 'Delete'),
    );
  }
  return el('td', { class: 'actions' }, el('div', { class: 'row' }, buttons));
}

function render() {
  renderCrumbs();
  const query = $('search').value.trim();
  const { folders, files } = contents(folder, query);
  const rows = [
    ...folders.map((f) => el('tr', {},
      el('td', { class: 'name' }, el('a', { href: folderUrl(f.path), 'data-folder': f.path }, el('span', { class: 'icon', 'aria-hidden': 'true' }, '📁'), f.name)),
      el('td', { class: 'size' }, `${f.count} file${f.count === 1 ? '' : 's'}`),
      el('td', { class: 'date' }, formatDate(f.modified)),
      actionsFor(f, true))),
    ...files.map((f) => el('tr', {},
      el('td', { class: 'name' }, el('a', { href: urlPath(f.path) },
        el('span', { class: 'icon', 'aria-hidden': 'true' }, iconFor(f.type)),
        query ? f.path.slice(folder ? folder.length + 1 : 0) : name(f.path))),
      el('td', { class: 'size' }, formatSize(f.size)),
      el('td', { class: 'date' }, formatDate(f.modified)),
      actionsFor(f, false))),
  ];
  $('rows').replaceChildren(...rows);
  $('files').hidden = !rows.length;
  if (rows.length) setStatus('');
  else if (query) setStatus('Nothing matches your search.');
  else if (!folder) setStatus(owner ? 'No files yet. Upload some, or drop them here.' : 'No files yet.');
  else setStatus(owner ? 'This folder is empty. Upload files to keep it; empty folders are not saved.' : 'This folder does not exist.');
  $('drop-hint').hidden = !owner;
}

/** Shows the address bar's folder. A URL without the trailing slash may be a folder (redirect) or a missing file. */
function route() {
  const { path, slash, invalid } = pathFromLocation();
  if (!slash && path) {
    if (!invalid && listing.files.some((f) => f.path.startsWith(`${path}/`))) {
      history.replaceState(null, '', folderUrl(path) + location.search);
    } else {
      folder = '';
      renderCrumbs();
      $('files').hidden = true;
      $('drop-hint').hidden = true;
      $('status').className = '';
      $('status').replaceChildren(el('strong', {}, 'Not found. '), `“${path}” does not exist or was moved. `, el('a', { href: '/', 'data-folder': '' }, 'Browse all files'));
      $('status').hidden = false;
      return;
    }
  }
  folder = path;
  render();
}

function go(path) {
  history.pushState(null, '', folderUrl(path));
  $('search').value = '';
  route();
  window.scrollTo(0, 0);
}

async function reload() {
  try {
    listing = await getListing();
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }
  route();
}

/** Adds what the API returned at once; the CDN copy of the listing can lag a moment behind. */
function remember(file) {
  listing.files = listing.files.filter((f) => f.path !== file.path).concat(file);
}

function handleError(error, what) {
  if (error.status === 401) {
    location.href = signInUrl();
    return;
  }
  toast(`${what} failed: ${error.message}`);
}

async function move(path) {
  const to = prompt(`Move or rename “${name(path)}”. New path (use / for folders):`, path);
  if (to === null || to.trim().replace(/^\/+|\/+$/g, '') === path) return;
  try {
    const result = await api('/api/files/move', { from: path, to });
    const map = new Map(result.moved.map((m) => [m.from, m.to]));
    listing.files = listing.files.map((f) => (map.has(f.path) ? { ...f, path: map.get(f.path) } : f));
    toast('Moved');
    render();
    reload();
  } catch (error) {
    handleError(error, 'Move');
  }
}

async function remove(path, count) {
  const what = count ? `the folder “${name(path)}” and the ${count} file${count === 1 ? '' : 's'} in it` : `“${name(path)}”`;
  if (!confirm(`Delete ${what}? Links to ${count ? 'them' : 'it'} will stop working.`)) return;
  try {
    const result = await api('/api/files/delete', { path });
    const gone = new Set(result.deleted);
    listing.files = listing.files.filter((f) => !gone.has(f.path));
    toast('Deleted');
    render();
    reload();
  } catch (error) {
    handleError(error, 'Delete');
  }
}

function newFolder() {
  const value = prompt('New folder name:');
  const clean = value && value.trim().replace(/^\/+|\/+$/g, '');
  if (clean) go(join(folder, clean));
}

// ---------- Uploads ----------

function contentTypeOf(file) {
  const type = (file.type || '').toLowerCase();
  if (!VALID_TYPE.test(type)) return '';
  // Without a charset, browsers may show UTF-8 text (e.g. Chinese) as gibberish.
  return TEXT_TYPES.test(type) ? `${type}; charset=utf-8` : type;
}

function putPart(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(Object.assign(new Error(`Part upload failed (${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Cancelled'));
    current.xhrs.add(xhr);
    xhr.onloadend = () => current && current.xhrs.delete(xhr);
    xhr.send(blob);
  });
}

async function uploadParts(file, plan, report) {
  const loaded = new Array(plan.partCount + 1).fill(0);
  const etags = [];
  const urls = {};
  const update = () => report(loaded.reduce((a, b) => a + b, 0));

  let signing = null;
  async function urlFor(part, fresh = false) {
    if (fresh) delete urls[part];
    // One signing request at a time; it covers the next SIGN_BATCH parts, so other workers wait for it.
    while (!urls[part]) {
      if (!signing) {
        const wanted = [];
        for (let n = part; n <= plan.partCount && wanted.length < SIGN_BATCH; n += 1) if (!urls[n]) wanted.push(n);
        signing = api('/api/uploads/parts', { token: plan.token, parts: wanted })
          .then((result) => Object.assign(urls, result.urls))
          .finally(() => { signing = null; });
      }
      await signing;
    }
    return urls[part];
  }

  let next = 1;
  async function worker() {
    while (next <= plan.partCount) {
      const part = next;
      next += 1;
      const blob = file.slice((part - 1) * plan.partSize, Math.min(part * plan.partSize, file.size));
      for (let attempt = 1; ; attempt += 1) {
        if (current.cancelled) throw new Error('Cancelled');
        try {
          // A 403 usually means the signed URL expired, so sign it again.
          const etag = await putPart(await urlFor(part, attempt > 1), blob, (n) => { loaded[part] = n; update(); });
          etags.push({ partNumber: part, etag });
          loaded[part] = blob.size;
          update();
          break;
        } catch (error) {
          loaded[part] = 0;
          if (current.cancelled || error.status === 401 || attempt >= RETRIES) throw error;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.partCount) }, worker));
  return etags;
}

async function uploadOne(file, path, report) {
  const request = { path, contentType: contentTypeOf(file), size: file.size };
  let plan;
  try {
    plan = await api('/api/uploads', request);
  } catch (error) {
    if (error.status !== 409 || !/already exists/.test(error.message)) throw error;
    if (!confirm(`“${path}” already exists. Replace it?`)) return 'skipped';
    plan = await api('/api/uploads', { ...request, overwrite: true });
  }
  try {
    const parts = await uploadParts(file, plan, report);
    const { file: saved } = await api('/api/uploads/complete', { token: plan.token, parts });
    remember(saved);
    return plan.replacing ? 'replaced' : 'uploaded';
  } catch (error) {
    await api('/api/uploads/abort', { token: plan.token }).catch(() => {});
    throw error;
  }
}

const warnLeave = (event) => { event.preventDefault(); event.returnValue = ''; };

/** Uploads [{ file, relative }] into the current folder, one file at a time. */
async function uploadAll(items) {
  if (current) {
    toast('Wait for the current upload to finish');
    return;
  }
  const queue = items.filter((item) => !JUNK.has(item.file.name));
  if (!queue.length) return;
  const target = folder;
  const total = queue.reduce((sum, item) => sum + item.file.size, 0);
  let done = 0;
  const log = $('upload-log');
  log.replaceChildren();
  $('uploads').hidden = false;
  $('upload-cancel').hidden = false;
  $('bar').style.width = '0';
  window.addEventListener('beforeunload', warnLeave);
  current = { cancelled: false, xhrs: new Set() };
  const started = performance.now();
  const results = { uploaded: 0, replaced: 0, skipped: 0, failed: 0 };

  for (const [index, item] of queue.entries()) {
    if (current.cancelled) break;
    const path = join(target, item.relative);
    $('upload-title').textContent = `Uploading ${index + 1} of ${queue.length}: ${item.relative}`;
    const report = (bytes) => {
      const sent = done + bytes;
      const speed = sent / Math.max((performance.now() - started) / 1000, 0.1);
      $('bar').style.width = `${((sent / Math.max(total, 1)) * 100).toFixed(1)}%`;
      $('upload-text').textContent = `${formatSize(sent)} of ${formatSize(total)} · ${formatSize(speed)}/s · ${formatDuration((total - sent) / speed) || '0:00'} left`;
    };
    report(0);
    try {
      if (!item.file.size) throw new Error('empty files cannot be uploaded');
      const outcome = await uploadOne(item.file, path, report);
      results[outcome] += 1;
      if (outcome === 'skipped') log.append(el('li', { class: 'muted' }, `Skipped ${item.relative}`));
    } catch (error) {
      if (error.status === 401) {
        location.href = signInUrl();
        return;
      }
      if (current.cancelled) break;
      results.failed += 1;
      log.append(el('li', { class: 'error' }, `${item.relative}: ${error.message}`));
    }
    done += item.file.size;
    render();
  }

  window.removeEventListener('beforeunload', warnLeave);
  const cancelled = current.cancelled;
  current = null;
  $('upload-cancel').hidden = true;
  $('bar').style.width = '100%';
  const summary = [
    results.uploaded && `${results.uploaded} uploaded`,
    results.replaced && `${results.replaced} replaced`,
    results.skipped && `${results.skipped} skipped`,
    results.failed && `${results.failed} failed`,
  ].filter(Boolean).join(', ');
  $('upload-title').textContent = cancelled ? `Upload cancelled${summary ? ` (${summary})` : ''}` : `Done: ${summary || 'nothing uploaded'}`;
  $('upload-text').textContent = '';
  if (!results.failed && !cancelled) setTimeout(() => { if (!current) $('uploads').hidden = true; }, 4000);
  reload();
}

/** Files and folders dropped on the page, with their paths relative to the drop. */
async function droppedItems(dataTransfer) {
  // Entries must be taken before the first await; the browser empties the drop data afterwards.
  const entries = [...dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, relative: file.name }));
  const items = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      items.push({ file, relative: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  }
  for (const entry of entries) await walk(entry, '');
  return items;
}

// ---------- Start ----------

renderNav();
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-folder]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  go(link.getAttribute('data-folder'));
});
window.addEventListener('popstate', () => { $('search').value = ''; route(); });
$('search').addEventListener('input', render);

if (owner) {
  $('owner-actions').hidden = false;
  $('upload-files').addEventListener('click', () => $('file-input').click());
  $('upload-folder').addEventListener('click', () => $('folder-input').click());
  $('new-folder').addEventListener('click', newFolder);
  $('file-input').addEventListener('change', () => {
    uploadAll([...$('file-input').files].map((file) => ({ file, relative: file.name })));
    $('file-input').value = '';
  });
  $('folder-input').addEventListener('change', () => {
    uploadAll([...$('folder-input').files].map((file) => ({ file, relative: file.webkitRelativePath || file.name })));
    $('folder-input').value = '';
  });
  $('upload-cancel').addEventListener('click', () => {
    if (!current) return;
    current.cancelled = true;
    current.xhrs.forEach((xhr) => xhr.abort());
  });
  let depth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    depth += 1;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', async (event) => {
    event.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (!event.dataTransfer.types.includes('Files')) return;
    uploadAll(await droppedItems(event.dataTransfer));
  });
}

reload();
