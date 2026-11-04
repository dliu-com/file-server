const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  set className(value) { this.attributes.class = value; }
  get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
}

function render(pathname, cookie = '', window) {
  const nav = new Element('nav');
  const context = {
    document: { cookie, querySelector: (selector) => selector === '.dl-header .dl-nav' ? nav : null, createElement: (tag) => new Element(tag) },
    location: { pathname, search: '' },
    Node: Element,
    ...(window ? { window } : {}),
  };
  const source = fs.readFileSync(path.join(__dirname, '../web/common.js'), 'utf8').replace(/^export /gm, '');
  vm.runInNewContext(`${source}\nrenderNav();`, context);
  return nav.children.map((child) => ({ text: child.textContent, ...child.attributes }));
}

test('every visitor gets a Docs item that opens the docs page, before Sign in', () => {
  const items = render('/photos/');
  expect(items.map((item) => item.text)).toEqual(['Docs', 'Sign in']);
  expect(items[0]).toMatchObject({ href: '/docs', class: 'dl-button' });
  expect(items[1].class).toBe('dl-button dl-signin');
  expect(items[0]['aria-current']).toBeUndefined();
  expect(items[1].href).toBe('/auth/login?return=%2Fphotos%2F');
});

test('the owner gets Docs then Sign out, and Docs is marked current on the docs page', () => {
  expect(render('/', 'files_owner=1').map((item) => [item.text, item.href])).toEqual([['Docs', '/docs'], ['Sign out', '/auth/logout']]);
  expect(render('/docs')[0]['aria-current']).toBe('page');
  expect(render('/docs/api')[0]['aria-current']).toBeUndefined();
  expect(render('/docs/')[0]['aria-current']).toBeUndefined();
});

test('every page shell have the header nav that renderNav fills', () => {
  for (const file of ['web/index.html', 'web/docs.html']) {
    expect(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).toContain('<nav class="dl-nav" aria-label="Site" data-zh-label="网站"></nav>');
  }
});

test('with i18n.js loaded, labels follow the language and the language switcher stays last', () => {
  const switcher = new Element('div');
  switcher.className = 'dl-language';
  const zh = { switcher, t: (zhText) => zhText };
  expect(render('/', '', { FilesI18n: zh }).map((item) => item.text || item.class)).toEqual(['文档', '登录', 'dl-language']);
  expect(render('/', 'files_owner=1', { FilesI18n: zh }).map((item) => item.text || item.class)).toEqual(['文档', '退出登录', 'dl-language']);
  const en = { switcher, t: (zhText, enText) => enText };
  expect(render('/docs', '', { FilesI18n: en }).map((item) => item.text || item.class)).toEqual(['Docs', 'Sign in', 'dl-language']);
});
