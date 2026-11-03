const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const DL_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl.css">';
const DL_DOCS_CSS = '<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl-docs.css">';
const DL_ICON = 'https://files.dliu.com/dliu.com/favicon.png';
const PAGES = ['web/index.html', 'web/docs.html', 'web/docs-api.html'];

test('every page loads the shared dliu.com stylesheet before its own', () => {
  for (const file of PAGES) {
    const page = read(file);
    expect(page).toContain(DL_CSS);
    expect(page.indexOf(DL_CSS)).toBeLessThan(page.indexOf('<link rel="stylesheet" href="/_app/style.css">'));
  }
});

const APP_LOGO = '/_app/logo.svg';
const FOOTER_LOGO = `<a class="dl-footer-logo" href="https://dliu.com" aria-label="dliu.com"><img src="${DL_ICON}" alt="" width="24" height="24"></a>`;

test('every page shows the Files logo top left and as favicon, and the DL logo in the shared footer', () => {
  for (const file of PAGES) {
    const page = read(file);
    expect(page).toContain(`<link rel="icon" type="image/svg+xml" href="${APP_LOGO}">`);
    expect(page).toContain('<body class="dl-page">');
    expect(page).toContain(`<a class="dl-brand" href="/"><img class="dl-logo" src="${APP_LOGO}" alt="" width="32" height="32"><span data-zh="文件">Files</span></a>`);
    expect(page).toMatch(/<main class="dl-main[" ]/);
    expect(page).toContain(`<footer class="dl-footer">${FOOTER_LOGO} <a href="https://dliu.com">dliu.com</a> · <a href="/docs" data-zh="文档">Docs</a></footer>`);
    expect(page.match(/dliu\.com\/favicon\.png/g)).toHaveLength(1);
  }
  expect(read('web/logo.svg')).toContain('<svg');
});

test.each(['web/docs.html', 'web/docs-api.html'])('%s uses the shared docs stylesheet and the same tabs', (file) => {
  const page = read(file);
  expect(page.indexOf(DL_CSS)).toBeLessThan(page.indexOf(DL_DOCS_CSS));
  expect(page.indexOf(DL_DOCS_CSS)).toBeLessThan(page.indexOf('/_app/style.css'));
  expect(page).toContain('<main class="dl-main dl-docs-main">');
  expect(page).toContain('<nav class="dl-tabs" aria-label="Docs sections" data-zh-label="文档章节">');
  expect(page).toMatch(/<article (id="\w+" )?class="dl-docs/);
  const tabs = [...page.matchAll(/<nav class="dl-tabs"[^>]*>([\s\S]*?)<\/nav>/g)][0][1];
  expect([...tabs.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1])).toEqual(['Technical architecture', 'Cost', 'Security', 'Testing', 'API']);
  for (const zh of ['技术架构', '运行成本', '安全', '测试']) expect(tabs).toContain(`data-zh="${zh}"`);
});

test('the docs page scripts and diagram kit load only from /_app/', () => {
  const page = read('web/docs.html');
  expect(page).toContain('<script src="/_app/i18n.js" defer></script>');
  expect(page).toContain('<script type="module" src="/_app/docs.js"></script>');
  expect(read('web/docs.js')).toContain("from './diagram.js'");
  for (const id of ['architecture', 'cost', 'security', 'health']) expect(page).toContain(`<article id="${id}" class="dl-docs"`);
});

test('the app stylesheet leaves the header, buttons, docs and palette to the shared stylesheets', () => {
  const css = read('web/style.css');
  expect(css).not.toMatch(/header\.top|\.brand|footer\.bottom|^\s*button|\.button\b|\.docs\b|:root/m);
  expect(css).not.toMatch(/var\(--(bg|panel|panel-2|line|text|muted|accent|accent-2|danger|ok|radius)\)/);
  expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
});

test('scripts use the shared classes for buttons and status text', () => {
  const scripts = ['web/app.js', 'web/common.js', 'web/docs-api.js', 'web/docs.js', 'web/docs-health.js', 'web/diagram.js'].map(read).join('\n');
  expect(scripts).not.toMatch(/class: '(button|primary|danger|muted|error|success)\b/);
  expect(scripts).not.toContain('header.top');
});

test('every page loads the shared language switch (i18n.js from /_app/) and offers a translatable footer', () => {
  for (const file of PAGES) {
    const page = read(file);
    expect(page).toContain('<script src="/_app/i18n.js" defer></script>');
    expect(page).toContain('<a href="/docs" data-zh="文档">Docs</a></footer>');
  }
});
