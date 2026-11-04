// CloudFront Function (cloudfront-js-2.0), viewer-request on the default behavior.
// Folder pages: "/", "/index.html" and any URL ending in "/" show the file browser, which reads the folder
// from the address bar. /docs is the docs page (architecture, cost, security, testing, API). /docs/api.md and
// /docs/health.md are the machine-readable API and testing references. The old /docs/api and /docs/health pages
// are now the API and Health tabs, so they 301-redirect to /docs#api and /docs#health. Everything else is a file.
var PAGES = { '/docs': '/_app/docs.html', '/docs/api.md': '/_app/docs/api.md', '/docs/health.md': '/_app/docs/health.md' };
var REDIRECTS = { '/docs/api': '/docs#api', '/docs/health': '/docs#health' };

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (Object.prototype.hasOwnProperty.call(REDIRECTS, uri)) {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: REDIRECTS[uri] } } };
  }
  if (uri === '/index.html' || uri.charAt(uri.length - 1) === '/') {
    request.uri = '/_app/index.html';
  } else if (Object.prototype.hasOwnProperty.call(PAGES, uri)) {
    request.uri = PAGES[uri];
  }
  return request;
}
