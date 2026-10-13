// Local static server using the Node.js runtime already required by the tests.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 8777);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Informe uma porta válida entre 1 e 65535.');
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let file;
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const local = relative(root, file);
    if (isAbsolute(local) || local === '..' || local.startsWith('..' + sep)
        || local.split(sep).some(part => part.startsWith('.'))) {
      res.writeHead(403).end('Acesso negado.');
      return;
    }
  } catch {
    res.writeHead(400).end('Endereço inválido.');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end('Arquivo não encontrado.');
  }
});

server.on('error', err => {
  console.error(err.code === 'EADDRINUSE'
    ? `A porta ${port} já está em uso. Tente abrir http://127.0.0.1:${port}/ ou escolha outra porta.`
    : `Não foi possível iniciar o servidor: ${err.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`FluidLab em português: ${url}`);
  console.log('Mantenha esta janela aberta. Para encerrar, pressione Ctrl+C.');
  if (process.argv.includes('--open') && process.platform === 'win32') {
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, err => {
      if (err) console.log(`Abra este endereço no navegador: ${url}`);
    });
  }
});
