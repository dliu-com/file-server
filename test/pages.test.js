const fs = require('fs');
const path = require('path');

const code = fs.readFileSync(path.join(__dirname, '..', 'functions', 'pages.js'), 'utf8');
const handler = new Function(`${code}\nreturn handler;`)();
const uriFor = (uri) => handler({ request: { uri } }).uri;

describe('pages CloudFront function', () => {
  test.each([
    ['/', '/_app/index.html'],
    ['/index.html', '/_app/index.html'],
    ['/me/', '/_app/index.html'],
    ['/me/videos/', '/_app/index.html'],
    ['/%E7%AE%80%E5%8E%86/', '/_app/index.html'],
    ['/me/resume.pdf', '/me/resume.pdf'],
    ['/me', '/me'],
    ['/dliu.com/favicon.png', '/dliu.com/favicon.png'],
    ['/_app/app.js', '/_app/app.js'],
    ['/me/index.html', '/me/index.html'],
    ['/docs', '/_app/docs.html'],
    ['/docs/api.md', '/_app/docs/api.md'],
    ['/docs/health.md', '/_app/docs/health.md'],
    ['/robots.txt', '/_app/robots.txt'],
    ['/sitemap.xml', '/_app/sitemap.xml'],
    ['/docs/', '/_app/index.html'],
    ['/docs/api/', '/_app/index.html'],
    ['/docs/health/', '/_app/index.html'],
    ['/docs/api/notes.txt', '/docs/api/notes.txt'],
    ['/docs/API', '/docs/API'],
    ['/docs/Health', '/docs/Health'],
    ['/constructor', '/constructor'],
    ['/__proto__', '/__proto__'],
  ])('%s -> %s', (input, expected) => {
    expect(uriFor(input)).toBe(expected);
  });

  test('/docs/health 301-redirects to the Health tab', () => {
    const result = handler({ request: { uri: '/docs/health' } });
    expect(result.statusCode).toBe(301);
    expect(result.headers.location.value).toBe('/docs#health');
  });

  test('/docs/api 301-redirects to the API tab', () => {
    const result = handler({ request: { uri: '/docs/api' } });
    expect(result.statusCode).toBe(301);
    expect(result.headers.location.value).toBe('/docs#api');
  });
});

describe('sitemap and robots', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', 'web', p), 'utf8');
  const sitemap = read('sitemap.xml');
  const robots = read('robots.txt');
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  test('it lists only the public, canonical app pages', () => {
    expect(locs).toEqual(['https://files.dliu.com/', 'https://files.dliu.com/docs']);
  });

  test('it excludes personal files, redirects, machine alternates and auth/API routes', () => {
    // Public accessibility is not permission to publicise personal file contents, so no folder or file paths,
    // and no auth/API/redirect/markdown-alternate URLs. The canonical docs page is /docs, not its .md alternates.
    for (const forbidden of ['/auth', '/api', '/_app', '/_data', '.md', '/docs/api', '/docs/health', 'robots.txt', 'sitemap.xml']) {
      for (const loc of locs) expect(loc).not.toContain(forbidden);
    }
    // Every listed page is an app page the pages function serves (not a redirect, not a file passthrough).
    for (const loc of locs) {
      const uri = new URL(loc).pathname;
      const result = handler({ request: { uri } });
      expect(result.statusCode).toBeUndefined();
    }
  });

  test('robots allows crawling and points at the sitemap', () => {
    expect(robots).toMatch(/User-agent:\s*\*/);
    expect(robots).toContain('Sitemap: https://files.dliu.com/sitemap.xml');
    expect(robots).not.toMatch(/Disallow:\s*\//);
  });
});
