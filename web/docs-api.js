import { el, t } from './common.js';
import { flow, tiers, stats, bars, table } from './diagram.js';

// A link to the machine-readable Markdown, shown under the heading and again at the end.
function machineLink() {
  return el('p', { class: 'source' },
    t('面向机器的版本：', 'Machine-readable version: '),
    el('a', { href: '/docs/api.md' }, '/docs/api.md'));
}

// The parts a managed-API call touches, in the same tiers style as the Architecture tab, using the same
// service colours and icons: the caller -> Microsoft sign-in and the gateway -> the backend checks -> files.
function components() {
  return tiers({
    title: t('一次 API 调用涉及的组成部分', 'What an API call touches'),
    rows: [
      {
        label: t('调用者', 'Caller'), badge: t('令牌', 'Token'), tone: 'untrusted',
        nodes: [
          { icon: 'bot', title: t('工具和 AI 助手', 'Tools and AI agents'), text: t('其他 dliu.com 网站、脚本、代理', 'Other dliu.com sites, scripts, agents') },
        ],
      },
      {
        label: t('登录', 'Sign-in'), badge: 'Microsoft', tone: 'edge', link: t('带令牌的 HTTPS', 'HTTPS with a token'),
        nodes: [
          { icon: 'entra', title: 'auth.dliu.com', text: t('Microsoft 颁发共享 dliu API 的访问令牌', 'Microsoft issues an access token for the shared dliu API') },
          { icon: 'link', title: t('API 网关', 'API Gateway'), text: t('校验签名、颁发者、受众和权限', 'Checks the signature, issuer, audience and permission') },
        ],
      },
      {
        label: t('检查', 'Checks'), badge: t('按需', 'On demand'), tone: 'app', link: t('网关身份，无 Cookie 回退', 'Gateway identity, no cookie fallback'),
        nodes: [
          { icon: 'lambda', title: 'Files Lambda', text: t('确认应用、共享角色和每个端点的权限', 'Confirms the app, the shared role and each endpoint’s permission') },
          { icon: 'shield', title: t('拒绝', 'Refusal'), text: t('角色或权限不符即拒绝', 'Refused unless the role and permission match') },
        ],
      },
      {
        label: t('文件', 'Files'), badge: t('私有', 'Private'), tone: 'private', link: t('读取或修改', 'Read or change'),
        nodes: [
          { icon: 'folder', title: t('文件存储桶', 'File bucket'), text: t('上传、移动、删除，并更新文件清单', 'Upload, move, delete, and update the file list') },
        ],
      },
    ],
    note: t('没有网站 Cookie 回退：令牌必须来自 auth.dliu.com，且账号已获授权。',
      'No website-cookie fallback: the token must come from auth.dliu.com and the account must be assigned.'),
  });
}

// How a program uses the API, step by step, for people.
function callFlow() {
  return flow({
    title: t('程序如何使用 API', 'How a program uses the API'),
    steps: [
      { icon: 'key', title: t('获取令牌', 'Get a token'), text: t('在 auth.dliu.com 用 Microsoft 登录', 'Microsoft sign-in at auth.dliu.com') },
      { icon: 'bot', title: t('调用 Files API', 'Call the Files API'), text: t('带上令牌', 'with the token') },
      { icon: 'shield', title: t('检查令牌', 'Token is checked'), text: t('正确的应用、角色和权限', 'right app, role and permission') },
      { icon: 's3', title: t('列出或修改文件', 'List or change files'), tone: 'good' },
    ],
  });
}

// Big numbers that frame the API at a glance.
function numbers() {
  return stats([
    [t('8 个端点', '8 endpoints'), t('读取、上传、移动、删除', 'read, upload, move, delete'), 'code'],
    [t('3 种权限', '3 permissions'), t('读 / 写 / 删，各自独立', 'read / write / delete, each separate'), 'lock'],
    [t('仅 Microsoft', 'Microsoft only'), t('令牌来自 auth.dliu.com', 'tokens from auth.dliu.com'), 'entra'],
    [t('全部公开', 'All public'), t('上传后任何人都能下载', 'anyone can download once uploaded'), 'users'],
  ]);
}

// What each endpoint lets you do, in plain words, with the permission it needs. No exact request/response formats.
function endpointsTable() {
  const rows = [
    [t('查看你是谁', 'See who you are'), t('读取', 'Read')],
    [t('列出所有文件', 'List every file'), t('读取', 'Read')],
    [t('开始上传或替换', 'Start an upload or replacement'), t('写入', 'Write')],
    [t('获取上传分片的地址', 'Get the upload part URLs'), t('写入', 'Write')],
    [t('完成并发布上传', 'Finish and publish an upload'), t('写入', 'Write')],
    [t('取消未完成的上传', 'Cancel an unfinished upload'), t('写入', 'Write')],
    [t('移动或重命名', 'Move or rename'), t('写入', 'Write')],
    [t('删除', 'Delete'), t('删除', 'Delete')],
  ];
  return table([t('能做什么', 'What you can do'), t('需要的权限', 'Permission needed')], rows);
}

// A simple chart: the 8 endpoints grouped by kind.
function kindsChart() {
  return bars({
    items: [
      [t('读取', 'Read'), 2, 'good'],
      [t('写入', 'Write'), 5, 'warn'],
      [t('删除', 'Delete'), 1, 'bad'],
    ],
    note: t('8 个端点按类别划分；每个端点都需要它自己的权限。', 'The 8 endpoints by kind; each one needs its own permission.'),
  });
}

function signIn() {
  const ul = el('ul');
  for (const line of [
    t('令牌只来自 auth.dliu.com 的 Microsoft 登录。', 'Tokens come only from Microsoft sign-in at auth.dliu.com.'),
    t('只有主人被授予共享的“dliu API 用户”角色；其他能登录网站的用户无法调用 API。', 'Only the owner has the shared “dliu API user” role; other users who can sign in to the website cannot call the API.'),
    t('网站 Cookie 在此无效；每个端点仍需各自的权限。', 'Website cookies do not work here; each endpoint still needs its own permission.'),
    t('每个文件都是公开的：没有私有、草稿或不公开状态。', 'Every file is public: there is no private, draft or unlisted state.'),
  ]) ul.append(el('li', {}, line));
  return ul;
}

function paths() {
  const ul = el('ul');
  for (const line of [
    t('保留名称 _app、_data、api、auth 和 index.html 无法通过 API 写入。', 'The reserved names _app, _data, api, auth and index.html cannot be written through the API.'),
    t('共享文件夹 dliu.com 对网站只读，只能通过这个托管 API 修改。', 'The shared dliu.com folder is read-only to the website and can be changed only through this managed API.'),
  ]) ul.append(el('li', {}, line));
  return ul;
}

// The API tab's body. The heading and lead come from docs.html; this appends the rest to the article.
// High-level only (which endpoints exist and what each is for): the Markdown file carries the exact formats.
export function api(root) {
  root.append(
    machineLink(),
    components(),
    numbers(),
    callFlow(),
    el('h2', {}, t('能做什么', 'What you can do')),
    endpointsTable(),
    el('h2', {}, t('端点类别', 'Endpoints by kind')),
    kindsChart(),
    el('h2', {}, t('登录方式', 'How sign-in works')),
    signIn(),
    el('h2', {}, t('保留和共享路径', 'Reserved and shared paths')),
    paths(),
    el('p', { class: 'source' },
      el('a', { href: '/docs/api.md' }, t('面向机器的完整技术参考（Markdown）', 'Full technical reference for machines (Markdown)'))),
  );
}
