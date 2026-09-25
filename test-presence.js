// Présence applicative (presence.js), contre un VRAI serveur lancé ici avec des
// délais très courts. Même fichier dans chaque dépôt serveur : il trouve seul
// le serveur (src/server.js ou server.js) et parle les deux dialectes de salon
// (`room`, ou `you` + `lobby`).
//
//   node test-presence.js
//
// Vérifié : un client qui répond reste présent, même silencieux ; un adhérent
// qui ne répond plus (onglet gelé : son pong NATIF part toujours) est fermé en
// 4000 'absent' et les autres reçoivent le salon à jour ; un ancien client
// n'est jamais expulsé ; un message de présence, valide ou non, n'est jamais
// traité par le jeu ; une coupure réseau franche est coupée (terminate / ping
// natif) ; une nouvelle connexion REMPLACE l'ancienne sans doublon ; et, pour
// un serveur qui reçoit de l'audio, le sursis pendant l'envoi.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const SERVEUR = fs.existsSync(path.join(__dirname, 'src', 'server.js')) ? 'src/server.js' : 'server.js';
const AUDIO = fs.readFileSync(path.join(__dirname, SERVEUR), 'utf8').includes("'audio-meta'");
const PORT = 8400 + Math.floor(Math.random() * 300);
const ENV = { PRESENCE_MS: '200', ABSENCE_MS: '700', NATIVE_PING_MS: '400', PRESENCE_KILL_MS: '300', PRESENCE_HOLD_MS: '2500', PRESENCE_QUIET: '1',
  // Aucun réseau sortant : catalogues de secours (Imitation, Ban).
  VIDEOS_URL: '', VIDEOS_JSON: '[{"id":"v","fatal":1.0,"startAt":0}]' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ko = 0, n = 0;
const t = (nom, ok, detail = '') => { n++; if (!ok) ko++; console.log(`${ok ? 'OK  ' : 'KO  '} ${nom}${detail ? ' — ' + detail : ''}`); };

const estSalon = (m) => (m.type === 'room' || m.type === 'lobby') && Array.isArray(m.players);

function client({ repond = true, autoPong = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { autoPong });
  const c = { ws, msgs: [], repond, ferme: null };
  ws.on('message', (raw, bin) => {
    if (bin) return;
    const m = JSON.parse(raw);
    c.msgs.push(m);
    if (m.type === 'presence' && m.remplace !== true && c.repond) ws.send(JSON.stringify({ action: 'presence', n: m.n }));
  });
  ws.on('close', (code, why) => { c.ferme = { code, raison: String(why) }; });
  c.open = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.wait = async (p, ms = 4000, depuis = 0) => { const f = Date.now() + ms; while (Date.now() < f) { const m = c.msgs.slice(depuis).find(p); if (m) return m; await sleep(20); } return null; };
  c.suite = (p, ms) => c.wait(p, ms, c.msgs.length);
  c.salon = () => [...c.msgs].reverse().find(estSalon);
  c.moi = () => { const m = [...c.msgs].reverse().find((x) => (x.type === 'room' && x.you) || x.type === 'you'); return m ? (m.you || m.id) : null; };
  c.code = () => { const m = [...c.msgs].reverse().find((x) => x.code && (x.type === 'room' || x.type === 'you')); return m ? m.code : null; };
  c.erreurs = () => c.msgs.filter((m) => m.type === 'error').map((m) => m.message);
  return c;
}
const join = (c, name, code) => c.send(code ? { action: 'join', name, code, avatar: { kind: 'emoji', emoji: '🎯' } } : { action: 'join', name, avatar: { kind: 'emoji', emoji: '🎯' } });
const nb = (k) => (m) => estSalon(m) && m.players.length === k;

async function demarrer(port, env) {
  const srv = spawn(process.execPath, [SERVEUR], { cwd: __dirname, env: { ...process.env, PORT: String(port), ...ENV, ...env }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await new Promise((res, rej) => { const s = new WebSocket(`ws://127.0.0.1:${port}`); s.on('open', () => { s.close(); res(); }); s.on('error', rej); }); break; } catch (_) { await sleep(100); } }
  return srv;
}

(async () => {
  console.log(`présence — ${path.basename(__dirname)} (${SERVEUR}${AUDIO ? ', audio' : ''})\n`);
  const srv = await demarrer(PORT, {});
  const tous = [];
  try {
    // ── 1. deux joueurs qui répondent : ils restent, même sans rien jouer
    const A = client(), B = client(); tous.push(A, B);
    await A.open; await B.open;
    t('premier message reçu : le ping de présence, dès la connexion, avec sa clé', !!(await A.wait((m) => m.type === 'presence')) && A.msgs[0].type === 'presence' && typeof A.msgs[0].cle === 'string');
    join(A, 'Alice');
    await A.wait(estSalon);
    const code = A.code();
    join(B, 'Bruno', code);
    await A.wait(nb(2));
    await sleep(3500);   // 5 × ABSENCE_MS
    t('deux clients qui répondent, silencieux côté jeu : toujours là après 5 × ABSENCE_MS', !A.ferme && !B.ferme && A.salon().players.length === 2);
    t('aucun message de présence ne produit d\'erreur de jeu', A.erreurs().length === 0 && B.erreurs().length === 0, JSON.stringify(A.erreurs().concat(B.erreurs())));

    // ── 2. B ne répond plus (onglet gelé : le pong natif, lui, part toujours)
    B.repond = false;
    const t0 = Date.now();
    await A.suite(nb(1), 3000);
    const d = Date.now() - t0;
    await sleep(100);
    t('B ne répond plus : fermé en 4000 « absent », malgré ses pongs natifs', !!B.ferme && B.ferme.code === 4000 && B.ferme.raison === 'absent', JSON.stringify(B.ferme));
    t(`A reçoit aussitôt le salon à jour : 1 joueur (${d} ms)`, A.salon().players.length === 1 && d < 700 + 200 + 800);

    // ── 3. un ANCIEN client, qui ignore la présence : jamais expulsé
    const C = client({ repond: false }); tous.push(C);
    await C.open;
    join(C, 'Ancien', code);
    await A.suite(nb(2));
    await sleep(3500);
    t('ancien client (aucune réponse de présence) : jamais expulsé', !C.ferme && A.salon().players.length === 2);

    // ── 4. présence invalide : avalée, sans erreur ni adhésion
    for (const k of [0, 'x', -1, 1.5, 999999999, null]) C.send({ action: 'presence', n: k });
    C.send({ action: 'presence' });
    await sleep(300);
    t('présence valide ou non : jamais d\'erreur du jeu (ni « action inconnue », ni « pas encore dans une partie »)', C.erreurs().length === 0, JSON.stringify(C.erreurs()));
    const D = client({ repond: false }); tous.push(D);
    await D.open;
    D.send({ action: 'presence', n: 'x' });
    await sleep(100);
    t('présence envoyée AVANT le join : aucune erreur non plus', D.erreurs().length === 0, JSON.stringify(D.erreurs()));
    C.ws.close(); D.ws.close();
    await A.suite(nb(1));

    // ── 5. coupure franche d'un adhérent, puis d'un non-adhérent
    const F = client(); tous.push(F);
    await F.open; join(F, 'Coupé', code);
    await A.suite(nb(2)); await sleep(300);
    F.ws._socket.pause();
    const t1 = Date.now();
    await A.suite(nb(1), 4000);
    t(`coupure franche (adhérent) : retiré en ${Date.now() - t1} ms`, A.salon().players.length === 1);
    const G = client({ repond: false, autoPong: false }); tous.push(G);
    await G.open; join(G, 'Muet', code);
    await A.suite(nb(2));
    const t2 = Date.now();
    await A.suite(nb(1), 3000);
    t(`ancien client au réseau mort : coupé par le ping natif en ${Date.now() - t2} ms`, A.salon().players.length === 1);

    // ── 6. REMPLACEMENT : jamais deux fois le même joueur
    const X = client(); tous.push(X);
    await X.open;
    const cleX = (await X.wait((m) => m.type === 'presence' && m.cle)).cle;
    join(X, 'Xavier', code);
    await A.suite(nb(2));
    const idX = X.moi();
    t('la clé de connexion n\'est envoyée qu\'à son propriétaire', !JSON.stringify(A.msgs).includes(cleX));
    X.ws._socket.pause();
    await sleep(100);
    const mA = A.msgs.length;
    const X2 = client({ repond: false }); tous.push(X2);
    await X2.open;
    const p0 = await X2.wait((m) => m.type === 'presence' && m.cle);
    X2.send({ action: 'presence', n: p0.n, remplace: cleX });
    const ack = await X2.wait((m) => m.type === 'presence' && m.remplace === true, 3000);
    const retire = A.msgs.slice(mA).some((m) => estSalon(m) && !m.players.some((p) => p.id === idX));
    t('remplacement : l\'ancienne connexion est retirée du salon AVANT l\'acquittement', !!ack && retire);
    X2.repond = true;
    join(X2, 'Xavier', code);
    await A.suite(nb(2));
    const idX2 = X2.moi();
    const salons = A.msgs.slice(mA).filter(estSalon);
    const doublon = salons.some((m) => m.players.some((p) => p.id === idX) && m.players.some((p) => p.id === idX2));
    t('… puis le join : AUCUN salon diffusé avec l\'ancienne ET la nouvelle connexion', !doublon && Math.max(...salons.map((m) => m.players.length)) === 2, `${idX} → ${idX2}`);
    X2.ws.close();
    await A.suite(nb(1));

    // ── 7. (serveurs audio) sursis pendant l'envoi d'une prise
    if (AUDIO) {
      const H = client(); tous.push(H);
      await H.open; join(H, 'Hugo', code);
      await A.suite(nb(2)); await sleep(300);
      H.send({ action: 'audio-meta', mime: 'audio/webm', size: 1000 });   // puis plus rien : l'envoi « dure »
      H.repond = false;
      await sleep(1800);    // > ABSENCE_MS + PRESENCE_MS, < PRESENCE_HOLD_MS
      t('audio annoncé (audio-meta) puis silence : le sursis le garde pendant l\'envoi', !H.ferme && A.salon().players.length === 2);
      await A.suite(nb(1), 3500);
      t('… et, le sursis écoulé sans rien recevoir, il est retiré comme un absent', !!H.ferme && H.ferme.code === 4000, JSON.stringify(H.ferme));
    }
  } catch (e) {
    t('EXCEPTION', false, e.stack || e.message);
  } finally {
    for (const c of tous) { try { c.ws.terminate(); } catch (_) {} }
    srv.kill();
  }
  console.log(`\n${ko ? `${ko} test(s) échoué(s)` : 'TOUS LES TESTS PASSENT'} — ${n} vérifications`);
  process.exit(ko ? 1 : 0);
})();
