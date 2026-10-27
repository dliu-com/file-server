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
  ])('%s -> %s', (input, expected) => {
    expect(uriFor(input)).toBe(expected);
  });
});
