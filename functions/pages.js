// CloudFront Function (cloudfront-js-2.0), viewer-request on the default behavior.
// Folder pages: "/", "/index.html" and any URL ending in "/" show the file browser, which reads the folder
// from the address bar. /docs is the docs page (architecture, cost, security); /docs/api and /docs/api.md are the API
// reference; /docs/health and /docs/health.md are the public testing instructions. Everything else is a file.
var PAGES = { '/docs': '/_app/docs.html', '/docs/api': '/_app/docs-api.html', '/docs/api.md': '/_app/docs/api.md', '/docs/health': '/_app/docs-health.html', '/docs/health.md': '/_app/docs/health.md' };

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/index.html' || uri.charAt(uri.length - 1) === '/') {
    request.uri = '/_app/index.html';
  } else if (Object.prototype.hasOwnProperty.call(PAGES, uri)) {
    request.uri = PAGES[uri];
  }
  return request;
}
