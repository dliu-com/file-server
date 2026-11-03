import { el, renderNav, t, onLanguageChange } from './common.js';
import { flow, table, more, callout } from './diagram.js';

const SITE = 'https://files.dliu.com';
const mono = (text) => ({ text, className: 'mono' });

// Function keys, kept in sync with /docs/health.md and the /health endpoint (test/health.test.js guards this).
export const GUEST_FUNCTIONS = ['pages', 'shared-ui', 'listing', 'signin', 'api', 'health'];
export const HEALTH_FUNCTIONS = ['storage', 'signin'];

function lead(text) {
  return el('p', { class: 'lead' }, text);
}

// How the site is tested, for people: status.dliu.com as a guest -> public URLs -> /health -> dependencies -> result.
function diagram() {
  return flow({
    title: t('status.dliu.com 如何测试本站', 'How status.dliu.com tests this site'),
    steps: [
      { icon: 'bot', title: t('status.dliu.com', 'status.dliu.com'), text: t('匿名访客，每 15 分钟一次', 'Anonymous guest, every 15 minutes') },
      { icon: 'page', title: t('公开页面和网址', 'Public pages and URLs'), text: t('GET/HEAD，无需登录', 'GET/HEAD, no sign-in') },
      { icon: 'shield', title: '/health', text: t('每个依赖做一次廉价读取', 'One cheap read per dependency') },
      { icon: 's3', title: t('S3 与 Entra', 'S3 and Entra'), text: t('文件存储与登录配置', 'File storage and sign-in config') },
      { icon: 'check', title: t('通过 / 警告 / 失败', 'pass / warn / fail'), tone: 'good' },
    ],
    note: t('status.dliu.com 从不登录，也没有本站的 AWS 权限；它只请求任何人都能访问的网址。',
      'status.dliu.com never signs in and has no AWS access to this site; it only requests URLs anyone can reach.'),
  });
}

function legend() {
  const row = el('div', { class: 'dg-legend' },
    callout('check', t('通过：功能正常。', 'pass: the function works.')),
    callout('clock', t('警告：可用但偏慢或降级。', 'warn: usable but slow or degraded.')),
    callout('shield', t('失败：功能不可用。', 'fail: the function is down.')));
  return row;
}

// One plain-language line per function: what is checked and what "down" means for a visitor.
function functionsList() {
  const rows = [
    [t('页面', 'Pages'), t('文件浏览器和文档页能否打开。若宕机，访客看不到任何文件。', 'Whether the file browser and docs pages load. If down, visitors see no files.')],
    [t('共享外观', 'Shared UI'), t('每个 dliu.com 网站都会加载的共享样式和图标（在 /dliu.com/ 下）能否获取。若宕机，各站外观会损坏。', 'Whether the shared stylesheet and icon under /dliu.com/, which every dliu.com site loads, are served. If down, those sites look broken.')],
    [t('文件清单', 'File list'), t('公开的文件清单能否读取。若宕机，浏览器显示为空。', 'Whether the public file list can be read. If down, the browser shows nothing.')],
    [t('登录', 'Sign-in'), t('“登录”能否把人带到 Microsoft。若宕机，主人无法登录。', 'Whether "Sign in" sends people to Microsoft. If down, the owner cannot sign in.')],
    [t('API', 'API'), t('托管 API 是否拒绝匿名请求（返回 401）。若放行，说明保护失效。', 'Whether the managed API refuses anonymous requests (401). If it lets them in, protection has failed.')],
    [t('健康检查', 'Health check'), t('/health 端点是否报告各依赖（存储、登录配置）为通过。', 'Whether the /health endpoint reports each dependency (storage, sign-in config) as passing.')],
  ];
  const ul = el('ul');
  for (const [name, line] of rows) ul.append(el('li', {}, el('strong', {}, name + ': '), line));
  return ul;
}

function notTested() {
  const ul = el('ul');
  for (const line of [
    t('上传、移动、删除等需要登录的操作——测试从不登录。', 'Signed-in actions such as uploading, moving and deleting — the tests never sign in.'),
    t('某个具体文件是否存在（内容会变化）。', 'Whether any particular file exists (the contents change).'),
    t('主人账号本身或其 Microsoft 密码。', 'The owner account itself or its Microsoft password.'),
  ]) ul.append(el('li', {}, line));
  return ul;
}

// Every technical detail folded in closed <details> blocks.
function guestChecksDetails() {
  const rows = [
    ['pages', 'GET', mono(SITE + '/'), '200', 'text/html', t('含 dl-header', 'contains dl-header')],
    ['shared-ui', 'GET', mono(SITE + '/dliu.com/ui/v1/dl.css'), '200', 'text/css', t('含 --dl-', 'contains --dl-')],
    ['shared-ui', 'GET', mono(SITE + '/dliu.com/favicon.png'), '200', 'image/png', '—'],
    ['listing', 'GET', mono(SITE + '/_data/files.json'), '200', 'application/json', t('JSON 键 files', 'JSON key files')],
    ['signin', 'GET', mono(SITE + '/auth/login'), '302', '—', t('Location 以 https://login.microsoftonline.com/ 开头', 'Location starts with https://login.microsoftonline.com/')],
    ['api', 'GET', mono(SITE + '/api/files'), '401', 'application/json', t('JSON 键 error', 'JSON key error')],
    ['health', 'GET', mono(SITE + '/health'), '200/503', 'application/health+json', t('JSON 键 status', 'JSON key status')],
  ];
  return more(t('访客检查（网址、状态码、标记）', 'Guest checks (URLs, status codes, markers)'),
    table(
      [t('功能', 'Function'), t('方法', 'Method'), t('网址', 'URL'), t('预期状态', 'Expected status'), t('内容类型', 'Content type'), t('标记 / 跳转', 'Marker / redirect')],
      rows,
    ),
    el('p', { class: 'dg-note' }, t('只用 GET 和 HEAD，不带 Cookie 或 Authorization 头，只读。',
      'GET and HEAD only, with no cookies or Authorization header, read only.')));
}

function healthEndpointDetails() {
  const example = `{
  "status": "pass",
  "time": "2026-11-03T23:00:00Z",
  "functions": [
    { "key": "storage", "name": "File storage", "status": "pass" },
    { "key": "signin", "name": "Microsoft sign-in", "status": "pass" }
  ]
}`;
  return more(t('/health 端点', 'The /health endpoint'),
    el('ul', {},
      el('li', {}, el('code', {}, 'GET ' + SITE + '/health'), ' — ',
        t('无需认证；CloudFront 不转发 Cookie、Authorization 头或查询串，处理函数也不读取。',
          'No authentication; CloudFront forwards no cookies, Authorization header or query string, and the handler reads none.')),
      el('li', {}, t('只读：每个依赖一次廉价读取（S3 HeadObject，SSM 参数读取），不做 S3 LIST，不调用付费第三方，5 秒内返回。',
        'Read only: one cheap read per dependency (S3 HeadObject, an SSM parameter read), no S3 LIST, no paid third-party calls, returns within 5 s.')),
      el('li', {}, t('在 CloudFront 缓存 60 秒，所以每分钟最多运行约一次。', 'Cached 60 s at CloudFront, so it runs at most about once a minute.')),
      el('li', {}, el('code', {}, 'Content-Type: application/health+json'), '; ',
        t('status 为 pass 或 warn 时返回 200，为 fail 时返回 503。', '200 when status is pass or warn, 503 when fail.')),
      el('li', {}, t('报告的功能键：', 'Function keys reported: '), el('code', {}, HEALTH_FUNCTIONS.join(', ')), '。',
        t('不泄露任何私有细节（无表名、桶名、计数或堆栈）。', ' No private details (no table, bucket, counts or stack traces).'))),
    el('pre', { class: 'code' }, example));
}

function render() {
  renderNav();
  document.title = `${t('测试', 'Testing')} · ${t('文档', 'Docs')} · ${t('文件', 'Files')} · dliu.com`;
  const root = document.getElementById('health');
  if (!root) return;
  root.replaceChildren(
    el('h2', {}, t('如何测试本站', 'How this site is tested')),
    lead(t('status.dliu.com 以匿名访客的身份每 15 分钟检查一次 files.dliu.com：它只请求公开网址，从不登录。本页说明它检查什么，以及某项“宕机”对访客意味着什么。',
      'status.dliu.com checks files.dliu.com every 15 minutes as an anonymous guest: it only requests public URLs and never signs in. This page explains what it checks and what "down" means for a visitor.')),
    diagram(),
    legend(),
    el('h2', {}, t('检查的功能', 'Functions that are checked')),
    functionsList(),
    el('h2', {}, t('不测试的内容', 'What is not tested')),
    notTested(),
    el('h2', {}, t('技术细节', 'Technical details')),
    guestChecksDetails(),
    healthEndpointDetails(),
    el('p', { class: 'source' },
      el('a', { href: '/docs/health.md' }, t('完整技术版本（Markdown）', 'Full technical version (Markdown)'))),
  );
}

render();
onLanguageChange(render);
