const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const root = path.join(__dirname, '..', 'src');

function readSnapshot({ sourceRoot = root, scriptRoot = __dirname } = {}) {
  const files = {};
  for (const name of fs.readdirSync(sourceRoot).sort().filter(name => /\.(html|gs)$/.test(name))) {
    files[name] = fs.readFileSync(path.join(sourceRoot, name), 'utf8');
  }
  for (const name of ['preview-mock.js', 'preview-controls.html']) {
    files[name] = fs.readFileSync(path.join(scriptRoot, name), 'utf8');
  }
  return { files, revision: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

function renderPreview(options) {
  const { files, revision } = readSnapshot(options);
  const rules = vm.createContext({});
  vm.runInContext(files['DateValidation.gs'], rules);
  const html = files['Index.html']
    .replace(/<\?!= include_\('([A-Za-z]+)'\); \?>/g,
      (_, name) => (name === 'Api' ? '<script>' + files['preview-mock.js'] + '</script>\n' : '') + files[name + '.html'])
    .replace('<?!= includeDateRules_(); ?>', rules.includeDateRules_())
    .replace(/<link rel="manifest"[^>]*>/, '')
    .replace('<head>', `<head><title>今なにしてる・ローカルプレビュー</title><meta name="preview-revision" content="${revision}">`);
  // モックはDateRules配信後、Appの初期化より前に読み込む。
  return html.replace('<body>', '<body>' + files['preview-controls.html']);
}

function createPreviewServer(options) {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method !== 'GET' || !['/', '/index.html', '/__preview/revision'].includes(pathname)) {
      response.writeHead(404).end('見つかりません');
      return;
    }
    try {
      if (pathname === '/__preview/revision') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ revision: readSnapshot(options).revision }));
        return;
      }
      const html = renderPreview(options);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(html);
    } catch (error) {
      console.error(error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('プレビューの生成に失敗しました。端末のログを確認してください。');
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PREVIEW_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ポートは1〜65535で指定してください');
  const server = createPreviewServer();
  server.on('error', error => {
    console.error('プレビューを起動できませんでした:', error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`ローカルプレビュー: http://127.0.0.1:${port}`);
    console.log('保存するとブラウザを自動更新します。終了するには Ctrl+C を押してください。');
  });
}

module.exports = { renderPreview, createPreviewServer };
