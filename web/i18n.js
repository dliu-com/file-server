'use strict';

// Page language, Chinese or English, as on blog.dliu.com. A choice saved in this browser wins;
// otherwise the browser's language decides (any zh-* is Chinese, everything else English).
// File names are shown as they are. Exposes window.FilesI18n for the page scripts.
(() => {
  const KEY = 'files-language';
  const LANGUAGES = [['zh', '中文'], ['en', 'English']];

  function initialLanguage(saved, browserLanguage) {
    if (saved === 'zh' || saved === 'en') return saved;
    return /^zh(?:-|$)/i.test(browserLanguage || '') ? 'zh' : 'en';
  }

  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  let language = initialLanguage(saved, navigator.language);

  const t = (zh, en) => (language === 'zh' ? zh : en);
  const locale = () => (language === 'zh' ? 'zh-CN' : 'en-GB');

  // Messages the API and browser send, in Chinese. Anything unknown is shown as sent.
  const ERRORS = {
    'Not found': '未找到',
    'Not signed in': '尚未登录',
    'Forbidden': '没有权限',
    'Method not allowed': '不支持该请求方法',
    'Internal error': '服务器内部错误',
    'Request too large': '请求过大',
    'Body must be a JSON object': '请求内容应为 JSON 对象',
    'Invalid content type': '文件类型无效',
    'Invalid part number': '分片编号无效',
    'Invalid part list': '分片列表无效',
    'Upload not found or expired': '上传不存在或已过期',
    'Uploaded file is missing': '上传的文件不见了',
    'Empty files cannot be uploaded': '不能上传空文件',
    'empty files cannot be uploaded': '不能上传空文件',
    'The new path is the same as the old one': '新路径与原路径相同',
    'A folder cannot be moved into itself': '文件夹不能移动到它自己里面',
    'Too much data to move at once': '一次移动的数据太多',
    '"index.html" at the top level is reserved for the site': '顶层的 “index.html” 是网站保留的名称',
    'Not found; it may have changed in another tab. Reload and try again.': '未找到；可能已在其他标签页中更改。请刷新后重试。',
    'Network error': '网络错误',
    'Cancelled': '已取消',
  };
  const PATTERNS = [
    [/^Request failed \((\d+)\)$/, (n) => `请求失败（${n}）`],
    [/^Part upload failed \((\d+)\)$/, (n) => `分片上传失败（${n}）`],
    [/^Could not load the file list \((\d+)\)$/, (n) => `无法加载文件列表（${n}）`],
    [/^"(.+)" already exists$/, (p) => `“${p}” 已存在`],
    [/^"(.+)" not found$/, (p) => `未找到 “${p}”`],
    [/^"(.+)" is a folder$/, (p) => `“${p}” 是文件夹`],
    [/^"(.+)" is a file, not a folder$/, (p) => `“${p}” 是文件，不是文件夹`],
    [/^"(.+)" is reserved for the site; choose another top-level name$/, (p) => `“${p}” 是网站保留的名称，请换一个顶层名称`],
    [/^"(.+)" is reserved for the site's documentation$/, (p) => `“${p}” 是网站文档保留的路径`],
    [/^(\w+) is required$/, (n) => `缺少 ${n}`],
    [/^(\w+) is too long$/, (n) => `${n} 太长`],
    [/^(\w+) has an empty name or one that starts or ends with a space$/, (n) => `${n} 含有空名称，或名称以空格开头或结尾`],
    [/^(\w+) cannot contain \. or \.\.$/, (n) => `${n} 不能包含 . 或 ..`],
    [/^(\w+) has a name longer than 255 characters$/, (n) => `${n} 中有超过 255 个字符的名称`],
    [/^(\w+) cannot contain \\ \? # % or control characters$/, (n) => `${n} 不能包含 \\ ? # % 或控制字符`],
    [/^size must be between 1 byte and (\d+) GiB$/, (n) => `文件大小必须在 1 字节到 ${n} GiB 之间`],
    [/^Folders with more than (\d+) files cannot be moved here$/, (n) => `超过 ${n} 个文件的文件夹不能在这里移动`],
    [/^Ask for 1 to (\d+) parts at a time$/, (n) => `每次请求 1 到 ${n} 个分片`],
    [/^Expected (\d+) parts, got (\d+)$/, (a, b) => `应为 ${a} 个分片，实际 ${b} 个`],
    [/^Could not delete (.+)$/, (p) => `无法删除 ${p}`],
  ];
  function translateError(message) {
    if (language !== 'zh' || !message) return message;
    if (ERRORS[message]) return ERRORS[message];
    for (const [pattern, zh] of PATTERNS) {
      const match = pattern.exec(message);
      if (match) return zh(...match.slice(1));
    }
    return message;
  }

  // Static HTML: data-zh holds the Chinese text, data-zh-label the Chinese aria-label,
  // data-zh-placeholder the Chinese placeholder.
  function translatePage() {
    for (const node of document.querySelectorAll('[data-zh]')) {
      if (node.dataset.en == null) node.dataset.en = node.textContent;
      node.textContent = t(node.dataset.zh, node.dataset.en);
    }
    for (const node of document.querySelectorAll('[data-zh-label]')) {
      if (node.dataset.enLabel == null) node.dataset.enLabel = node.getAttribute('aria-label') || '';
      node.setAttribute('aria-label', t(node.dataset.zhLabel, node.dataset.enLabel));
    }
    for (const node of document.querySelectorAll('[data-zh-placeholder]')) {
      if (node.dataset.enPlaceholder == null) node.dataset.enPlaceholder = node.getAttribute('placeholder') || '';
      node.setAttribute('placeholder', t(node.dataset.zhPlaceholder, node.dataset.enPlaceholder));
    }
  }

  let switcher = null;
  function setLanguage(value, { save = true } = {}) {
    language = value === 'zh' ? 'zh' : 'en';
    if (save) try { localStorage.setItem(KEY, language); } catch { /* storage blocked */ }
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    translatePage();
    if (switcher) switcher.update();
  }

  // Header switcher, the shared dl-language markup (dl.css): 中文 | English buttons; on narrow screens a 文/A
  // button opens them. It sits last in the header's dl-nav; renderNav() puts it back after redrawing the nav.
  function mountSwitcher() {
    const nav = document.querySelector('.dl-header .dl-nav');
    if (!nav) return;
    const box = document.createElement('div');
    box.className = 'dl-language';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dl-button dl-language-toggle';
    toggle.textContent = '文/A';
    toggle.setAttribute('aria-controls', 'dl-languages');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Language / 语言');
    const group = document.createElement('div');
    group.id = 'dl-languages';
    group.className = 'dl-languages';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Language / 语言');
    const setOpen = (open) => {
      group.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    const buttons = LANGUAGES.map(([value, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.language = value;
      button.lang = value === 'zh' ? 'zh-CN' : 'en';
      button.textContent = label;
      button.addEventListener('click', () => {
        setOpen(false);
        if (value === language) return;
        setLanguage(value);
        window.dispatchEvent(new CustomEvent('files-language-change', { detail: language }));
      });
      group.append(button);
      return button;
    });
    toggle.addEventListener('click', () => setOpen(!group.classList.contains('is-open')));
    document.addEventListener('click', (event) => { if (!box.contains(event.target)) setOpen(false); });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && group.classList.contains('is-open')) { setOpen(false); toggle.focus(); }
    });
    box.append(toggle, group);
    nav.append(box);
    switcher = {
      element: box,
      update() {
        for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.language === language));
      },
    };
  }

  window.FilesI18n = {
    get language() { return language; }, t, locale, translateError, setLanguage, initialLanguage,
    // The switcher element, for renderNav() to keep last in the nav.
    get switcher() { return switcher ? switcher.element : null; },
  };

  const ready = () => { mountSwitcher(); setLanguage(language, { save: false }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
