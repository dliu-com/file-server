const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const pageJs = read('web/docs-health.js');
const md = read('web/docs/health.md');
const endpoint = read('lambda/api/index.js');
const pagesFn = read('functions/pages.js');

const parseArray = (name) => JSON.parse(pageJs.match(new RegExp(`${name}\\s*=\\s*(\\[[^\\]]*\\])`))[1].replace(/'/g, '"'));
const GUEST = parseArray('GUEST_FUNCTIONS');
const HEALTH = parseArray('HEALTH_FUNCTIONS');

describe('health docs and endpoint stay in sync (HEALTH.md §3)', () => {
  test('the three testing surfaces are all wired up', () => {
    // The human page is now the Testing tab on /docs; the old path 301-redirects to it.
    expect(pagesFn).toContain("'/docs/health': '/docs#health'");
    expect(pagesFn).toContain("'/docs/health.md': '/_app/docs/health.md'");
    // The public endpoint exists.
    expect(endpoint).toContain("path === '/health'");
  });

  test('the health endpoint keys match the page and the Markdown', () => {
    expect(HEALTH).toEqual(['storage', 'signin']);
    for (const key of HEALTH) {
      expect(endpoint).toContain(`'${key}'`);
      expect(md).toContain(`\`${key}\``);
    }
  });

  test('every guest-check function appears in both the page and the Markdown', () => {
    expect(GUEST).toEqual(['pages', 'shared-ui', 'listing', 'signin', 'api', 'health']);
    for (const key of GUEST) {
      expect(pageJs).toContain(`'${key}'`);
      expect(md).toContain(`\`${key}\``);
    }
  });

  test('the Markdown documents the key guest expectations', () => {
    expect(md).toContain('https://login.microsoftonline.com/');
    expect(md).toContain('application/health+json');
    expect(md).toMatch(/401/);
    expect(md).toMatch(/302/);
  });

  test('the /health handler reads no cookies or Authorization header', () => {
    const body = endpoint.slice(endpoint.indexOf('async function health('), endpoint.indexOf('function createHandler('));
    expect(body.length).toBeGreaterThan(0);
    expect(body.toLowerCase()).not.toContain('cookie');
    expect(body.toLowerCase()).not.toContain('authorization');
  });
});

describe('the Health tab is human-readable (HEALTH.md §1)', () => {
  const vm = require('vm');

  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
    get textContent() { return this.children.map((c) => typeof c === 'string' ? c : c.textContent).join(''); }
  }
  const el = (tag, attrs = {}, ...children) => {
    const node = new Element(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    node.append(...children);
    return node;
  };
  const walk = (node) => [node, ...node.children.filter((c) => c instanceof Element).flatMap(walk)];
  const box = (...parts) => {
    const n = new Element('div');
    const push = (v) => { if (v == null) return; Array.isArray(v) ? v.forEach(push) : n.append(v instanceof Element ? v : String(v)); };
    parts.forEach(push);
    return n;
  };
  const stubs = {
    flow: ({ title, steps = [], note }) => box(title, steps.map((s) => [s.title, s.text]), note),
    tiers: ({ title, rows = [], note }) => box(title, rows.map((r) => [r.label, r.badge, r.link, (r.nodes || []).map((x) => [x.title, x.text])]), note),
    stats: (items) => box(items.map((i) => [i[0], i[1]])),
    bars: ({ title, items = [], note }) => box(title, items.map((i) => [i[0], String(i[1])]), note),
    table: (headers, rows) => box(headers, rows),
    callout: (name, text) => box(text),
    icon: () => new Element('svg'),
  };
  const renderer = () => {
    const context = { el, t: (zh, en) => en, ...stubs };
    vm.runInNewContext(pageJs.replace(/^import .*;$/gm, '').replace(/^export /gm, ''), context);
    return context;
  };

  test('it shows rather than tells: no code or detail blocks, and it links to the Markdown at top and end', () => {
    const root = el('div');
    renderer().health(root);
    const nodes = walk(root);
    const text = root.textContent;
    expect(nodes.some((n) => ['code', 'pre', 'details'].includes(n.tag))).toBe(false);
    // No exact technical details (status codes, content types, braces).
    expect(text).not.toMatch(/\b(200|301|302|401|403|404|503)\b/);
    expect(text).not.toMatch(/application\/|Authorization|Bearer|x-amz-|\{|\}/);
    // The Markdown reference is linked at the top and again at the end; the live status page is linked once.
    const links = nodes.filter((n) => n.tag === 'a');
    const md = links.filter((l) => l.attributes.href === '/docs/health.md');
    const status = links.filter((l) => l.attributes.href === 'https://status.dliu.com/site/files');
    expect(md).toHaveLength(2);
    expect(status).toHaveLength(1);
    expect(links).toHaveLength(3);
  });
});
