// Test d'intégration v2 : partie complète à 3 joueurs - prises multiples (remplacement),
// notation +2/+1/-1 par prise, scoreboard live, tricheries refusées, abandon.
// Lancement (timings raccourcis via env) :
//   VIDEOS_URL= WATCH_MS=150 RECORD_MS=400 RECORD_GRACE_MS=150 LISTEN_MS=1500 \
//   RESULTS_MS=200 ROUNDS=1 PORT=8124 node src/server.js &
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
  const ra = await a.nextType('room');
  check('host reçoit son état de room', /^[A-Z2-9]{4}$/.test(ra.code) && ra.players.length === 1);
  const code = ra.code, idA = ra.you;

  b.send({ action: 'join', name: 'Bob', code });
  const rb = await b.nextType('room');
  const idB = rb.you;
  c.send({ action: 'join', name: 'Chloé', code });
  const rc = await c.nextType('room');
  const idC = rc.you;
  check('3 joueurs dans la room', rc.players.length === 3);

  // ---------- watching ----------
  a.send({ action: 'start' });
  const pw = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('watching : vidéo + durée fournies', pw.phase === 'watching' && /^vid_\d+$/.test(pw.video) && pw.dur > 0);

  // ---------- recording ----------
  const pr = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('recording : la vidéo à rejouer est indiquée', pr.phase === 'recording' && pr.video === pw.video);

  a.send({ action: 'rate', value: 2 });
  let e = await a.nextType('error');
  check('noter pendant recording refusé', e.message === "ce n'est pas le moment de noter");

  // A envoie une prise, puis la REFAIT : la seconde doit remplacer la première, sans erreur
  a.send({ action: 'audio-meta', mime: 'audio/mp4' });
  a.sendBin(Buffer.from('AUDIO_A_v1'));
  a.send({ action: 'audio-meta', mime: 'audio/mp4' });
  a.sendBin(Buffer.from('AUDIO_A_v2'));
  b.send({ action: 'audio-meta', mime: 'audio/webm' });
  b.sendBin(Buffer.from('AUDIO_B'));
  c.send({ action: 'audio-meta', mime: 'audio/mp4' });
  c.sendBin(Buffer.from('AUDIO_C'));

  // ---------- rating : 3 prises, notées une par une ----------
  const pk = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('phase rating avec 3 prises', pk.phase === 'rating' && pk.count === 3);

  const heardByA = [];
  const scoresAfter = {}; // scores broadcastés après chaque prise
  for (let i = 0; i < 3; i++) {
    const mA = await a.nextType('listen');
    const bin = await a.nextType('binary');
    await b.nextType('listen'); await b.nextType('binary');
    await c.nextType('listen'); await c.nextType('binary');
    heardByA.push({ ...mA, data: bin.buf.toString() });

    const owner = mA.player;
    const raters = { [idA]: a, [idB]: b, [idC]: c };
    const ownerClient = raters[owner];
    delete raters[owner];
    const [r1, r2] = Object.values(raters);

    if (i === 0) { // tricheries testées sur la première prise uniquement
      ownerClient.send({ action: 'rate', value: 2 });
      e = await ownerClient.nextType('error');
      check('noter sa propre prise refusé', e.message === 'pas ta propre imitation');
      r1.send({ action: 'rate', value: 5 });
      e = await r1.nextType('error');
      check('note invalide refusée', e.message === 'note invalide');
      r1.send({ action: 'rate', value: 2 });
      r1.send({ action: 'rate', value: 1 });
      e = await r1.nextType('error');
      check('double note refusée', e.message === 'déjà noté');
    } else {
      r1.send({ action: 'rate', value: 2 });
    }
    r2.send({ action: 'rate', value: i === 2 ? -1 : 1 }); // dernière prise : 👍×2 + 👎

    const sc = await a.nextType('scores');
    await b.nextType('scores'); await c.nextType('scores');
    scoresAfter[owner] = sc.scores.find((s) => s.id === owner).score;
  }

  const datas = heardByA.map((h) => h.data).sort();
  check('la prise refaite a bien remplacé la première', JSON.stringify(datas) === JSON.stringify(['AUDIO_A_v2', 'AUDIO_B', 'AUDIO_C']));
  check('compteur idx/of cohérent', heardByA.every((h, i) => h.idx === i + 1 && h.of === 3));
  check('chaque listen référence la vidéo du round', heardByA.every((h) => h.video === pw.video));

  const lastOwner = heardByA[2].player;
  const expectLast = 2 - 1; // 👍×2 + 👎
  check('scoreboard live : +2+1 sur les 2 premières, +1 sur la dernière',
    heardByA.slice(0, 2).every((h) => scoresAfter[h.player] === 3) && scoresAfter[lastOwner] === expectLast);

  // ---------- results & end ----------
  const rs = await a.nextType('phase');
  check('phase results avec scores triés', rs.phase === 'results' && rs.scores[0].score >= rs.scores[2].score);

  const end = await a.nextType('phase');
  check('fin de partie avec podium', end.phase === 'end' && end.podium.length === 3);

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
  d.ws.close();

  console.log(failures === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
