// Shared helpers for the files.dliu.com pages.

// i18n.js (a classic script loaded first) sets window.FilesI18n; without it everything stays English.
const i18n = () => (typeof window !== 'undefined' && window.FilesI18n) || null;
export const t = (zh, en) => (i18n() ? i18n().t(zh, en) : en);
export const locale = () => (i18n() ? i18n().locale() : undefined);
export const translateError = (message) => (i18n() ? i18n().translateError(message) : message);
/** Runs `redraw` whenever the reader switches language. */
export const onLanguageChange = (redraw) => window.addEventListener('files-language-change', redraw);

// The owner hint cookie only decides whether to show owner controls; the API checks the real session.
export const isOwner = () => document.cookie.split(';').some((c) => c.trim() === 'files_owner=1');

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ApiError extends Error {
  constructor(message, status) {
    super(translateError(message));
    this.status = status;
  }
}

/** GET when body is undefined, otherwise POST JSON. CloudFront (OAC) needs the body hash for POSTs to Lambda. */
export async function api(path, body) {
  const init = { credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    const text = JSON.stringify(body);
    init.method = 'POST';
    init.body = text;
    init.headers['content-type'] = 'application/json';
    init.headers['x-amz-content-sha256'] = await sha256Hex(text);
  }
  const response = await fetch(path, init);
  // CloudFront swaps every 404 for the not-found page, so a 404 from the API has no JSON message.
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallback = response.status === 404 ? 'Not found; it may have changed in another tab. Reload and try again.' : `Request failed (${response.status})`;
    throw new ApiError(data.error || fallback, response.status);
  }
  return data;
}

/** Every file: { updatedAt, files: [{ path, size, type, modified }] }. Empty before the first upload. */
export async function getListing() {
  const response = await fetch('/_data/files.json', { cache: 'no-store', headers: { accept: 'application/json' } });
  if (response.status === 403 || response.status === 404) return { files: [] };
  if (!response.ok) throw new Error(translateError(`Could not load the file list (${response.status})`));
  return response.json();
}

/** The URL path of a file or folder, encoded the way browsers send it (matches the API's CDN invalidations). */
export const urlPath = (path) => '/' + path.split('/').map((segment) => encodeURIComponent(segment)
  .replace(/%(2[146-9ABC]|3[ABD]|40)/gi, (match) => decodeURIComponent(match))).join('/');

export function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(locale(), { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Creates an element: el('a', { href: '/' }, 'text', child). Text is always set as text, never as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function toast(message) {
  const node = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 2500);
}

export async function copyText(text, message = t('链接已复制', 'Link copied')) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast(t('复制失败；请手动选择文字并复制', 'Copy failed; select the text and copy it yourself'));
  }
}

export const signInUrl = () => `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`;

/** Fills the header's nav: Docs for everyone, then Sign out for the owner or Sign in for everyone else,
 * then the language switcher (from i18n.js), which stays last. */
export function renderNav() {
  const nav = document.querySelector('.dl-header .dl-nav');
  if (!nav) return;
  // /docs (architecture, cost, security, testing, API) is the docs page; /docs/ is an ordinary folder.
  const docs = el('a', { class: 'dl-button', href: '/docs' }, t('文档', 'Docs'));
  if (location.pathname === '/docs') docs.setAttribute('aria-current', 'page');
  const switcher = i18n() && i18n().switcher;
  nav.replaceChildren(docs, isOwner()
    ? el('a', { class: 'dl-button', href: '/auth/logout' }, t('退出登录', 'Sign out'))
    : el('a', { class: 'dl-button dl-signin', href: signInUrl() }, t('登录', 'Sign in')), ...(switcher ? [switcher] : []));
}
