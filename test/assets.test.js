const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Guards against a page shipping a client script that cannot parse. On 2026-11-04 the homepage went
// to a permanent "Loading…" because web/app.js had a syntax error (a dropped `buttons.push(` left a
// dangling `);`): the HTML and the file list still returned 200, so no guest HTTP check caught it.
// The fix is this build-time parse of every browser script. Documented in the Health tab and health.md.
const webDir = path.join(__dirname, '..', 'web');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('browser scripts parse', () => {
  test.each(jsFiles(webDir).map((f) => path.relative(webDir, f)))('web/%s has no syntax error', (rel) => {
    expect(() => execFileSync('node', ['--check', path.join(webDir, rel)], { stdio: 'pipe' })).not.toThrow();
  });
});
