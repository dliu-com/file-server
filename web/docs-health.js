import { el, t } from './common.js';
import { flow, tiers, stats, bars, table, callout } from './diagram.js';

// Function keys, kept in sync with /docs/health.md and the /health endpoint (test/health.test.js guards this).
export const GUEST_FUNCTIONS = ['pages', 'shared-ui', 'listing', 'signin', 'api', 'health'];
export const HEALTH_FUNCTIONS = ['storage', 'signin'];

// A link to the machine-readable Markdown, shown under the heading and again at the end.
function machineLink() {
  return el('p', { class: 'source' },
    t('面向机器的版本：', 'Machine-readable version: '),
    el('a', { href: '/docs/health.md' }, '/docs/health.md'));
}

// A link to this site's live status page on status.dliu.com, shown near the top.
function statusLink() {
  return el('p', { class: 'source' },
    t('实时状态：', 'Live status: '),
    el('a', { href: 'https://status.dliu.com/site/files' }, 'status.dliu.com/site/files'));
}

// The components involved in a test, in the same tiers style as the Architecture tab, using the same
// service colours and icons. status.dliu.com (guest) -> the public edge -> the backend -> private storage.
function components() {
  return tiers({
    title: t('测试涉及的组成部分', 'What a test touches'),
    rows: [
      {
        label: t('测试者', 'Testers'), badge: t('访客', 'Guest'), tone: 'untrusted',
        nodes: [
          { icon: 'bot', title: 'status.dliu.com', text: t('匿名访客，爱尔兰、弗吉尼亚、东京每 15 分钟，中国每小时', 'Anonymous guest; Ireland, Virginia, Tokyo every 15 min, China hourly') },
        ],
      },
      {
        label: t('测试的页面和端点', 'Pages and endpoints tested'), badge: t('边缘', 'Edge'), tone: 'edge',
        link: t('HTTPS，无需登录', 'HTTPS, no sign-in'),
        nodes: [
          { icon: 'cloudfront', title: 'CloudFront', text: t('分发页面、文件清单和共享外观', 'Serves the pages, the file list and the shared look') },
          { icon: 'page', title: t('公开页面', 'Public pages'), text: t('首页、文件夹页、/docs', 'Home, folder pages, /docs') },
          { icon: 'code', title: t('文件清单和共享外观', 'File list and shared UI'), text: t('每个 dliu.com 网站都会加载的列表和样式', 'The list and the look every dliu.com site loads') },
        ],
      },
      {
        label: t('/health 和后端', '/health and the backend'), badge: t('按需', 'On demand'), tone: 'app',
        link: t('只读检查', 'Read-only checks'),
        nodes: [
          { icon: 'lambda', title: t('/health 自检', '/health self-check'), text: t('本站报告存储和登录配置是否正常', 'The site reports whether storage and sign-in config are healthy') },
          { icon: 'entra', title: t('登录', 'Sign-in'), text: t('“登录”把主人带到 Microsoft', 'The sign-in link sends the owner to Microsoft') },
          { icon: 'shield', title: t('API 拒绝', 'API refusal'), text: t('未登录的调用被拒绝', 'Calls without sign-in are refused') },
        ],
      },
      {
        label: t('它读取的存储', 'Storage it reads'), badge: t('私有', 'Private'), tone: 'private',
        link: t('/health 每个依赖一次廉价读取', '/health reads each once, cheaply'),
        nodes: [
          { icon: 'folder', title: t('文件存储桶', 'File bucket'), text: t('文件、网站和文件清单', 'The files, the site and the file list') },
          { icon: 'ssm', title: 'Parameter Store', text: t('登录配置', 'Sign-in configuration') },
        ],
      },
    ],
    note: t('status.dliu.com 从不登录，也没有本站的 AWS 权限；它只请求任何人都能访问的页面。',
      'status.dliu.com never signs in and has no AWS access to this site; it only requests pages anyone can reach.'),
  });
}

// How a test run goes, step by step, for people.
function runFlow() {
  return flow({
    title: t('一次测试的过程', 'How a test run goes'),
    steps: [
      { icon: 'bot', title: t('status.dliu.com', 'status.dliu.com'), text: t('匿名访客，每 15 分钟一次', 'Anonymous guest, every 15 minutes') },
      { icon: 'page', title: t('公开页面和功能', 'Public pages and functions'), text: t('只看，不登录', 'Looks only, never signs in') },
      { icon: 'shield', title: t('自检', 'Self-check'), text: t('本站检查自己的存储和登录配置', 'the site checks its own storage and sign-in config') },
      { icon: 'check', title: t('通过 / 警告 / 失败', 'pass / warn / fail'), tone: 'good' },
    ],
  });
}

function legend() {
  return el('div', { class: 'dg-legend' },
    callout('check', t('通过：功能正常。', 'pass: the function works.')),
    callout('clock', t('警告：可用但偏慢或降级。', 'warn: usable but slow or degraded.')),
    callout('shield', t('失败：功能不可用。', 'fail: the function is down.')));
}

// Big numbers: how much is tested and how often.
function numbers() {
  return stats([
    [t('6 项功能', '6 functions'), t('每次运行都检查', 'checked on every run'), 'eye'],
    [t('7 项检查', '7 checks'), t('公开页面，只读', 'public pages, read only'), 'check'],
    [t('每 15 分钟', 'Every 15 min'), t('全天候', 'around the clock'), 'clock'],
    [t('0 次登录', '0 sign-ins'), t('全部以访客身份', 'all done as a guest'), 'users'],
  ]);
}

// One plain-language row per function: what it does, how it's tested, and what a visitor notices if it breaks.
function functionsTable() {
  const rows = [
    [t('页面', 'Pages'), t('显示文件浏览器和文档页', 'Shows the file browser and docs pages'),
      t('以访客身份打开网站，确认能加载并列出文件；每次发布前还会检查页面脚本能正常解析运行', 'Open the site as a guest and confirm it loads and lists files; before each release the page scripts are also checked so they parse and run'), t('访客看到空白或卡住的页面', 'Visitors see a blank or stuck page')],
    [t('共享外观', 'Shared UI'), t('提供每个 dliu.com 网站都会加载的样式和图标', 'Serves the look and icon every dliu.com site loads'),
      t('获取共享样式表和图标', 'Fetch the shared stylesheet and icon'), t('其他网站外观损坏', 'Other sites look broken')],
    [t('文件清单', 'File list'), t('公开的文件列表', 'The public list of files'),
      t('读取公开的文件清单', 'Read the public file list'), t('浏览器显示为空', 'The browser shows nothing')],
    [t('登录', 'Sign-in'), t('把主人带到 Microsoft 登录', 'Sends the owner to Microsoft to sign in'),
      t('跟随“登录”链接', 'Follow the sign-in link'), t('主人无法登录', 'The owner cannot sign in')],
    [t('API', 'API'), t('拒绝未登录的调用者', 'Refuses callers who are not signed in'),
      t('不登录就调用托管 API，应被拒绝', 'Call the managed API without signing in; expect a refusal'), t('保护已失效', 'Protection has failed')],
    [t('健康检查', 'Health check'), t('本站对存储和登录配置的自检', 'The site’s self-check of its storage and sign-in config'),
      t('读取健康检查页', 'Read the health page'), t('无法判断存储或登录是否正常', 'We cannot tell if storage or sign-in is healthy')],
  ];
  return table(
    [t('功能', 'Function'), t('作用', 'What it does'), t('如何检查', 'How it is checked'), t('若损坏', 'If it broke')],
    rows,
  );
}

// A simple chart: how many checks each function has (7 in total).
function checksChart() {
  return bars({
    items: [
      [t('页面', 'Pages'), 1, 'good'],
      [t('共享外观', 'Shared UI'), 2, 'good'],
      [t('文件清单', 'File list'), 1, 'good'],
      [t('登录', 'Sign-in'), 1, 'good'],
      ['API', 1, 'good'],
      [t('健康检查', 'Health'), 1, 'good'],
    ],
    note: t('共 7 项检查，全部是公开、只读的请求。', '7 checks in total, all public, read-only requests.'),
  });
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

// The Testing tab's body. The heading and lead come from docs.html; this appends the rest to the article.
// No exact technical details (status codes, headers, JSON, code or <details>): the Markdown file carries those.
export function health(root) {
  root.append(
    machineLink(),
    statusLink(),
    components(),
    numbers(),
    runFlow(),
    legend(),
    el('h2', {}, t('检查的功能', 'Functions that are checked')),
    functionsTable(),
    el('h2', {}, t('每项功能的检查数', 'Checks per function')),
    checksChart(),
    el('h2', {}, t('不测试的内容', 'What is not tested')),
    notTested(),
    el('p', { class: 'source' },
      el('a', { href: '/docs/health.md' }, t('面向机器的技术版本（Markdown）', 'Technical version for machines (Markdown)'))),
  );
}
