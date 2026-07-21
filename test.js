// Test d'intégration : une partie complète à 3 joueurs avec de faux blobs audio,
// les tricheries qui doivent être refusées, et un abandon en cours de partie.
// Lancement (timings raccourcis via env) :
//   WATCH_MS=150 RECORD_MS=300 RECORD_GRACE_MS=200 LISTEN_GAP_MS=100 \
//   VOTE_MS=3000 RESULTS_MS=200 ROUNDS=1 PORT=8124 node src/server.js &
//   PORT=8124 node test.js
const WebSocket = require('ws');

const URL = 'ws://localhost:' + (process.env.PORT || 8124);
let failures = 0;
const check = (label, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label);
  if (!cond) failures++;
};

function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw, isBinary) => {
    const msg = isBinary ? { type: 'binary', buf: raw } : JSON.parse(raw);
    const w = waiters.shift();
    if (w) w(msg); else queue.push(msg);
  });
  const next = () => new Promise((res) => {
    if (queue.length) return res(queue.shift());
    waiters.push(res);
  });
  return {
    ws,
    send: (o) => ws.send(JSON.stringify(o)),
    sendBin: (b) => ws.send(b),
    open: () => new Promise((res) => ws.on('open', res)),
    next,
    async nextType(type) { // consomme jusqu'au prochain message du type voulu
      for (;;) {
        const m = await next();
        if (m.type === type) return m;
      }
    },
  };
}

(async () => {
  // ---------- lobby ----------
  const a = client(), b = client(), c = client();
  await a.open(); await b.open(); await c.open();

  a.send({ action: 'join', name: 'Mathys' });
  let ra = await a.nextType('room');
  check('host reçoit son état de room', /^[A-Z2-9]{4}$/.test(ra.code) && ra.players.length === 1);
  check('le créateur est host', ra.players[0].host === true);
  const code = ra.code, idA = ra.you;

  b.send({ action: 'join', name: 'Bob', code: code.toLowerCase() });
  const rb = await b.nextType('room');
  const idB = rb.you;
  c.send({ action: 'join', name: 'Chloé', code });
  const rc = await c.nextType('room');
  const idC = rc.you;
  check('3 joueurs dans la room', rc.players.length === 3);

  b.send({ action: 'start' });
  let e = await b.nextType('error');
  check('start refusé aux non-hosts', e.message === 'seul le host peut lancer');

  // ---------- watching ----------
  a.send({ action: 'start' });
  const pa = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('phase watching avec un ID vidéo', pa.phase === 'watching' && /^vid_\d+$/.test(pa.video));
  check('compteur de rounds fourni', pa.round === 1 && pa.of >= 1);

  // ---------- recording ----------
  const rec = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('phase recording avec deadline', rec.phase === 'recording' && rec.deadline > Date.now());

  c.sendBin(Buffer.from('X'));
  e = await c.nextType('error');
  check('binaire sans méta refusé', e.message === 'méta audio manquante');

  a.send({ action: 'vote', for: idB });
  e = await a.nextType('error');
  check('vote pendant recording refusé', e.message === "ce n'est pas le moment de voter");

  a.send({ action: 'audio-meta', mime: 'audio/mp4' });
  a.sendBin(Buffer.from('AUDIO_A'));
  b.send({ action: 'audio-meta', mime: 'audio/webm' });
  b.sendBin(Buffer.from('AUDIO_B'));
  b.send({ action: 'audio-meta', mime: 'audio/webm' });
  b.sendBin(Buffer.from('AUDIO_B2'));
  e = await b.nextType('error');
  check('double prise refusée', e.message === 'prise déjà reçue');
  c.send({ action: 'audio-meta', mime: 'audio/mp4' });
  c.sendBin(Buffer.from('AUDIO_C'));

  // ---------- broadcasting ----------
  const br = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('broadcast anticipé quand tout le monde a rendu', br.phase === 'broadcasting' && br.count === 3);

  const heard = [];
  for (let i = 0; i < 3; i++) {
    const meta = await a.nextType('listen');
    const bin = await a.nextType('binary');
    heard.push({ name: meta.name, mime: meta.mime, data: bin.buf.toString() });
    await b.nextType('listen'); await b.nextType('binary'); // les autres reçoivent pareil
    await c.nextType('listen'); await c.nextType('binary');
  }
  const datas = heard.map((h) => h.data).sort();
  check('les 3 prises sont rediffusées intactes', JSON.stringify(datas) === JSON.stringify(['AUDIO_A', 'AUDIO_B', 'AUDIO_C']));
  check('le mime suit chaque prise', heard.every((h) => h.mime.startsWith('audio/')));

  // ---------- voting ----------
  const vo = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('phase voting avec 3 candidats', vo.phase === 'voting' && vo.candidates.length === 3);

  a.send({ action: 'vote', for: idA });
  e = await a.nextType('error');
  check('vote pour soi-même refusé', e.message === 'pas pour toi-même');

  a.send({ action: 'vote', for: idB });
  b.send({ action: 'vote', for: idA });
  c.send({ action: 'vote', for: idA });

  // ---------- results & end ----------
  const rs = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('résultats dès que tout le monde a voté', rs.phase === 'results');
  const vA = rs.votes.find((v) => v.id === idA), vB = rs.votes.find((v) => v.id === idB);
  check('décompte des voix correct (A=2, B=1)', vA.votes === 2 && vB.votes === 1);
  check('scores cumulés et triés', rs.scores[0].id === idA && rs.scores[0].score === 2);

  const end = await a.nextType('phase');
  check('fin de partie avec podium', end.phase === 'end' && end.podium[0].id === idA);

  a.ws.close(); b.ws.close(); c.ws.close();

  // ---------- abandon en cours de partie ----------
  const d = client(), f = client();
  await d.open(); await f.open();
  d.send({ action: 'join', name: 'Dan' });
  const rd = await d.nextType('room');
  f.send({ action: 'join', name: 'Fred', code: rd.code });
  await f.nextType('room');
  d.send({ action: 'start' });
  await d.nextType('phase'); await f.nextType('phase'); // watching
  f.ws.close();
  e = await d.nextType('error');
  check('abandon → retour au lobby annoncé', e.message.includes('plus assez de joueurs'));
  const rl = await d.nextType('room');
  check('la room repasse en lobby', rl.phase === 'lobby' && rl.players.length === 1);
  d.ws.close();

  console.log(failures === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
