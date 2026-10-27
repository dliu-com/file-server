// CloudFront Function (cloudfront-js-2.0), viewer-request on the default behavior.
// Folder pages: "/", "/index.html" and any URL ending in "/" show the file browser, which reads the folder
// from the address bar. Everything else is a file in the bucket.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri === '/index.html' || uri.charAt(uri.length - 1) === '/') {
    request.uri = '/_app/index.html';
  }
  return request;
}
