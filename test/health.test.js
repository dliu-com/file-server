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
