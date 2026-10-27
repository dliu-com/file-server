// Shared helpers for the files.dliu.com pages.

// The owner hint cookie only decides whether to show owner controls; the API checks the real session.
export const isOwner = () => document.cookie.split(';').some((c) => c.trim() === 'files_owner=1');

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
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
  if (!response.ok) throw new Error(`Could not load the file list (${response.status})`);
  return response.json();
}

/** The URL path of a file or folder, encoded the way browsers send it (matches the API's CDN invalidations). */
export const urlPath = (path) => '/' + path.split('/').map((segment) => encodeURIComponent(segment)
  .replace(/%(2[146-9ABC]|3[ABD]|40)/gi, (match) => decodeURIComponent(match))).join('/');

export function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

export async function copyText(text, message = 'Link copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast('Copy failed; select the text and copy it yourself');
  }
}

export const signInUrl = () => `/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`;

/** Fills the header's nav: Sign out for the owner, Sign in for everyone else. */
export function renderNav() {
  const nav = document.querySelector('header.top nav');
  if (!nav) return;
  nav.replaceChildren(isOwner()
    ? el('a', { class: 'button', href: '/auth/logout' }, 'Sign out')
    : el('a', { class: 'button sign-in', href: signInUrl() }, 'Sign in'));
}
