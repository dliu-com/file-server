import { renderNav, t, onLanguageChange } from './common.js';
import { flow, tiers, stats, table, callout, more } from './diagram.js';
import { health } from './docs-health.js';
import { api } from './docs-api.js';

const TABS = ['architecture', 'cost', 'security', 'health', 'api'];
const TITLES = {
  architecture: () => t('架构', 'Architecture'),
  cost: () => t('运行成本', 'Cost'),
  security: () => t('安全', 'Security'),
  health: () => t('健康', 'Health'),
  api: () => t('API', 'API'),
};
const num = (text) => ({ text, className: 'num' });
const mono = (text) => ({ text, className: 'mono' });

function writer(root) {
  return (tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    root.append(node);
    return node;
  };
}

function list(items) {
  const ul = document.createElement('ul');
  for (const text of items) {
    const li = document.createElement('li');
    li.textContent = text;
    ul.append(li);
  }
  return ul;
}

function linkParagraph(root, before, href, text, after = '') {
  const p = document.createElement('p');
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  p.append(before, a, after);
  root.append(p);
}

function source(root, text) {
  const footer = document.createElement('p');
  footer.className = 'source';
  footer.textContent = text;
  root.append(footer);
}

// ---------------------------------------------------------------- Architecture
function architecture(root) {
  const add = writer(root);

  root.append(stats([
    [t('0 台服务器', '0 servers'), t('没人使用时什么都不运行', 'nothing runs while nobody is using the site'), 'power'],
    [t('2 个 Lambda', '2 Lambdas'), t('登录与所有者改动；清除已改动的文件', 'sign-in and owner changes; clearing changed files'), 'lambda'],
    [t('1 个 S3 存储桶', '1 S3 bucket'), t('文件、网站和文件清单', 'the files, the site and the file list'), 's3'],
    [t('1 个 CloudFront', '1 CloudFront'), t('分发文件、页面和网站 API', 'serves files, pages and the website API'), 'cloudfront'],
  ]));

  root.append(tiers({
    title: t('组成部分', 'Components'),
    rows: [
      {
        label: t('人', 'People'), badge: t('浏览器', 'Browser'), tone: 'untrusted',
        nodes: [
          { icon: 'users', title: t('访客', 'Visitors'), text: t('浏览文件夹、下载文件；无需账号', 'Browse folders and download files; no account needed') },
          { icon: 'code', title: t('其他 dliu.com 网站', 'Other dliu.com sites'), text: t('链接或嵌入文件，并从 /dliu.com/ 加载共享外观', 'Link to or embed files, and load the shared look from /dliu.com/') },
          { icon: 'user', title: t('所有者', 'Owner'), text: t('用 Microsoft 登录以上传、移动和删除', 'Signs in with Microsoft to upload, move and delete') },
          { icon: 'bot', title: t('工具和 AI 助手', 'Tools and AI agents'), text: t('可选：用 Microsoft 颁发的令牌管理文件', 'Optional: manage files with Microsoft-issued tokens') },
        ],
      },
      {
        label: 'CloudFront', badge: t('边缘', 'Edge'), tone: 'edge', link: t('HTTPS，files.dliu.com', 'HTTPS, files.dliu.com'),
        nodes: [
          { icon: 'cloudfront', title: t('分发', 'Distribution'), text: t('TLS 1.2+、HTTP/2 和 HTTP/3、所有边缘节点、安全响应头，在边缘保留文件一天', 'TLS 1.2+, HTTP/2 and HTTP/3, all edge locations, security headers, keeps files at the edge for a day') },
          { icon: 'page', title: t('页面函数', 'Pages function'), text: t('以 / 结尾的文件夹网址显示文件浏览器；/docs 就是本页', 'Folder URLs ending in / show the file browser; /docs is this page') },
          { icon: 'cookie', title: t('访客 ID 函数', 'Visitor ID function'), text: t('与流量监控共享，用于统计访问量', 'Shared with the traffic monitor for visit counts') },
        ],
      },
      {
        label: 'API', badge: t('按需', 'On demand'), tone: 'app', link: t('仅 /api/* 和 /auth/*，由 CloudFront 签名（OAC）', '/api/* and /auth/* only, signed by CloudFront (OAC)'),
        nodes: [
          { icon: 'lambda', title: 'API Lambda', text: t('ARM 上的 Node.js 22，256 MB；登录、上传地址、移动和删除', 'Node.js 22 on ARM, 256 MB; sign-in, upload URLs, moves and deletes') },
          { icon: 'entra', title: 'Microsoft Entra ID', text: t('所有者登录（OpenID Connect）', 'Owner sign-in (OpenID Connect)') },
          { icon: 'link', title: t('托管 API（可选）', 'Managed API (optional)'), text: t('API Gateway 校验 Microsoft 令牌，再调用同一个 Lambda', 'API Gateway checks Microsoft tokens, then calls the same Lambda') },
        ],
      },
      {
        label: t('AWS 账户', 'AWS account'), badge: t('私有', 'Private'), tone: 'private', link: t('只通过 CloudFront 读取；由 Lambda 和预签名上传写入', 'read via CloudFront only; written by the Lambda and presigned uploads'),
        nodes: [
          { icon: 'folder', title: t('文件存储桶', 'File bucket'), text: t('每个文件在各自的路径，网站在 _app/ 下，清单在 _data/files.json', 'Every file at its own path, the site under _app/ and the list in _data/files.json') },
          { icon: 'bell', title: t('清除已改动的文件', 'Clear changed files'), text: t('S3 改动事件 → EventBridge → 一个小 Lambda 清除 CloudFront', 'S3 change events → EventBridge → a small Lambda that clears CloudFront') },
          { icon: 'ssm', title: 'Parameter Store', text: t('Entra 租户、客户端 ID 和加密的客户端密钥', 'Entra tenant, client ID and encrypted client secret') },
        ],
      },
    ],
    note: t('访客从不调用 Lambda：文件夹页面、文件清单和文件本身都是普通文件，由 CloudFront 从 S3 分发。', 'Visitors never call the Lambda: the folder pages, the file list and the files themselves are plain files that CloudFront serves from S3.'),
  }));

  add('h2', t('下载一个文件', 'Downloading a file'));
  root.append(flow({
    title: t('访客的浏览器会加载什么', 'What a visitor’s browser loads'),
    numbered: true,
    steps: [
      { icon: 'page', title: t('文件夹页面', 'Folder page'), text: t('/photos/ 从 _app/ 显示文件浏览器', '/photos/ shows the file browser from _app/') },
      { icon: 'code', title: t('文件清单', 'File list'), text: t('/_data/files.json：每个文件及其大小、类型和日期', '/_data/files.json: every file with its size, type and date') },
      { icon: 'folder', title: t('文件', 'File'), text: t('/photos/beach.jpg 经 CloudFront 从 S3 直接按字节范围取回', '/photos/beach.jpg straight from S3 through CloudFront, in byte ranges'), tone: 'good' },
    ],
    note: t('文件的地址就是它的路径，所以只要文件不移动，链接永远不变。浏览器保留文件 5 分钟，CloudFront 保留一天；页面和清单每次加载都会重新检查，所以改动立即可见。', 'A file’s address is simply its path, so links never change while the file stays where it is. Browsers keep a file for 5 minutes and CloudFront for a day; the page and the list are checked on every load, so changes appear at once.'),
  }));

  add('h2', t('上传一个文件', 'Uploading a file'));
  root.append(flow({
    title: t('文件从浏览器直接传到 S3', 'The file goes straight from the browser to S3'),
    numbered: true,
    steps: [
      { icon: 'entra', title: t('登录', 'Sign in'), text: t('Microsoft 登录；Lambda 设置会话 Cookie', 'Microsoft sign-in; the Lambda sets a session cookie') },
      { icon: 'upload', title: t('选择文件', 'Choose files'), text: t('把文件或文件夹拖到页面上，或手动选择', 'Drop files or folders on the page, or pick them') },
      { icon: 'key', title: t('上传地址', 'Upload URLs'), text: t('Lambda 发起 S3 分段上传，并为每一段签发一个地址', 'The Lambda starts an S3 multipart upload and signs one URL per part') },
      { icon: 's3', title: t('分段传到 S3', 'Parts to S3'), text: t('每段 16 MiB 以上，一次 4 段，直接 PUT 到 S3', 'Parts of 16 MiB or more, 4 at a time, PUT directly to S3') },
      { icon: 'check', title: t('完成', 'Done'), text: t('Lambda 完成上传并把文件加入清单', 'The Lambda completes the upload and adds the file to the list'), tone: 'good' },
    ],
    note: t('Lambda 从不经手文件字节，所以最大 50 GiB 的文件也不需要大内存或长时间运行的函数。失败的分段会重试；放弃的上传由 S3 在 2 天后清除。', 'The Lambda never handles file bytes, so files up to 50 GiB do not need a large or long-running function. Failed parts are retried; an abandoned upload is removed by S3 after 2 days.'),
  }));

  add('h2', t('移动、重命名和删除', 'Moving, renaming and deleting'));
  add('p', t('移动或重命名会在 S3 内部复制文件（大文件用 512 MiB 的分段并行复制），再删除旧文件，所以什么都不经过浏览器。一次移动最多处理 200 个文件或 50 GiB。删除会移除文件及其在清单中的条目。存储桶保留旧版本 30 天，所以被删除或替换的文件所有者仍可在 AWS 控制台恢复。', 'Moving or renaming copies the file inside S3 (large files in parallel 512 MiB parts) and then deletes the old one, so nothing passes through the browser. One move handles up to 200 files or 50 GiB. Deleting removes the file and its entry in the list. The bucket keeps old versions for 30 days, so a deleted or replaced file can still be restored by the owner in the AWS console.'));

  add('h2', t('网址及其来源', 'URLs and where they come from'));
  root.append(table([t('路径', 'Path'), t('来源', 'Served from'), t('缓存', 'Caching')], [
    [mono(t('/ 和 /<文件夹>/', '/ and /<folder>/')), t('文件浏览器（_app/index.html），经页面函数', 'The file browser (_app/index.html), via the pages function'), t('每次加载都检查', 'Checked on every load')],
    [mono('/<path>'), t('存储桶中该路径的文件', 'The file at that path in the bucket'), t('浏览器 5 分钟，边缘 1 天', '5 minutes in browsers, 1 day at the edge')],
    [mono('/_app/*'), t('网站的页面、脚本和样式', 'The site’s pages, scripts and styles'), t('每次加载都检查', 'Checked on every load')],
    [mono('/_data/files.json'), t('文件清单', 'The file list'), t('每次加载都检查', 'Checked on every load')],
    [mono('/dliu.com/*'), t('所有 dliu.com 网站的共享外观（经托管 API 发布）', 'The shared look for all dliu.com sites (published through the managed API)'), t('当作文件', 'As a file')],
    [mono('/docs'), t('本文档页面', 'This docs page'), t('每次加载都检查', 'Checked on every load')],
    [mono('/api/* /auth/*'), t('经函数 URL 的 Lambda', 'The Lambda, through its function URL'), t('从不缓存', 'Never cached')],
  ]));
  add('p', t('顶层名称 _app、_data、api 和 auth，文件 index.html，以及确切路径 docs、docs/api 和 docs/api.md 属于网站，所以文件不能上传到那里。名为 docs/ 的文件夹没问题。顶层 dliu.com 存放每个 dliu.com 网站都加载的共享文件：对文件网站只读（登录的网站会话不能上传、替换、移动或删除），只能通过托管 API（auth.dliu.com 令牌）更改，这样共享清单才能保持准确。', 'The top-level names _app, _data, api and auth, the file index.html and the exact paths docs, docs/api and docs/api.md belong to the site, so files cannot be uploaded there. A folder called docs/ is fine. The top-level dliu.com holds the files every dliu.com site loads: it is read-only to the Files website (signed-in website sessions cannot upload, replace, move or delete it) and can only be changed through the managed API (an auth.dliu.com token), which keeps the shared listing accurate.'), 'dg-note');

  add('h2', t('清除 CDN', 'Clearing the CDN'));
  add('p', t('CloudFront 把每个文件保留一天，这样远离爱尔兰的访客也能从就近的边缘取到。但只要文件在 S3 中被替换或删除——无论来自本站、API、S3 控制台还是脚本——S3 都会通知 EventBridge，一个小 Lambda 会在约一分钟内从 CloudFront 清除该文件。新文件会被跳过，因为 CloudFront 本来就没有它。本站上做的移动和删除也会立即清除旧路径。', 'CloudFront keeps each file for a day so visitors far from Ireland get it from a nearby edge. Whenever a file is replaced or deleted in S3, however that happens (this site, the API, the S3 console or a script), S3 tells EventBridge and a small Lambda clears that file from CloudFront within about a minute. New files are skipped, because CloudFront never had them. Moves and deletes made on this site also clear the old paths straight away.'));
  add('p', t('每条清除的路径每月前 1,000 条免费，由所有 dliu.com 网站共享；之后每条 $0.005。', 'Each cleared path is free for the first 1,000 a month, shared by all dliu.com sites; then $0.005 per path.'), 'dg-note');

  add('h2', t('文件清单', 'The file list'));
  add('p', t('没有数据库。_data/files.json 是每个文件的清单，也是唯一真相来源。Lambda 用条件写入更新它，所以同一时刻的两次改动不会互相覆盖。文件夹页面读取它，一次显示一个文件夹。', 'There is no database. _data/files.json is the list of every file and the source of truth. The Lambda updates it with conditional writes, so two changes at the same moment cannot overwrite each other. The folder pages read it and show one folder at a time.'));

  add('h2', t('登录', 'Signing in'));
  root.append(flow({
    title: t('Microsoft Entra ID，带 PKCE 的 OpenID Connect', 'Microsoft Entra ID, OpenID Connect with PKCE'),
    numbered: true,
    steps: [
      { icon: 'user', title: t('登录', 'Sign in'), text: t('/auth/login 把 state、nonce 和 PKCE 验证码存入一个短期签名 Cookie', '/auth/login stores state, nonce and PKCE verifier in a short signed cookie') },
      { icon: 'entra', title: 'Microsoft', text: t('单租户应用注册；用户在那里登录', 'Single-tenant app registration; the user signs in there') },
      { icon: 'lambda', title: t('回调', 'Callback'), text: t('交换授权码；校验 ID 令牌的签名、颁发者、租户、受众、nonce 和 @dliu.com 邮箱', 'Code exchanged; ID token signature, issuer, tenant, audience, nonce and @dliu.com email checked') },
      { icon: 'cookie', title: t('会话', 'Session'), text: t('签名的 __Host- Cookie，有效 12 小时', 'Signed __Host- cookie for 12 hours'), tone: 'good' },
    ],
  }));

  add('h2', t('Microsoft 令牌 API 访问（可选）', 'Microsoft-issued API access (optional)'));
  add('p', t('一个独立的 API Gateway HTTP API 接受共享 dliu API 的 Microsoft 访问令牌，让工具、脚本和 AI 助手能管理文件。它调用同一个 Lambda，对网站登录或下载没有任何影响。', 'A separate API Gateway HTTP API accepts Microsoft access tokens for the shared dliu API, so tools, scripts and AI agents can manage files. It calls the same Lambda and changes nothing for website sign-in or downloads.'));
  root.append(table([t('权限', 'Permission'), t('操作', 'Operations')], [
    [mono('files.read'), t('读取 API 身份并列出文件', 'Read API identity and list files')],
    [mono('files.write'), t('发起、上传、完成或中止上传；移动和重命名', 'Start, upload, complete or abort uploads; move and rename')],
    [mono('files.delete'), t('删除文件和文件夹', 'Delete files and folders')],
  ]));
  add('p', t('API Gateway 校验令牌的签名、颁发者、受众、有效期和路由所需的权限。Lambda 还要求是经批准的客户端，以及共享 dliu API 用户角色（api.access），只有被分配的用户才有。files.write 不包含删除。', 'API Gateway checks the token’s signature, issuer, audience, expiry and the route’s permission. The Lambda also requires the approved client and the shared dliu API user role (api.access), which only assigned users have. files.write does not include delete.'));
  linkParagraph(root, t('路由、请求体和上传流程见 ', 'Routes, request bodies and the upload workflow are in the '), '/docs#api', t('API 参考', 'API reference'), t('。', '.'));

  root.append(more(t('构建、部署和测试', 'Build, deploy and test'),
    list([
      t('一个 AWS CDK 堆栈（TypeScript）FileServer，位于 eu-west-1；证书按 CloudFront 要求放在 us-east-1。make deploy 会测试、构建并部署它。', 'One AWS CDK stack (TypeScript), FileServer, in eu-west-1; the certificate is in us-east-1 as CloudFront requires. make deploy tests, builds and deploys it.'),
      t('网站文件由堆栈本身上传（BucketDeployment），所以一次部署会同时更新页面和基础设施。页面每次加载都会检查，所以部署会立即生效，无需清除 CloudFront。', 'The site’s files are uploaded by the stack itself (BucketDeployment), so a deploy updates pages and infrastructure together. The pages are checked on every load, so a deploy shows up at once without clearing CloudFront.'),
      t('Entra ID 和客户端密钥用 make set-secrets 输入一次，存入 Parameter Store，不在仓库里。', 'The Entra IDs and client secret are entered once with make set-secrets and stored in Parameter Store, not in the repository.'),
      t('单元测试（Jest）用假 S3 覆盖 API，用 AWS SDK 签名器校验预签名地址，还覆盖 CDN 清除、页面函数、共享外观和合成后的堆栈。', 'Unit tests (Jest) cover the API with a fake S3, the presigned URLs against the AWS SDK signer, CDN clearing, the pages function, the shared look and the synthesised stack.'),
      t('访问量由中央流量监控（traffic.dliu.com）根据 CloudFront 日志统计；本站不运行任何分析代码。', 'Visits are counted by the central traffic monitor (traffic.dliu.com) from CloudFront’s logs; this site runs no analytics code.'),
    ])));

  source(root, t('源码：dliu-com/file-server（lib/file-server-stack.ts、lambda/api/、functions/、web/）。', 'Source: dliu-com/file-server (lib/file-server-stack.ts, lambda/api/, functions/, web/).'));
}

// ---------------------------------------------------------------- Cost
function cost(root) {
  const add = writer(root);

  root.append(stats([
    ['$0', t('每月固定费用', 'fixed monthly fee'), 'budget'],
    ['≈ $0.023', t('每 GB 文件每月，随文件闲置下降', 'per GB of files per month, falling as files go unused'), 's3'],
    [t('1 TB 免费', '1 TB free'), t('每月的 CloudFront 分发流量', 'of CloudFront delivery each month'), 'cloudfront'],
    ['≈ $0.085', t('免费额度之外每下载 1 GB', 'per GB downloaded beyond the free tier'), 'folder'],
  ]));

  add('h2', t('各部分花费', 'What each part costs'));
  add('p', t('价格为 eu-west-1（爱尔兰）的目录价。免费额度按 AWS 账户计算，所以与其他 dliu.com 网站共享。', 'Prices are list prices for eu-west-1 (Ireland). Free tiers are per AWS account, so they are shared with the other dliu.com sites.'));
  root.append(table([t('部分', 'Part'), t('如何计费', 'How it is billed'), t('闲置月份', 'Idle month')], [
    [t('S3 文件存储', 'S3 file storage'), t('Intelligent-Tiering：每 GB-月 $0.023；30 天无下载后 $0.0125；90 天后 $0.004。超过 128 KB 的文件每 1,000 个 $0.0025 作监控；无取回费', 'Intelligent-Tiering: $0.023 per GB-month; $0.0125 after 30 days without downloads; $0.004 after 90 days. $0.0025 per 1,000 files over 128 KB for monitoring; no retrieval fees'), num('≈ $0.023 / GB')],
    [t('旧版本', 'Old versions'), t('被替换或删除的文件保留 30 天以便恢复，然后移除', 'A replaced or deleted file is kept for 30 days so it can be restored, then removed'), num(t('仅存储', 'Storage only'))],
    [t('S3 网站文件和清单', 'S3 site files and the list'), t('S3 标准存储中的几百 KB', 'A few hundred KB in S3 Standard'), num('< $0.01')],
    [t('S3 请求', 'S3 requests'), t('每 1,000 次 PUT $0.005（上传时每 16 MiB 分段一次）；CloudFront 缓存未命中时每 1,000 次 GET $0.0004', '$0.005 per 1,000 PUTs (one per 16 MiB part on upload); $0.0004 per 1,000 GETs on CloudFront cache misses'), num('$0')],
    ['CloudFront', t('每月免费：1 TB 流出、1,000 万次请求、200 万次函数运行。之后每 GB $0.085（欧洲和北美），每 1 万次请求约 $0.01', 'Free each month: 1 TB out, 10 million requests, 2 million function runs. Then $0.085 per GB (Europe and North America) and about $0.01 per 10,000 requests'), num('$0')],
    ['CloudFront Functions', t('页面和访客 ID 函数：免费 200 万次后每百万次 $0.10', 'Pages and visitor ID functions: $0.10 per million runs after the free 2 million'), num('$0')],
    [t('Lambda', 'Lambdas'), t('每百万次调用 $0.20，每 GB-秒 $0.0000133（ARM）。每月免费：100 万次调用和 40 万 GB-秒。访客从不调用它们', '$0.20 per million calls and $0.0000133 per GB-second (ARM). Free each month: 1 million calls and 400,000 GB-seconds. Visitors never call them'), num('$0')],
    ['EventBridge', t('默认事件总线上的 S3 改动事件免费', 'S3 change events on the default event bus are free'), num('$0')],
    [t('CDN 清除', 'CDN clearing'), t('每个被替换或删除的文件约一两条路径；每月前 1,000 条免费，之后每条 $0.005', 'About one or two paths per replaced or deleted file; the first 1,000 paths a month are free, then $0.005 per path'), num('$0')],
    [t('API Gateway HTTP API（可选）', 'API Gateway HTTP API (optional)'), t('每百万次托管 API 调用约 $1；无固定月费。下载不使用它', 'About $1 per million managed API calls; no fixed monthly fee. Downloads do not use it'), num('$0')],
    [t('Parameter Store 和 KMS', 'Parameter Store and KMS'), t('标准参数免费；AWS 托管的 aws/ssm 密钥每月有 20,000 次免费请求', 'Standard parameters are free; the AWS-managed aws/ssm key has 20,000 free requests a month'), num('$0')],
    ['CloudWatch Logs', t('Lambda 日志保留三个月；每 GB $0.57，每月几 KB', 'Lambda logs kept three months; $0.57 per GB, a few KB a month'), num('$0')],
    [t('证书（ACM）和 DNS', 'Certificate (ACM) and DNS'), t('公共证书免费；指向 CloudFront 的别名记录在现有 dliu.com 区域中免费解析', 'Public certificates are free; alias records to CloudFront answer free in the existing dliu.com zone'), num('$0')],
    [t('流量日志', 'Traffic logs'), t('计入流量监控：每 GB 日志行 $0.25', 'Billed to the traffic monitor: $0.25 per GB of log lines'), num('< $0.01')],
  ]));
  root.append(callout('power', t('没有 EC2、容器、负载均衡器、NAT 网关、数据库或 WAF，所以没有任何东西仅仅因为存在就花钱。没人下载时，账单就是文件的存储费。', 'There is no EC2, container, load balancer, NAT gateway, database or WAF, so nothing costs money just by existing. With nobody downloading, the bill is the storage of the files.')));

  add('h2', t('举例', 'Examples'));
  root.append(table([t('情况', 'Situation'), t('估算', 'Estimate')], [
    [t('存 10 GB 文件，近期有使用', 'Storing 10 GB of files, recently used'), num(t('≈ 每月 $0.23', '≈ $0.23 / month'))],
    [t('同样 10 GB，30 天无下载后', 'The same 10 GB after 30 days without downloads'), num(t('≈ 每月 $0.13', '≈ $0.13 / month'))],
    [t('同样 10 GB，90 天无下载后', 'The same 10 GB after 90 days without downloads'), num(t('≈ 每月 $0.04', '≈ $0.04 / month'))],
    [t('上传一个 1 GB 文件（64 段，几次 Lambda 调用）', 'Uploading a 1 GB file (64 parts, a few Lambda calls)'), num('≈ $0.0004')],
    [t('一个月下载 500 GB（在免费 1 TB 内）', 'Downloading 500 GB in a month (inside the free 1 TB)'), num('$0')],
    [t('免费 1 TB 之外每下载 1 GB', 'Each GB downloaded beyond the free 1 TB'), num('≈ $0.085')],
    [t('一个月替换或删除 100 个文件', 'Replacing or deleting 100 files in a month'), num(t('$0（在免费路径内）', '$0 (inside the free paths)'))],
  ]));
  add('p', t('只下载文件一部分的人（例如在视频里拖动进度）只按取回的字节计费，因为文件按字节范围分发。', 'Someone who downloads only part of a file, such as seeking in a video, is billed only for what was fetched, because files are served in byte ranges.'), 'dg-note');

  root.append(flow({
    title: t('什么让账单很小', 'What keeps the bill small'),
    steps: [
      { icon: 'power', title: t('没有闲置服务器', 'No idle servers'), text: t('Lambda 只在登录、所有者改动和清除时运行', 'The Lambdas run only for sign-in, owner changes and clearing') },
      { icon: 'page', title: t('对访客是静态的', 'Static for visitors'), text: t('页面、清单和文件都是普通文件', 'Pages, the list and files are plain files') },
      { icon: 'upload', title: t('直接上传', 'Direct uploads'), text: t('文件从浏览器直接到 S3，不经过 Lambda', 'Files go from the browser to S3, never through the Lambda') },
      { icon: 'cloudfront', title: t('边缘缓存', 'Edge cache'), text: t('文件在边缘保留一天；S3 每个边缘只读一次', 'Files are kept at the edge for a day; S3 is read once per edge') },
      { icon: 's3', title: 'Intelligent-Tiering', text: t('没人下载的文件自动降到更便宜的存储', 'Files nobody downloads drop to cheaper storage automatically') },
      { icon: 'clock', title: t('生命周期', 'Lifecycle'), text: t('未完成的上传 2 天后清除，旧版本 30 天后清除', 'Unfinished uploads go after 2 days, old versions after 30'), tone: 'good' },
    ],
  }));

  add('p', t('CloudFront 从所有边缘节点（价格等级 All）分发，使用 HTTP/2 和 HTTP/3，所以到处都很快。在每月免费 1 TB 内不额外收费。', 'CloudFront serves from all edge locations (price class All), over HTTP/2 and HTTP/3, so downloads are fast everywhere. Within the free 1 TB a month it costs nothing extra.'), 'dg-note');
  source(root, t('源码：dliu-com/file-server（lib/file-server-stack.ts、lambda/api/files.js）。', 'Source: dliu-com/file-server (lib/file-server-stack.ts, lambda/api/files.js).'));
}

// ---------------------------------------------------------------- Security
function security(root) {
  const add = writer(root);
  const FIXED = { text: t('已修复', 'Fixed'), className: 'status fixed' };
  const LOW = { text: t('低', 'Low'), className: 'risk-low' };
  const MEDIUM = { text: t('中', 'Medium'), className: 'risk-medium' };

  root.append(callout('shield', t('2026 年 11 月 3 日对线上网站做了威胁建模、渗透测试和代码审查。下方每项测试都通过；发现的一个严重会话问题和一个影响所有 dliu.com 网站的共享样式问题都已修复并在线上复测。', 'Threat-modelled, penetration-tested and code-reviewed against the live site on 3 November 2026. Every test below passed; a critical session finding and a shared-stylesheet finding that affected every dliu.com site were both fixed and re-checked live.')));

  root.append(tiers({
    title: t('信任边界', 'Trust boundaries'),
    rows: [
      {
        label: t('任何人', 'Anyone'), badge: t('不可信', 'Untrusted'), tone: 'untrusted',
        nodes: [
          { icon: 'users', title: t('访客和其他网站', 'Visitors and other sites'), text: t('可以读取每个文件和文件清单，若在 dliu.com 上还能嵌入页面', 'Can read every file and the file list, and frame pages if they are on dliu.com') },
          { icon: 'bot', title: t('攻击者', 'Attackers'), text: t('可以直接调用 files.dliu.com、它的 /api 和 /auth 路径以及 AWS 端点', 'Can call files.dliu.com, its /api and /auth paths, and AWS endpoints directly') },
        ],
      },
      {
        label: 'CloudFront', badge: t('边缘', 'Edge'), tone: 'edge', link: t('仅 HTTPS', 'HTTPS only'),
        nodes: [
          { icon: 'cloudfront', title: t('分发', 'Distribution'), text: t('TLS 1.2+、安全响应头，除 /api 外只允许 GET 和 HEAD', 'TLS 1.2+, security headers, only GET and HEAD except on /api') },
          { icon: 'code', title: t('脚本', 'Scripts'), text: t('只有网站自己在 /_app/ 的脚本能运行，所以上传的 HTML 或 SVG 文件无法运行代码', 'Only the site’s own scripts in /_app/ may run, so an uploaded HTML or SVG file cannot run code') },
        ],
      },
      {
        label: 'API Lambda', badge: 'API', tone: 'app', link: t('由 CloudFront 签名（IAM、OAC）', 'signed by CloudFront (IAM, OAC)'),
        nodes: [
          { icon: 'lock', title: t('会话检查', 'Session check'), text: t('网站 /api 调用需要签名会话；改动还需 Origin 为 https://files.dliu.com。可选的托管 API 改用 Microsoft 令牌、权限范围和被分配用户角色', 'Website /api calls need a signed session; changes also need Origin https://files.dliu.com. The optional managed API uses Microsoft tokens, scopes and the assigned-user role instead') },
          { icon: 'filter', title: t('输入检查', 'Input checks'), text: t('写入前校验路径、大小、内容类型和分段号；网站自己的 _app/ 对两个入口都是保留前缀。共享的 dliu.com/ 对网站只读、网站 Lambda 角色被 IAM 明确禁止写入，只有独立的托管 API 角色能写', 'Paths, sizes, content types and part numbers validated before anything is written; the site’s own _app/ is a reserved prefix for both entry points. The shared dliu.com/ is read-only to the website and the website Lambda role is explicitly IAM-denied from writing it; only the separate managed-API role may') },
        ],
      },
      {
        label: t('AWS 账户', 'AWS account'), badge: t('私有', 'Private'), tone: 'private', link: t('最小权限角色', 'least-privilege roles'),
        nodes: [
          { icon: 's3', title: t('存储桶', 'Bucket'), text: t('阻止所有公共访问，加密，仅 HTTPS，启用版本控制；CloudFront 只能读', 'All public access blocked, encrypted, HTTPS only, versioned; CloudFront may only read') },
          { icon: 'ssm', title: 'Parameter Store', text: t('客户端密钥加密存储，从不在代码里', 'Client secret stored encrypted, never in code') },
          { icon: 'entra', title: 'Microsoft Entra ID', text: t('决定谁可以登录（需分配）', 'Decides who may sign in (assignment required)') },
        ],
      },
    ],
    note: t('这里每个文件本就是公开的，所以要保护的是改动：只有所有者能上传、移动或删除，而且只能通过 Lambda。', 'Every file here is meant to be public, so the job is to protect changes: only the owner may upload, move or delete, and only through the Lambda.'),
  }));

  add('h2', t('上限', 'Limits'));
  root.append(stats([
    [t('12 小时', '12 hours'), t('会话有效期', 'session lifetime'), 'lock'],
    [t('1 小时', '1 hour'), t('每个上传地址的有效期', 'lifetime of each upload URL'), 'key'],
    ['50 GiB', t('最大文件', 'largest file'), 'folder'],
    [t('30 天', '30 days'), t('旧版本保留以便恢复', 'old versions kept for restoring'), 'clock'],
  ]));

  add('h2', t('线上渗透测试', 'Live penetration test'));
  add('p', t('2026 年 11 月 3 日用 curl、openssl 和对已部署 Lambda 的直接调用，针对 https://files.dliu.com 运行。网站测试在未登录的情况下进行。每条命令都可按下方“如何重跑”复现。', 'Run on 3 November 2026 against https://files.dliu.com with curl, openssl and direct invokes of the deployed Lambda. The website tests were done without signing in. Every command can be re-run (see “How to re-run” below).'));
  root.append(table([t('测试', 'Test'), t('预期', 'Expected'), t('实际', 'Actual'), t('日期', 'Date')], [
    [t('协议降级', 'Protocol downgrade'), t('http:// 301 到 https://，设置一年的 HSTS，拒绝 TLS 1.0/1.1', 'http:// 301s to https://, HSTS set for a year, TLS 1.0/1.1 refused'), t('✓ 301 + HSTS；只协商 TLS 1.2+', '✓ 301 + HSTS; only TLS 1.2+ negotiated'), '2026-11-03'],
    [t('安全响应头', 'Security headers'), t('CSP 只允许 /_app/ 的脚本、无内联代码；nosniff；严格 referrer；Permissions-Policy 关闭传感器', 'CSP allows scripts from /_app/ only, no inline code; nosniff; strict referrer; Permissions-Policy off'), t('✓ 页面和文件响应头一致', '✓ Same on pages and files'), '2026-11-03'],
    [t('嵌入框架（iframe）', 'Framing'), t('frame-ancestors 只允许本站、dliu.com 及其子域；跨域预检无 ACAO', 'frame-ancestors allows this site, dliu.com and subdomains only; no ACAO on cross-origin preflight'), t('✓ 符合预期', '✓ As expected'), '2026-11-03'],
    [t('隐藏和源文件', 'Hidden and source files'), t('/.git/config、/.env、package.json、cdk.json 返回 404；无目录列表', '/.git/config, /.env, package.json, cdk.json return 404; no directory listing'), t('✓ 全部 404', '✓ All 404'), '2026-11-03'],
    [t('文件上的其他 HTTP 方法', 'Other HTTP methods on files'), t('POST、PUT、DELETE、PATCH 返回 403', 'POST, PUT, DELETE and PATCH return 403'), t('✓ 全部 403', '✓ All 403'), '2026-11-03'],
    [t('无会话的网站 API', 'Website API without a session'), t('/api/me 和 /api/files 返回 401', '/api/me and /api/files return 401'), t('✓ 401', '✓ 401'), '2026-11-03'],
    [t('伪造会话 Cookie', 'Forged session cookie'), t('未签名或编造的会话 Cookie 返回 401', 'An unsigned or made-up session cookie returns 401'), t('✓ 401', '✓ 401'), '2026-11-03'],
    [t('把登录 Cookie 当作会话重放', 'Sign-in cookie replayed as a session'), t('/auth/login 发给任何人的登录 Cookie 当作会话出示时必须被拒绝', 'The sign-in cookie that /auth/login gives anyone must be refused when presented as a session'), t('修复前返回 200（完整所有者权限）。现在 /api/me 和 /api/files 返回 401，带 Origin 的删除返回 403', 'Returned 200 (full owner access) before the fix. Now 401 on /api/me and /api/files, and 403 on delete with Origin'), FIXED],
    [t('登录回调', 'Sign-in callback'), t('缺少或伪造 state 返回 400；错误码经过清洗，不回显输入', 'Missing or forged state returns 400; error codes are sanitised and input is not reflected'), t('✓ 400，无反射型 XSS', '✓ 400, no reflected XSS'), '2026-11-03'],
    [t('开放重定向', 'Open redirect'), t('return=//evil.com 不被采用；登录总是跳转到带固定回调地址的 Microsoft', 'return=//evil.com is not used; sign-in always redirects to Microsoft with the fixed callback URL'), t('✓ 返回路径在回调时校验为本站路径', '✓ Return path validated to a site path at callback'), '2026-11-03'],
    [t('绕过 CloudFront', 'Bypassing CloudFront'), t('直接调用 Lambda 函数 URL 和 S3 存储桶返回 403', 'The Lambda function URL and the S3 bucket return 403 when called directly'), t('✓ 两者都 403', '✓ Both 403'), '2026-11-03'],
    [t('无有效令牌的托管 API', 'Managed API without a valid token'), t('无令牌或无效令牌返回 401', 'No token or an invalid token returns 401'), t('✓ 401', '✓ 401'), '2026-11-03'],
    [t('托管 API 权限范围和角色', 'Managed API scopes and roles'), t('缺少 api.access 角色、客户端（azp）错误、删除用 files.read、伪造网关 ID 都应被拒绝；每个路由的范围要匹配', 'Missing api.access role, wrong client (azp), files.read on delete and a forged gateway id must all be refused; each route’s scope must match'), t('✓ 直接调用：角色、azp、范围 403，伪造网关 401；8 个路由范围全部匹配', '✓ Direct invoke: role, azp, scope 403, forged gateway 401; all 8 route scopes match'), '2026-11-03'],
    [t('预签名上传', 'Presigned upload'), t('上传地址只对一个键、一个上传 ID 和分段号签名，一小时后过期', 'Upload URLs are signed for one key, one upload id and part number, and expire in an hour'), t('✓ 由单元测试对 AWS 签名器验证', '✓ Verified by unit tests against the AWS signer'), '2026-11-03'],
    [t('保留路径和路径穿越', 'Reserved paths and traversal'), t('_app、_data、api、auth、index.html、docs、..、%、\\ 对两个入口都被拒绝；dliu.com/ 被网站拒绝（只有托管 API 能写）', '_app, _data, api, auth, index.html, docs, .., %, \\ are refused for both entry points; dliu.com/ is refused on the website (only the managed API may write it)'), t('✓ 由单元测试覆盖', '✓ Covered by unit tests'), '2026-11-03'],
    [t('上传的 HTML/SVG 运行脚本', 'Uploaded HTML/SVG runs script'), t('文件带网站的 CSP（脚本只来自 /_app/）和 nosniff 分发；无法写入 _app/', 'Files are served with the site’s CSP (scripts from /_app/ only) and nosniff; nothing can be written to _app/'), t('✓ 在文件路径上确认了响应头', '✓ Headers confirmed on a file path'), '2026-11-03'],
    [t('覆盖所有网站共享的 dliu.com 样式（供应链）', 'Overwrite the shared dliu.com stylesheet every site loads (supply chain)'), t('文件网站拒绝任何 dliu.com/ 写入，且网站 Lambda 角色被 IAM 明确禁止写入 dliu.com/* 和 _app/*；只有独立的托管 API 函数/角色（需 Microsoft 令牌和 files.write 范围）能写，以保持共享清单准确', 'The Files website refuses any dliu.com/ write, and the website Lambda role is explicitly IAM-denied writing dliu.com/* and _app/*; only the separate managed-API function/role (a Microsoft token with files.write) may, to keep the shared listing accurate'), t('网站会话上传 dliu.com/ui/v1/dl.css 被拒绝；托管 API 可写，网站线上角色带 dliu.com/* Deny 语句', 'A website session uploading dliu.com/ui/v1/dl.css is refused; the managed API may write it, and the live website role carries the dliu.com/* Deny statement'), FIXED],
    [t('上传超过声明大小的字节（盗刷）', 'Upload more bytes than declared (cost abuse)'), t('完成上传前，实际分段大小之和必须等于声明的大小，否则中止并返回 400', 'Before the upload is finalised the real part sizes must sum to the declared size, or it is aborted and returns 400'), t('✓ 为 40 MiB 的上传提交 90 MiB 的内容被拒绝并中止，未创建对象', '✓ A 90 MiB body for a 40 MiB upload is rejected and aborted; no object is created'), FIXED],
    [t('缓存欺骗', 'Cache deception'), t('/api/me/x.css 之类的路径返回 401，且不被缓存', 'A path like /api/me/x.css returns 401 and is not cached'), t('✓ 401，未缓存', '✓ 401, not cached'), '2026-11-03'],
    [t('默认 CloudFront 域名', 'Default CloudFront domain'), t('*.cloudfront.net 返回相同的安全响应头；__Host- 会话 Cookie 无法在该域设置；/api 返回 401', 'The *.cloudfront.net domain returns the same security headers; the __Host- session cookie cannot be set there; /api returns 401'), t('✓ 响应头一致，/api 返回 401', '✓ Same headers, 401 on /api'), '2026-11-03'],
    [t('CRLF 和头注入', 'CRLF and header injection'), t('路径中的 CR/LF 返回 401，不拆分响应头', 'CR/LF in the path returns 401 and does not split headers'), t('✓ 401', '✓ 401'), '2026-11-03'],
  ]));

  add('h2', t('威胁模型', 'Threat model'));
  root.append(table([t('情景', 'Scenario'), t('剩余风险', 'Residual risk'), t('控制措施', 'Controls')], [
    [t('所有者以外的人上传、移动或删除文件', 'Someone other than the owner uploads, moves or deletes a file'), LOW, t('每次改动都需要用从 Entra 客户端密钥派生的密钥签名的会话 Cookie；登录仅限单租户应用被分配的用户，Lambda 还检查 @dliu.com 邮箱域', 'Every change needs a session cookie signed with a key derived from the Entra client secret; sign-in is limited to assigned users of a single-tenant app, and the Lambda also checks the @dliu.com email domain')],
    [t('写入者覆盖所有 dliu.com 网站都加载的共享 dl.css（供应链）', 'A writer overwrites the shared dl.css that every dliu.com site loads (supply chain)'), LOW, t('dliu.com/ 对文件网站只读：登录的网站会话不能写它，网站 Lambda 角色也被 IAM 明确禁止写入 dliu.com/* 和 _app/*，所以即使路径检查被绕过也改不了。只有独立的托管 API 函数/角色（需 auth.dliu.com 的 Microsoft 令牌和 files.write 范围）能写，这样 shared-resources 发布更新时共享清单保持准确。被篡改的 dl.css 会影响所有网站，因此按供应链风险对待；访问范围限于 Entra 被分配的用户。读取这些文件不受影响', 'dliu.com/ is read-only to the Files website: signed-in website sessions cannot write it, and the website Lambda role is explicitly IAM-denied writing dliu.com/* and _app/*, so even a bypass of the path check cannot change them. Only the separate managed-API function/role (a Microsoft token from auth.dliu.com with the files.write scope) may write it, so the shared listing stays accurate when shared-resources publishes updates. A tampered dl.css would affect every site, so it is treated as a supply-chain risk; write access is limited to Entra-assigned users. Reading those files is unaffected')],
    [t('读过公开源码的人把 /auth/login 发给任何人的登录 Cookie 当作会话 Cookie 重放', 'Someone who has read the public source replays the sign-in cookie that /auth/login gives anyone as a session cookie'), LOW, t('2026 年 11 月 3 日渗透测试后已修复。登录 Cookie 和会话 Cookie 现在用不同密钥签名，并带有会被检查的类型；会话必须指明用户。修复前的所有会话都已结束。单元测试会重放登录 Cookie 和其他伪造内容，当天的线上测试也在网站上重放了一次并被拒绝', 'Fixed on 3 November 2026 after a penetration test. Sign-in and session cookies are now signed with different keys and carry a type that is checked; a session must name a user. Every session from before the fix was ended. Unit tests replay the sign-in cookie and other forged payloads, and the live test that day replayed it on the site and was refused')],
    [t('会话 Cookie 被伪造或被盗', 'A session cookie is forged or stolen'), LOW, t('HMAC-SHA256 签名恒定时间比较，12 小时过期，HttpOnly、Secure、SameSite=Lax 和 __Host- 前缀，所以其他 dliu.com 子域无法设置或读取它', 'HMAC-SHA256 signature compared in constant time, 12-hour expiry, HttpOnly, Secure, SameSite=Lax and the __Host- prefix, so other dliu.com subdomains cannot set or read it')],
    [t('登录 CSRF、授权码被截获或开放重定向', 'Login CSRF, code interception or an open redirect'), LOW, t('短期签名 Cookie 中的 state、nonce 和 PKCE（S256）；固定回调地址；校验 ID 令牌的签名、颁发者、租户、受众和有效期；返回地址必须是本站路径', 'state, nonce and PKCE (S256) in a short-lived signed cookie; fixed redirect URI; ID token signature, issuer, tenant, audience and expiry checked; the return address must be a path on this site')],
    [t('其他网站让已登录的所有者删除或移动文件（CSRF）', 'Another site makes the signed-in owner delete or move files (CSRF)'), LOW, t('改动是需要会话 Cookie 的 POST（SameSite=Lax 不会跨站发送），且 Origin 必须正好是 https://files.dliu.com', 'Changes are POSTs that need the session cookie (not sent cross-site with SameSite=Lax) and an Origin header of exactly https://files.dliu.com')],
    [t('上传的 HTML 或 SVG 文件运行脚本（XSS）', 'An uploaded HTML or SVG file runs script (XSS)'), LOW, t('文件带网站的 CSP 分发，脚本只允许来自 /_app/，并带 nosniff；没有东西能上传到 _app/', 'Files are served with the site’s CSP, which allows scripts only from /_app/, and nosniff; nothing can be uploaded into _app/')],
    [t('用文件名到达其他路径', 'File names are used to reach other paths'), LOW, t('. 和 ..、\\ ? # % 和控制字符被拒绝；网站自己的名称是保留的；S3 键由 Lambda 选择，从不由浏览器决定', '. and .., \\ ? # % and control characters are refused; the site’s own names are reserved; the Lambda chooses the S3 key, never the browser')],
    [t('重用上传地址覆盖其他文件', 'Upload URLs are reused to overwrite other files'), LOW, t('每个地址只对一个键、一个上传 ID 和分段号签名，一小时后过期', 'Each URL is signed for one key, one upload ID and part number, and expires after an hour')],
    [t('不经 CloudFront 直接调用 Lambda 或存储桶', 'The Lambda or bucket is called without CloudFront'), LOW, t('函数 URL 需要 IAM 认证，只授予这个 CloudFront 分发；存储桶阻止公共访问，只允许 CloudFront 读取', 'The function URL requires IAM auth, given only to this CloudFront distribution; the bucket blocks public access and allows CloudFront to read only')],
    [t('误删或误覆盖文件', 'A file is deleted or overwritten by mistake'), LOW, t('存储桶启用版本控制并保留旧版本 30 天；堆栈删除时保留；清单使用条件写入', 'The bucket is versioned and keeps old versions for 30 days; it is retained if the stack is deleted; the list uses conditional writes')],
    [t('被替换或删除的文件仍被分发', 'A replaced or deleted file is still served'), LOW, t('S3 改动事件约一分钟内从 CloudFront 清除该路径；已经下载过它的浏览器可能保留 5 分钟', 'S3 change events clear the path from CloudFront within about a minute; browsers that already downloaded it may keep it for 5 minutes')],
    [t('有人从其他网站盗链文件推高账单', 'Someone hot-links files from another site to run up the bill'), MEDIUM, t('文件本就公开以便分享；1 TB 免费额度吸收日常使用；没有限流或 WAF', 'Files are public by design so they can be shared; the 1 TB free tier absorbs ordinary use; there is no rate limit or WAF')],
    [t('大量请求 /api 或 /auth', 'Floods of requests to /api or /auth'), MEDIUM, t('未认证的调用廉价地返回 401，Lambda 无固定成本，但每次调用仍会运行它；没有 WAF', 'Unauthenticated calls return 401 cheaply and the Lambda has no fixed cost, but every call still runs it; there is no WAF')],
    [t('密钥通过公开仓库泄露', 'Secrets leak through the public repository'), LOW, t('客户端密钥、租户和客户端 ID 存在 Parameter Store（密钥用 KMS 加密），运行时读取。2026 年 11 月 3 日扫描了已推送的全部 git 历史，没有发现机密', 'The client secret, tenant and client IDs live in Parameter Store (secret encrypted with KMS) and are read at run time. All pushed git history was scanned on 3 November 2026 and no secrets were found')],
  ]));

  add('h2', t('盗刷钱包（成本上限）', 'Denial of wallet (cost caps)'));
  add('p', t('没有付费的固定成本在闲置时计费。攻击者能推高账单的途径只有流量，而且每条都有上限：', 'Nothing paid has a fixed idle cost. The only ways an attacker can run up the bill are traffic-based, and each is capped:'));
  root.append(list([
    t('下载和盗链：文件本就公开。前 1 TB/月传输免费；之后 CloudFront 按 GB 计费。没有 WAF 或限流，所以持续盗链会花钱——这是公开分享主动接受的权衡。', 'Downloads and hot-linking: files are public by design. The first 1 TB/month of transfer is free; beyond that CloudFront charges per GB. There is no WAF or rate limit, so sustained hot-linking costs money — a trade-off accepted for public sharing.'),
    t('刷 /api 或 /auth：每次调用只运行一个很小的 Lambda，未认证时廉价返回 401。256 MB、60 秒的函数没有预置并发；成本随调用数线性增长，没有放大。', 'Flooding /api or /auth: each call runs one tiny Lambda that returns 401 cheaply when unauthenticated. The 256 MB, 60-second function has no provisioned concurrency; cost grows linearly with calls, with no amplification.'),
    t('上传放大（已修复）：预签名分段只对 host 签名，所以写入者原本可以为声明很小的上传 PUT 远多于声明的字节。完成上传前现在会核对实际分段大小之和与声明大小，未完成的分段上传 2 天后由生命周期规则中止。', 'Upload amplification (fixed): presigned parts sign only host, so a writer could once PUT far more bytes than declared for a small-declared upload. The real part sizes are now checked against the declared size before finalising, and unfinished multipart uploads are aborted by a lifecycle rule after 2 days.'),
    t('存储：只有已认证的所有者能写入；版本控制保留旧版本 30 天（30 天后过期），删除标记会被清理。', 'Storage: only the authenticated owner can write; versioning keeps old versions for 30 days (then they expire) and delete markers are cleaned up.'),
  ]));
  add('p', t('建议但尚未启用（需用户决定，因为可能花钱或限制正常使用）：Lambda 预留并发上限、AWS 预算告警，以及（成本较高的）WAF 速率规则。', 'Suggested but not yet enabled (needs a user decision, as each can cost money or limit normal use): a Lambda reserved-concurrency cap, an AWS budget alarm, and (at a cost) a WAF rate rule.'));

  add('h2', t('代码审查', 'Code review'));
  root.append(list([
    t('每个处理函数都读过：写入前校验输入，每条路径都做授权，错误经过清洗不回显输入。客户端只用 textContent 渲染，从不用 innerHTML。', 'Every handler was read: inputs validated before writes, authorization on every path, errors sanitised and never reflecting input. The client renders with textContent only, never innerHTML.'),
    t('密钥：代码、日志或 git 历史中都没有机密。2026 年 11 月 3 日扫描了已推送的全部历史，只找到占位数字和 AWS 示例密钥（AKIDEXAMPLE）。cdk.out 和 .env 未被跟踪且已在 .gitignore 中。', 'Secrets: none in code, logs or git history. The full pushed history was scanned on 3 November 2026 and only placeholder numbers and the AWS example key (AKIDEXAMPLE) were found. cdk.out and .env are untracked and covered by .gitignore.'),
    t('依赖：npm audit 在生产依赖（--omit=dev）上只报告 aws-cdk-lib 的两个 moderate（minimatch ReDoS），仅用于构建，无可用修复。已部署的 Lambda 不打包 node_modules，只用 Node 22 运行时的 AWS SDK 和 crypto，所以没有有漏洞的包进入生产。', 'Dependencies: npm audit on production dependencies (--omit=dev) reports only two moderate issues in aws-cdk-lib (minimatch ReDoS), build-time only with no fix available. The deployed Lambda bundles no node_modules and uses only the Node 22 runtime’s AWS SDK and crypto, so no vulnerable package reaches production.'),
    t('IAM 最小权限：角色按资源限定；kms:Decrypt 带 ViaService=ssm 条件；一条明确的 Deny 阻止 API 写入 _app/* 和 dliu.com/*；清除函数只能创建失效，不能读写对象。存储桶阻止所有公共访问、加密、仅 HTTPS、启用版本控制。', 'IAM least privilege: roles are scoped by resource; kms:Decrypt carries a ViaService=ssm condition; an explicit Deny stops the API writing _app/* and dliu.com/*; the clear function may only create invalidations, not read or write objects. The bucket blocks all public access, is encrypted, HTTPS-only and versioned.'),
    t('测试：171 项单元和堆栈测试覆盖了安全路径，包括每个修复（会话重放、只读的 dliu.com/ 前缀与按入口拆分的 IAM Deny、上传大小核对）。', 'Tests: 171 unit and stack tests cover the security paths, including every fix (session replay, the read-only dliu.com/ prefix with its per-entry-point IAM Deny, the upload size check).'),
  ]));

  add('h2', t('接受的剩余风险', 'Accepted residual risks'));
  root.append(list([
    t('每个文件都是公开的。任何知道或猜到路径、或读到文件清单的人都能下载；没有私密文件。私密内容请用 OneDrive 分享（share.dliu.com）。', 'Every file is public. Anyone who knows or guesses a path, or reads the file list, can download it; there are no private files. Use OneDrive sharing (share.dliu.com) for anything private.'),
    t('没有 WAF 或限流；超出免费额度的大量下载或盗链按 GB 付费。', 'There is no WAF or rate limit; heavy downloading or hot-linking is paid for per GB after the free tier.'),
    t('会话无法在服务器端撤销；被盗的 Cookie 在过期前（最多 12 小时）有效。轮换客户端密钥会使所有会话失效。', 'Sessions cannot be revoked on the server; a stolen cookie works until it expires (at most 12 hours). Rotating the client secret revokes all sessions.'),
    t('退出登录是普通链接，所以其他网站可以让所有者退出。除此之外无法以这种方式触发任何操作。', 'Sign-out is a plain link, so another site could sign the owner out. Nothing else can be triggered that way.'),
    t('上传的文件不做扫描；原样分发。', 'Uploaded files are not scanned; they are served exactly as uploaded.'),
    t('托管 API 用共享的 dliu API 用户角色（api.access）授权，而不是 Files 专用角色或 oid 白名单，所以任何被分配该角色的人都能写入和删除文件，且托管 API 不另外检查 @dliu.com 邮箱。已接受：以 Entra 为门禁——"需要分配"且仅把该角色分配给所有者的账号；该角色按设计在各 dliu 应用间共享。', 'The managed API authorises with the shared dliu API user role (api.access), not a Files-specific role or an oid allow-list, so anyone assigned that role can write and delete files, and the managed API does not additionally check for an @dliu.com address. Accepted: Entra is the gate — "Assignment required" with the role assigned only to the owner\u2019s account; the role is shared across dliu apps by design.'),
  ]));

  root.append(more(t('每个页面和文件上的响应头', 'Response headers on every page and file'),
    table([t('响应头', 'Header'), t('值', 'Value')], [
      [mono('Content-Security-Policy'), "default-src 'self'; script-src https://files.dliu.com/_app/; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' <file bucket>; frame-ancestors 'self' https://dliu.com https://*.dliu.com; base-uri 'none'; form-action 'none'"],
      [mono('Strict-Transport-Security'), 'max-age=31536000'],
      [mono('X-Content-Type-Options'), 'nosniff'],
      [mono('Referrer-Policy'), 'strict-origin-when-cross-origin'],
      [mono('Permissions-Policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'],
    ])));

  const commands = document.createElement('pre');
  commands.className = 'mono';
  commands.style.whiteSpace = 'pre-wrap';
  commands.textContent = [
    '# Auth and routing (website, no session)',
    'curl -si https://files.dliu.com/api/me | head -1            # 401',
    "curl -si -X POST -H 'Origin: https://evil.example' https://files.dliu.com/api/files/delete | head -1   # 403/401",
    'curl -si https://files.dliu.com/api/me/x.css | head -1       # 401, cache deception',
    '',
    '# alg=none forged JWT to the managed API',
    "h=$(printf '{\"alg\":\"none\",\"typ\":\"JWT\"}' | base64 | tr '+/' '-_' | tr -d '=')",
    "p=$(printf '{\"sub\":\"x\",\"scp\":\"files.write\"}' | base64 | tr '+/' '-_' | tr -d '=')",
    "curl -si -H \"Authorization: Bearer $h.$p.\" <managed-api>/api/files | head -1   # 401",
    '',
    '# Shared stylesheet is read-only to the app (supply chain)',
    "node -e \"require('./lambda/api/files').cleanPath('dliu.com/ui/v1/dl.css')\"   # throws: reserved",
    'aws iam get-role-policy --role-name <api-role> --policy-name <inline> \\',
    "  --query 'PolicyDocument.Statement[?Effect==`Deny`]'    # Deny PutObject on _app/* and dliu.com/*",
    '',
    '# Secret scan, dependency audit and the full test suite',
    'git log -p | grep -nE "AKIA[0-9A-Z]{16}|-----BEGIN"        # none (AKIDEXAMPLE is the AWS sample)',
    'npm audit --omit=dev',
    'npx jest && npx tsc --noEmit',
  ].join('\n');
  root.append(more(t('如何重跑这些测试', 'How to re-run these tests'), commands));

  source(root, t('源码：dliu-com/file-server（lib/file-server-stack.ts、lambda/api/auth.js、lambda/api/api-access.js、lambda/api/files.js、lambda/api/store.js）。', 'Source: dliu-com/file-server (lib/file-server-stack.ts, lambda/api/auth.js, lambda/api/api-access.js, lambda/api/files.js, lambda/api/store.js).'));
}

// Each article starts with its heading and lead from docs.html (translated by i18n.js); the rest is drawn here.
const PAGES = { architecture, cost, security, health, api };
const kept = Object.fromEntries(TABS.map((id) => [id, document.getElementById(id).children.length]));
function draw() {
  renderNav();
  for (const id of TABS) {
    const root = document.getElementById(id);
    while (root.children.length > kept[id]) root.lastElementChild.remove();
    PAGES[id](root);
  }
}
draw();

function show(scroll) {
  const current = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : TABS[0];
  for (const id of TABS) document.getElementById(id).hidden = id !== current;
  for (const link of document.querySelectorAll('.dl-tabs a')) {
    if (link.dataset.tab === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `${TITLES[current]()} · ${t('文档', 'Docs')} · ${t('文件', 'Files')} · dliu.com`;
  if (scroll) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => show(true));
onLanguageChange(() => { draw(); show(false); });
show(false);
