const fs = require('fs');
const tabs = ['tasks', 'goals', 'gym', 'health', 'nutrition', 'finance'];
for (const t of tabs) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Redirecting…</title>
<meta name="robots" content="noindex">
<script>
// This page is now a section of the single-page dashboard. Forward any deep link
// (sub-section hash and/or query string) into index.html, replacing history so
// Back does not bounce here.
(function () {
  var sub = (location.hash || '').replace(/^#/, '');
  var search = location.search || '';
  var target = 'index.html#${t}' + (sub ? '/' + sub : '');
  if (search) target += (target.indexOf('?') < 0 ? '?' : '&') + search.slice(1);
  location.replace(target);
})();
</script>
</head>
<body></body>
</html>
`;
  fs.writeFileSync(t + '.html', html, 'utf8');
  console.log('wrote stub: ' + t + '.html');
}
