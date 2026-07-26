// Test ciblé du catalogue vidéos : chargement au boot, endpoint /videos,
// rechargement au lancement d'une partie (onStart), et gestion des erreurs.
const http = require('http');
const WebSocket = require('ws');

const CATALOG_PORT = 8140;
const GAME_PORT = 8141;
let failures = 0;
const check = (label, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (path) => new Promise((res, rej) => {
  http.get(`http://localhost:${GAME_PORT}${path}`, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});

// Catalogue mutable servi comme le ferait GitHub Pages / R2
let catalog = [{ id: 'boot_A' }, { id: 'boot_B' }];
let serveBroken = false;
const catalogServer = http.createServer((_req, res) => {
  if (serveBroken) { res.writeHead(500); return res.end('boom'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(catalog));
});

function client() {
  const ws = new WebSocket(`ws://localhost:${GAME_PORT}`);
  const q = [], w = [];
  ws.on('message', (raw, bin) => {
    const m = bin ? { type: 'binary' } : JSON.parse(raw);
    const r = w.shift(); if (r) r(m); else q.push(m);
  });
  const next = () => new Promise((r) => { if (q.length) r(q.shift()); else w.push(r); });
  return {
    ws, send: (o) => ws.send(JSON.stringify(o)),
    open: () => new Promise((r) => ws.on('open', r)),
    async nextType(t) { for (;;) { const m = await next(); if (m.type === t) return m; } },
  };
}

(async () => {
  await new Promise((r) => catalogServer.listen(CATALOG_PORT, r));

  process.env.VIDEOS_URL = `http://localhost:${CATALOG_PORT}/`;
  process.env.PORT = String(GAME_PORT);
  process.env.RECORD_GRACE_MS = '100';
  require('./src/server'); // démarre le serveur de jeu, refreshVideos() au boot
  await sleep(400);

  // 1. chargement au boot + endpoint /videos
  let v = await getJSON('/videos');
  check('boot: catalogue distant chargé (2 entrées)', v.count === 2 && v.videos.map((x) => x.id).join(',') === 'boot_A,boot_B');
  check('boot: pas d\'erreur signalée', v.lastError === null);

  // 2. on grossit le catalogue distant → une partie doit le recharger
  catalog = Array.from({ length: 6 }, (_, i) => ({ id: `vid_${i + 1}`, url: `https://cdn/vid_${i + 1}.mp4` }));

  const a = client(), b = client();
  await a.open(); await b.open();
  a.send({ action: 'join', name: 'A' });
  const ra = await a.nextType('room');
  b.send({ action: 'join', name: 'B', code: ra.code });
  await b.nextType('room');
  a.send({ action: 'start', rounds: 1 });
  const pw = await a.nextType('phase');
  check('onStart a rechargé le catalogue : vidéo hors des 2 du boot', /^vid_[1-6]$/.test(pw.video));
  check('l\'URL R2 est bien transmise au front', typeof pw.url === 'string' && pw.url.includes('cdn/'));

  v = await getJSON('/videos');
  check('endpoint /videos reflète les 6 entrées', v.count === 6);
  a.ws.close(); b.ws.close();

  // 3. catalogue distant cassé → on garde la dernière liste valide + on log l'erreur
  serveBroken = true;
  const c = client(), d = client();
  await c.open(); await d.open();
  c.send({ action: 'join', name: 'C' });
  const rc = await c.nextType('room');
  d.send({ action: 'join', name: 'D', code: rc.code });
  await d.nextType('room');
  c.send({ action: 'start', rounds: 1 });
  const pw2 = await c.nextType('phase');
  check('catalogue cassé: la partie démarre quand même (dernière liste valide)', /^vid_[1-6]$/.test(pw2.video));
  v = await getJSON('/videos');
  check('endpoint /videos expose lastError pour diagnostic', typeof v.lastError === 'string' && v.lastError.includes('HTTP 500'));
  check('catalogue conservé malgré l\'erreur (6 entrées)', v.count === 6);
  c.ws.close(); d.ws.close();

  await sleep(100);
  console.log(failures === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
