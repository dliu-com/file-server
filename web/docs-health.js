import { el, t } from './common.js';
import { flow, stats, bars, table, callout } from './diagram.js';

// Function keys, kept in sync with /docs/health.md and the /health endpoint (test/health.test.js guards this).
export const GUEST_FUNCTIONS = ['pages', 'shared-ui', 'listing', 'signin', 'api', 'health'];
export const HEALTH_FUNCTIONS = ['storage', 'signin'];

// How the site is tested, for people: status.dliu.com as a guest -> public pages -> self-check -> result.
function diagram() {
  return flow({
    title: t('status.dliu.com 如何测试本站', 'How status.dliu.com tests this site'),
    steps: [
      { icon: 'bot', title: t('status.dliu.com', 'status.dliu.com'), text: t('匿名访客，每 15 分钟一次', 'Anonymous guest, every 15 minutes') },
      { icon: 'page', title: t('公开页面和功能', 'Public pages and functions'), text: t('只看，不登录', 'Looks only, never signs in') },
      { icon: 'shield', title: t('自检', 'Self-check'), text: t('本站检查自己的存储和登录配置', 'the site checks its own storage and sign-in config') },
      { icon: 'check', title: t('通过 / 警告 / 失败', 'pass / warn / fail'), tone: 'good' },
    ],
    note: t('status.dliu.com 从不登录，也没有本站的 AWS 权限；它只请求任何人都能访问的页面。',
      'status.dliu.com never signs in and has no AWS access to this site; it only requests pages anyone can reach.'),
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
      t('以访客身份打开网站，确认能加载', 'Open the site as a guest and check it loads'), t('访客看不到任何文件', 'Visitors see no files')],
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
    diagram(),
    numbers(),
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
