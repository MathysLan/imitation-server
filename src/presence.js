// Présence des joueurs : qui est VRAIMENT là ?
//
// Le problème : un onglet gelé par le navigateur (arrière-plan, écran
// verrouillé, changement d'application) garde son WebSocket OUVERT côté
// serveur, mais son JavaScript ne tourne plus. Il reste dans la room, compté
// au lancement, et ne reçoit rien : un joueur fantôme. Mesuré dans Edge : le
// ping/pong WebSocket NATIF ne le voit pas — c'est la couche réseau du
// navigateur qui répond au pong, pas la page.
//
// D'où une présence APPLICATIVE, à laquelle seul le JavaScript de la page peut
// répondre :
//   serveur → { type: 'presence', n, cle }   à la connexion (cle : secret de CETTE connexion)
//   serveur → { type: 'presence', n }        puis toutes les PRESENCE_MS
//   client  → { action: 'presence', n }      en réponse, jamais de lui-même
//   client  → { action: 'presence', n, remplace: <cle> }   1re réponse d'une
//             connexion qui en remplace une perdue ; le serveur ferme
//             l'ancienne (son `close` la retire de la room), PUIS acquitte :
//   serveur → { type: 'presence', n, remplace: true }
// Tout message reçu du client vaut preuve de vie. Sans preuve de vie depuis
// ABSENCE_MS, le socket est fermé (4000 'absent'), puis coupé net si la
// fermeture ne passe pas.
//
// ⚠️ ADHÉSION VOLONTAIRE. Un socket n'est soumis à la règle d'absence qu'après
// avoir envoyé un premier message `presence` valide. Un client qui ne connaît
// pas ce protocole (page en cache, ancien client) n'est JAMAIS expulsé par ce
// module : il vit comme avant.
//
// ⚠️ CE MODULE NE CONNAÎT AUCUNE ROOM. Il ne fait que fermer le socket ; c'est
// le `close` du serveur qui retire le joueur, réélit l'hôte et diffuse la room
// — exactement comme pour un départ ordinaire.
//
// En plus, et SÉPARÉMENT : un ping/pong WebSocket natif pour les coupures
// réseau franches (TCP mort, téléphone hors ligne), qui ne répondent plus du
// tout, même au niveau réseau. Il ne sert JAMAIS de preuve de présence.
//
// Même fichier dans chaque dépôt serveur (comme avatar.js) : on le copie, on
// ne l'adapte pas. Ce qui est propre à un jeu reste dans son server.js.
'use strict';

const crypto = require('crypto');

const DEFAUTS = {
  presenceMs: +process.env.PRESENCE_MS || 10000,    // fréquence du ping applicatif
  absenceMs: +process.env.ABSENCE_MS || 30000,      // sans preuve de vie depuis… → absent
  nativeMs: +process.env.NATIVE_PING_MS || 20000,   // ping/pong WebSocket natif
  killMs: +process.env.PRESENCE_KILL_MS || 3000,    // close() pas abouti → terminate()
  holdMs: +process.env.PRESENCE_HOLD_MS || 60000,   // sursis par défaut de hold()
};

const ACTION = 'presence';

// À appeler juste après `new WebSocketServer`, AVANT le `wss.on('connection')`
// du serveur : l'état de présence existe alors avant tout message du jeu.
function attach(wss, options = {}) {
  const o = { ...DEFAUTS, ...options };
  let n = 0;

  wss.on('connection', (ws) => {
    // `cle` : un secret propre à CETTE connexion, envoyé à elle seule. Il ne
    // sert qu'à une chose : qu'une nouvelle connexion du même navigateur puisse
    // remplacer l'ancienne (voir remplacer()). Personne d'autre ne le voit.
    ws.presence = { adhere: false, vu: Date.now(), natif: true, expulse: false, sursis: 0, cle: crypto.randomBytes(12).toString('hex') };
    // N'importe quel message du JavaScript de la page prouve qu'il tourne.
    ws.on('message', () => { ws.presence.vu = Date.now(); });
    // Le pong natif ne prouve QUE la couche réseau (un onglet gelé y répond).
    ws.on('pong', () => { ws.presence.natif = true; });
    // Premier ping TOUT DE SUITE : un client qui connaît la présence adhère en
    // un aller-retour, avant même de rejoindre une room. Sans ça, un hôte qui
    // change d'application juste après avoir créé sa partie (pour envoyer le
    // code…) serait gelé avant d'avoir adhéré — et redeviendrait un fantôme.
    // C'est le SERVEUR qui ouvre l'échange : un client ne l'envoie jamais de
    // lui-même, sinon un ancien serveur lui répondrait « action inconnue ».
    try { ws.send(JSON.stringify({ type: 'presence', n, cle: ws.presence.cle })); } catch (_) {}
  });

  // REMPLACEMENT d'une connexion perdue. Sans lui, une page qui revient par une
  // nouvelle connexion (coupure réseau, réveil) pouvait rejoindre sa room
  // AVANT que l'ancienne connexion, morte mais encore ouverte côté serveur,
  // n'en soit retirée : le même joueur deux fois, jusqu'à ~8 s en production,
  // et un lancement qui compte un fantôme. La page présente la clé de son
  // ancienne connexion ; on la ferme, son `close` habituel la retire de la
  // room et diffuse — et SEULEMENT ensuite on acquitte. La page n'envoie son
  // `join` qu'après l'acquittement : aucune room avec doublon n'est diffusée.
  function remplacer(ws, cle) {
    const acquitter = () => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'presence', n, remplace: true }));
    };
    let ancien = null;
    if (cle !== ws.presence.cle) {
      for (const c of wss.clients) if (c !== ws && c.presence && c.presence.cle === cle) { ancien = c; break; }
    }
    if (!ancien || ancien.readyState === ancien.CLOSED) return acquitter();
    journal(ancien, 'remplacée par une nouvelle connexion du même joueur');
    ancien.presence.expulse = true;
    // Ordre garanti : le `close` du serveur (son onLeave) a été attaché à la
    // connexion du socket ; celui-ci l'est maintenant, donc APRÈS. Le joueur
    // est retiré de sa room — et la room diffusée — avant l'acquittement.
    ancien.once('close', acquitter);
    ancien.terminate();
  }

  const applicatif = setInterval(() => {
    n++;
    const maintenant = Date.now();
    for (const ws of wss.clients) {
      const p = ws.presence;
      if (!p || p.expulse || ws.readyState !== ws.OPEN) continue;
      if (p.adhere && maintenant - p.vu > o.absenceMs && maintenant > p.sursis) { expulse(ws, o, maintenant - p.vu); continue; }
      // Envoyé à TOUS, adhérents ou non : c'est l'invitation à adhérer. Un
      // client qui ne connaît pas `presence` l'ignore.
      ws.send(JSON.stringify({ type: 'presence', n }));
    }
  }, o.presenceMs);

  const natif = setInterval(() => {
    for (const ws of wss.clients) {
      const p = ws.presence;
      if (!p || ws.readyState !== ws.OPEN) continue;
      if (!p.natif) { journal(ws, 'coupure réseau (pas de pong natif)'); ws.terminate(); continue; }
      p.natif = false;
      try { ws.ping(); } catch (_) {}
    }
  }, o.nativeMs);

  applicatif.unref(); natif.unref();
  wss.on('close', () => { clearInterval(applicatif); clearInterval(natif); });

  // Le routeur du serveur appelle `consume(ws, msg)` en premier : un message de
  // présence y est avalé (valide ou non) et ne tombe JAMAIS dans « action
  // inconnue ». Rend true si le message était pour ce module.
  return {
    // SURSIS : le serveur sait qu'un envoi long est en cours (Imitation : une
    // prise audio, jusqu'à 2 Mo, annoncée par audio-meta). Ses réponses de
    // présence attendent DERRIÈRE ces octets : sans sursis, un envoi lent
    // passerait pour une absence. Le prochain message reçu lève le doute.
    hold(ws, ms) {
      if (ws.presence) ws.presence.sursis = Date.now() + (ms || o.holdMs);
    },

    consume(ws, msg) {
      if (!msg || msg.action !== ACTION) return false;
      const k = msg.n;
      // n : un entier déjà émis (0 = le ping de connexion). Tout le reste est
      // ignoré — sans adhésion, et sans erreur renvoyée.
      if (ws.presence && Number.isInteger(k) && k >= 0 && k <= n) ws.presence.adhere = true;
      if (ws.presence && typeof msg.remplace === 'string' && msg.remplace) remplacer(ws, msg.remplace);
      return true;
    },
  };
}

function expulse(ws, o, silence) {
  ws.presence.expulse = true;
  journal(ws, `absent (${Math.round(silence / 1000)} s sans réponse)`);
  try { ws.close(4000, 'absent'); } catch (_) {}
  // La fermeture propre passe même vers un onglet gelé (mesuré). Si le réseau
  // est mort, elle n'aboutira jamais : on coupe net.
  const t = setTimeout(() => { if (ws.readyState !== ws.CLOSED) ws.terminate(); }, o.killMs);
  if (t.unref) t.unref();
}

function journal(ws, quoi) {
  if (!process.env.PRESENCE_QUIET) console.log(`[presence] ${ws.id || '?'} ${quoi}`);
}

module.exports = { attach, ACTION, DEFAUTS };
