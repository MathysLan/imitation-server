// Test d'intégration v3 : la partie est pilotée par le host (action 'next'),
// plus aucun timer de gameplay. Prises multiples, notation, skip d'imitation,
// tricheries refusées, abandon.
// Lancement :
//   VIDEOS_URL= RECORD_GRACE_MS=200 ROUNDS=1 PORT=8124 node src/server.js &
//   PORT=8124 node test.js
const WebSocket = require('ws');

const URL = 'ws://localhost:' + (process.env.PORT || 8124);
let failures = 0;
const check = (label, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + label);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    queue,
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

  a.send({ action: 'join', name: 'Mathys', avatar: '🔥' });
  const ra = await a.nextType('room');
  const code = ra.code, idA = ra.you;
  b.send({ action: 'join', name: 'Bob', code });
  const rb = await b.nextType('room');
  const idB = rb.you;
  c.send({ action: 'join', name: 'Chloé', code });
  const rc = await c.nextType('room');
  const idC = rc.you;
  check('3 joueurs dans la room', rc.players.length === 3);
  check('avatar transmis dans la room', rc.players.find((p) => p.id === idA).avatar === '🔥');

  // draine les états de room hérités des joins de B et C avant de tester « prêt »
  await a.nextType('room'); await a.nextType('room'); await b.nextType('room');

  b.send({ action: 'ready', ready: true });
  const rr = await a.nextType('room');
  await b.nextType('room'); await c.nextType('room');
  check('« prêt » visible par tout le monde', rr.players.find((p) => p.id === idB).ready === true);

  b.send({ action: 'next' });
  let e = await b.nextType('error');
  check("'next' refusé aux non-hosts", e.message === 'seul le host peut passer');

  // ---------- watching : n'avance QUE sur ordre du host ----------
  a.send({ action: 'start', rounds: 1 });
  const pw = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('watching : vidéo fournie (id, url optionnelle)', pw.phase === 'watching' && /^vid_\d+$/.test(pw.video) && 'url' in pw);
  check('nombre de manches choisi par le host respecté', pw.of === 1);

  await sleep(400);
  check('pas d\'avance automatique sans le host', a.queue.length === 0);

  a.send({ action: 'next' });
  const pr = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('next → recording', pr.phase === 'recording' && pr.video === pw.video);
  const rrec = await a.nextType('room');
  await b.nextType('room'); await c.nextType('room');
  check('« prêt » remis à zéro en phase recording', rrec.players.every((p) => p.ready === false));

  // ---------- recording : prises (avec remplacement), clôture par le host ----------
  a.send({ action: 'audio-meta', mime: 'audio/mp4' });
  a.sendBin(Buffer.from('AUDIO_A_v1'));
  a.send({ action: 'audio-meta', mime: 'audio/mp4' });
  a.sendBin(Buffer.from('AUDIO_A_v2'));
  b.send({ action: 'audio-meta', mime: 'audio/webm' });
  b.sendBin(Buffer.from('AUDIO_B'));

  a.send({ action: 'next' }); // le host clôt
  const h = await a.nextType('hurry');
  await b.nextType('hurry'); await c.nextType('hurry');
  check('hurry diffusé à tous', h.type === 'hurry');

  // C envoie sa prise PENDANT la grâce d'upload : elle doit être acceptée
  c.send({ action: 'audio-meta', mime: 'audio/mp4' });
  c.sendBin(Buffer.from('AUDIO_C'));

  const pk = await a.nextType('phase');
  await b.nextType('phase'); await c.nextType('phase');
  check('rating avec 3 prises (celle de la grâce comprise)', pk.phase === 'rating' && pk.count === 3);

  // ---------- rating : les notes ne coupent rien, SEUL le host fait avancer ----------
  const heard = [];
  for (let i = 0; i < 3; i++) {
    const mA = await a.nextType('listen');
    const bin = await a.nextType('binary');
    await b.nextType('listen'); await b.nextType('binary');
    await c.nextType('listen'); await c.nextType('binary');
    heard.push({ ...mA, data: bin.buf.toString() });

    const owner = mA.player;
    const clients = { [idA]: a, [idB]: b, [idC]: c };
    const raters = Object.entries(clients).filter(([id]) => id !== owner).map(([, cl]) => cl);

    if (i === 1) {
      raters[0].send({ action: 'rate', value: 2 }); // note partielle : le host passera quand même
      const rd = await a.nextType('rated');
      await b.nextType('rated'); await c.nextType('rated');
      check('avancement des votes diffusé (1/2)', rd.count === 1 && rd.of === 2);
    } else {
      raters[0].send({ action: 'rate', value: 2 });
      raters[1].send({ action: 'rate', value: 1 });
      await a.nextType('rated'); const rd2 = await a.nextType('rated');
      await b.nextType('rated'); await b.nextType('rated');
      await c.nextType('rated'); await c.nextType('rated');
      if (i === 0) check('avancement des votes diffusé (2/2)', rd2.count === 2 && rd2.of === 2);
    }

    await sleep(300);
    check(`prise ${i + 1} : tous les votes reçus mais PAS d'avance automatique`, a.queue.length === 0);

    a.send({ action: 'next' }); // le host passe à la suivante
    const sc = await a.nextType('scores');
    await b.nextType('scores'); await c.nextType('scores');
    const expected = i === 1 ? 2 : 3;
    check(`prise ${i + 1} : score appliqué (${expected})`, sc.scores.find((s) => s.id === owner).score === expected);
  }

  const datas = heard.map((x) => x.data).sort();
  check('remplacement de prise OK et audios intacts', JSON.stringify(datas) === JSON.stringify(['AUDIO_A_v2', 'AUDIO_B', 'AUDIO_C']));

  // ---------- results : attend le host, puis fin ----------
  const rs = await a.nextType('phase');
  check('phase results (sans timer)', rs.phase === 'results');
  await sleep(300);
  check('results n\'avance pas sans le host', a.queue.length === 0);

  a.send({ action: 'next' }); // ROUNDS=1 → fin de partie
  const end = await a.nextType('phase');
  check('next depuis results → podium', end.phase === 'end' && end.podium.length === 3);

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
