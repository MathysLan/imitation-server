// Test WebSocket RÉEL de la photo de profil : de vrais clients `ws` rejoignent
// une room, jouent une manche, et on lit ce qui passe VRAIMENT sur le fil.
//
//   VIDEOS_URL= RECORD_GRACE_MS=200 ROUNDS=1 PORT=8124 node src/server.js &
//   PORT=8124 node test-avatar-ws.js
//
// Ce que ce test prouve, et que « la connexion a réussi » ne prouverait pas :
// la data-URL envoyée par A ressort À L'OCTET PRÈS chez B (lobby, écoute de sa
// prise, résultats, podium), l'emoji de B ressort chez A, et chaque avatar
// refusé (SVG, > 12 Ko, mauvais type, structure) ressort en emoji sans `src`.
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const URL = 'ws://localhost:' + (process.env.PORT || 8124);
const DEFAUT = '🙂';                  // l'emoji par défaut de CE serveur
let ok = 0, ko = 0;
const t = (name, cond, detail) => {
  if (cond) { ok++; console.log('PASS - ' + name); }
  else { ko++; console.log('FAIL - ' + name + (detail ? ' — ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fx = (f) => fs.readFileSync(path.join(__dirname, 'test-fixtures', f));
const PP = 'data:image/webp;base64,' + fx('avatar-96.webp').toString('base64');
const IMG_A = { kind: 'image', emoji: '🦊', src: PP };
const EMO_B = { kind: 'emoji', emoji: '🐼' };

// Un client qui garde tout ce qu'il reçoit, et la taille brute de chaque trame.
function client() {
  const ws = new WebSocket(URL);
  const c = { ws, log: [], used: new Set(), bytes: 0, waiters: [] };
  ws.on('message', (raw, isBinary) => {
    c.bytes += raw.length;
    const m = isBinary ? { type: 'binary', buf: raw } : JSON.parse(raw);
    m.__len = raw.length;
    c.log.push(m);
    c.waiters.slice().forEach((w) => w());
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.sendBin = (b) => ws.send(b);
  c.open = () => (ws.readyState === 1 ? Promise.resolve() : new Promise((r) => ws.once('open', r)));
  // Le prochain message pas encore consommé qui satisfait `pred`.
  c.wait = (pred, ms = 5000) => new Promise((resolve, reject) => {
    const look = () => {
      const i = c.log.findIndex((m, k) => !c.used.has(k) && pred(m));
      if (i < 0) return false;
      c.used.add(i); c.waiters = c.waiters.filter((w) => w !== look); resolve(c.log[i]); return true;
    };
    if (look()) return;
    c.waiters.push(look);
    setTimeout(() => reject(new Error('attente expirée')), ms);
  });
  return c;
}
const type = (ty) => (m) => m.type === ty;
const phase = (p) => (m) => m.type === 'phase' && m.phase === p;
const find = (list, id) => (list || []).find((p) => p.id === id) || {};

async function join(c, avatar, code) {
  await c.open();
  const msg = { action: 'join', name: 'J' + Math.random().toString(36).slice(2, 5) };
  if (avatar !== undefined) msg.avatar = avatar;
  if (code) msg.code = code;
  c.send(msg);
  const r = await c.wait(type('room'));
  return { id: r.you, code: r.code, players: r.players };
}

(async () => {
  // ═══ 1. A (vraie PP) crée la room, B (emoji) la rejoint
  const a = client(), b = client();
  const ja = await join(a, IMG_A);
  t('join avec image : A est bien dans la room', !!ja.id);
  t('A se voit lui-même avec sa PP (état joueur)', same(find(ja.players, ja.id).avatar, IMG_A));
  const jb = await join(b, EMO_B, ja.code);
  t('join avec emoji : B est bien dans la room', !!jb.id);

  t('B voit la PP de A, data-URL identique à l\'octet près', find(jb.players, ja.id).avatar?.src === PP);
  t('B voit l\'avatar de A complet et rien d\'autre', same(find(jb.players, ja.id).avatar, IMG_A),
    JSON.stringify(Object.keys(find(jb.players, ja.id).avatar || {})));
  t('B se voit avec son emoji', same(find(jb.players, jb.id).avatar, EMO_B));
  const ra = await a.wait((m) => m.type === 'room' && m.players.length === 2);
  t('A voit l\'emoji de B', same(find(ra.players, jb.id).avatar, EMO_B));
  t('A voit toujours sa propre PP après l\'arrivée de B', same(find(ra.players, ja.id).avatar, IMG_A));
  t('la liste ne contient que les champs publics (pas de ws ni d\'état interne)',
    ra.players.every((p) => same(Object.keys(p).sort(), ['avatar', 'host', 'id', 'name', 'ready', 'score'])),
    JSON.stringify(Object.keys(ra.players[0])));
  t(`taille du message room avec une PP : ${ra.__len} octets (la PP n'y est qu'une fois)`,
    ra.__len < PP.length + 600 && ra.__len > PP.length);

  // ═══ 2. une vraie manche : A enregistre une prise, on l'écoute
  a.send({ action: 'start', rounds: 1 });
  await a.wait(phase('watching')); await b.wait(phase('watching'));
  a.send({ action: 'next' });
  await a.wait(phase('recording')); await b.wait(phase('recording'));
  a.send({ action: 'audio-meta', mime: 'audio/webm' });
  a.sendBin(Buffer.from('PRISE_DE_A'));
  a.send({ action: 'next' });
  await b.wait(phase('rating'));
  const ecoute = await b.wait(type('listen'));
  t('en jeu (écoute de la prise) : B reçoit la PP de A', ecoute.player === ja.id && same(ecoute.avatar, IMG_A));
  b.send({ action: 'rate', value: 2 });
  a.send({ action: 'next' });
  const sc = await b.wait(type('scores'));
  t('en jeu (scores live) : PP de A et emoji de B', same(find(sc.scores, ja.id).avatar, IMG_A) && same(find(sc.scores, jb.id).avatar, EMO_B));
  const res = await b.wait(phase('results'));
  t('résultats : PP de A retransmise', same(find(res.scores, ja.id).avatar, IMG_A));
  a.send({ action: 'next' });
  const end = await b.wait(phase('end'));
  t('podium : PP de A retransmise, emoji de B conservé',
    same(find(end.podium, ja.id).avatar, IMG_A) && same(find(end.podium, jb.id).avatar, EMO_B));
  a.ws.close(); b.ws.close();

  // ═══ 3. ce que le serveur refuse : chaque cas crée sa propre room
  const LOURDE = 'data:image/webp;base64,' + fx('avatar-13k.webp').toString('base64');
  const CAS = [
    ['image > 12 Ko (vrai webp de 12,9 Ko) refusée → emoji', { kind: 'image', emoji: '🐸', src: LOURDE }, '🐸'],
    ['SVG refusé → emoji', { kind: 'image', emoji: '🐸', src: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>').toString('base64') }, '🐸'],
    ['type MIME inattendu (gif) refusé → emoji', { kind: 'image', emoji: '🐸', src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }, '🐸'],
    ['png déguisé en webp refusé → emoji', { kind: 'image', emoji: '🐸', src: 'data:image/webp;base64,' + fx('avatar-96.png').toString('base64') }, '🐸'],
    ['kind inconnu refusé → emoji', { kind: 'video', emoji: '🐸', src: PP }, '🐸'],
    ['avatar mal formé (tableau) → emoji par défaut', [PP], DEFAUT],
    ['avatar mal formé (nombre) → emoji par défaut', 42, DEFAUT],
    ['avatar absent → emoji par défaut', undefined, DEFAUT],
    ['ancien client (emoji en chaîne) → accepté', '🔥', '🔥'],
    ['ancien client (data-URL en chaîne) → pas tronquée, défaut', PP, DEFAUT],
  ];
  for (const [nom, avatar, attendu] of CAS) {
    const c = client();
    const j = await join(c, avatar);
    const av = find(j.players, j.id).avatar;
    t(nom, same(av, { kind: 'emoji', emoji: attendu }), JSON.stringify(av).slice(0, 100));
    c.ws.close();
  }

  // Et un refus ne casse rien pour les autres : C (SVG) rejoint A' (PP).
  const a2 = client(), c2 = client();
  const j2 = await join(a2, IMG_A);
  await join(c2, { kind: 'image', emoji: '🐸', src: 'data:image/svg+xml;base64,PHN2Zy8+' }, j2.code);
  const vu = await a2.wait((m) => m.type === 'room' && m.players.length === 2);
  t('un avatar refusé n\'affecte pas la PP des autres', same(find(vu.players, j2.id).avatar, IMG_A));
  t('le joueur refusé est bien dans la room, avec son emoji',
    vu.players.some((p) => p.id !== j2.id && same(p.avatar, { kind: 'emoji', emoji: '🐸' })));
  a2.ws.close(); c2.ws.close();

  console.log(ko === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${ko} ÉCHEC(S)`);
  process.exit(ko === 0 ? 0 : 1);
})().catch((e) => { console.log('FAIL - exception : ' + e.message); process.exit(1); });
