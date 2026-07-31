// Serveur arbitre du jeu d'imitation. Node + ws, rien d'autre.
// Machine à états pilotée serveur :
//   lobby → watching → recording → rating (écoute + notation, prise par prise) → results → (round suivant | end)
//
// v3 : PLUS AUCUN timer de gameplay. C'est le host qui fait avancer la partie
// avec l'action 'next' (visionnage → enregistrement → fin d'enregistrement →
// passer une imitation → round suivant). Une seule temporisation subsiste :
// la grâce d'upload quand le host clôt l'enregistrement, pour laisser les
// dernières prises arriver.
//
// Protocole texte (JSON) + frames binaires (les prises audio) :
//   client  → { action:'join', name, code? }        sans code : crée la room (host)
//   client  → { action:'start' }                    host uniquement, depuis le lobby
//   client  → { action:'next' }                     host uniquement : phase suivante
//   client  → { action:'audio-meta', mime, size }   puis UNE frame binaire (refaisable)
//   client  → { action:'rate', value }              2, 1 ou -1 sur la prise en cours
//   serveur → { type:'room', ... }                  état du lobby (joueurs, scores, host)
//   serveur → { type:'phase', phase, ... }          changement d'état
//   serveur → { type:'hurry' }                      le host clôt l'enregistrement : stoppe et envoie
//   serveur → { type:'listen', idx, of, player, name, mime } puis UNE frame binaire
//   serveur → { type:'scores', scores }             scoreboard live, après chaque prise notée
//   serveur → { type:'error', message }

const http = require('http');
const { WebSocketServer } = require('ws');
const engine = require('./engine');

const CONFIG = {
  RECORD_GRACE_MS: +process.env.RECORD_GRACE_MS || 2500, // grâce d'upload après le 'next' du host
  ROUNDS: +process.env.ROUNDS || 3,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,
  MAX_AUDIO: 1.5 * 1024 * 1024,
};

// --- catalogue vidéos : UNE source de vérité, dans le repo du site -----------
// Chaque entrée : { id } et, en option, { url } pour un hébergement externe
// (R2, autre domaine…). Sans url, le front prend videos/<id>.mp4 sur le site.
// Le serveur recharge la liste au boot puis toutes les 10 minutes.
let VIDEOS = require('./videos'); // liste de secours embarquée
const VIDEOS_URL = process.env.VIDEOS_URL !== undefined
  ? process.env.VIDEOS_URL // '' = désactivé (tests)
  : 'https://mathyslan.github.io/games/imitation/videos/videos.json';

// Bruyant exprès : sans logs, impossible de savoir pourquoi le catalogue ne se
// met pas à jour. Chaque issue (HTTP KO, JSON invalide, réseau) laisse une trace.
let lastVideosError = null; // exposé sur /videos pour diagnostiquer sans les logs Render
async function refreshVideos() {
  if (!VIDEOS_URL) { lastVideosError = 'VIDEOS_URL désactivée (liste de secours)'; return false; }
  try {
    const res = await fetch(VIDEOS_URL, { cache: 'no-store' });
    if (!res.ok) {
      lastVideosError = `HTTP ${res.status} sur ${VIDEOS_URL}`;
      console.warn('catalogue vidéos:', lastVideosError);
      return false;
    }
    const list = await res.json();
    if (!Array.isArray(list) || !list.length || !list.every((v) => v && v.id)) {
      lastVideosError = 'JSON inattendu (attendu un tableau non vide de { id, url? })';
      console.warn('catalogue vidéos:', lastVideosError);
      return false;
    }
    VIDEOS = list.map((v) => ({ id: String(v.id), url: v.url ? String(v.url) : null }));
    lastVideosError = null;
    console.log(`catalogue vidéos: ${VIDEOS.length} clip(s) chargé(s) depuis ${VIDEOS_URL}`);
    return true;
  } catch (e) {
    lastVideosError = `échec réseau/JSON: ${e.message}`;
    console.warn('catalogue vidéos:', lastVideosError, '- liste de secours conservée');
    return false;
  }
}
refreshVideos();
setInterval(refreshVideos, 10 * 60 * 1000).unref();

const rooms = new Map(); // code → room
let nextId = 1;

// GET /videos → ce que le serveur connaît VRAIMENT, à l'instant T. À ouvrir dans
// le navigateur pour diagnostiquer sans fouiller les logs Render.
const server = http.createServer((req, res) => {
  if (req.url === '/videos') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ count: VIDEOS.length, source: VIDEOS_URL || null, lastError: lastVideosError, videos: VIDEOS }, null, 2));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('imitation-server OK\n');
});
// maxPayload : le garde-fou RAM réel - une frame plus lourde ferme la connexion.
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

// Codes lisibles : pas de 0/O ni 1/I.
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(code) {
  return {
    code,
    phase: 'lobby',
    players: new Map(), // id → { id, name, ws, score }
    hostId: null,
    rounds: null,       // manches choisies par le host au lancement
    round: 0,
    usedVideos: [],     // clips déjà vus DANS CE LOBBY (survit d'une partie à l'autre)
    lastVideoId: null,  // dernier clip joué : on évite de le rejouer juste après
    video: null,        // { id, url } du round en cours
    closing: false,     // grâce d'upload en cours après le 'next' du host
    takes: new Map(),   // id → { buf, mime } - RAM le temps du round, purgé après
    queue: [],          // prises à diffuser
    listenIdx: 0,
    current: null,      // { owner, ratings: Map(noteur → valeur) }
    timer: null,        // uniquement la grâce d'upload
  };
}

// ---------------------------------------------------------------- transport

wss.on('connection', (ws) => {
  ws.id = 'p' + nextId++;
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return onAudio(ws, raw);
    let msg;
    try { msg = JSON.parse(raw); } catch { return sendError(ws, 'JSON invalide'); }
    if (msg.action === 'join') onJoin(ws, msg);
    else if (msg.action === 'ready') onReady(ws, msg.ready);
    else if (msg.action === 'start') onStart(ws, msg);
    else if (msg.action === 'next') onNext(ws);
    else if (msg.action === 'audio-meta') onAudioMeta(ws, msg);
    else if (msg.action === 'rate') onRate(ws, msg.value);
    else sendError(ws, 'action inconnue');
  });
  ws.on('close', () => onLeave(ws));
});

// ---------------------------------------------------------------- lobby

function onJoin(ws, { name, code, avatar }) {
  if (ws.room) return sendError(ws, 'déjà dans une room');
  const cleanName = String(name || '').trim().slice(0, 16);
  if (!cleanName) return sendError(ws, 'il faut un pseudo');

  let room;
  if (code === undefined) {
    room = createRoom(newCode());
    rooms.set(room.code, room);
    room.hostId = ws.id;
  } else {
    room = rooms.get(String(code).trim().toUpperCase());
    if (!room) return sendError(ws, 'room introuvable');
    if (room.phase !== 'lobby') return sendError(ws, 'partie en cours');
    if (room.players.size >= CONFIG.MAX_PLAYERS) return sendError(ws, 'room pleine');
  }

  ws.room = room.code;
  room.players.set(ws.id, {
    id: ws.id,
    name: cleanName,
    avatar: String(avatar || '🙂').slice(0, 4), // un emoji suffit comme photo de profil
    ready: false,
    ws,
    score: 0,
  });
  sendRoomState(room);
}

// « Prêt » : purement déclaratif, affiché à tous. Le host reste seul maître du départ.
function onReady(ws, ready) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune room');
  const p = room.players.get(ws.id);
  if (p) { p.ready = !!ready; sendRoomState(room); }
}

async function onStart(ws, msg) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune room');
  if (ws.id !== room.hostId) return sendError(ws, 'seul le host peut lancer');
  if (room.phase !== 'lobby') return sendError(ws, 'partie déjà lancée');
  if (room.players.size < CONFIG.MIN_PLAYERS) return sendError(ws, `il faut au moins ${CONFIG.MIN_PLAYERS} joueurs`);

  // Catalogue frais pour CETTE partie : plus besoin d'attendre le cache 10 min
  // ni de redémarrer Render après avoir édité videos.json.
  await refreshVideos();
  // re-vérif après l'await (un joueur a pu partir entre-temps)
  if (room.phase !== 'lobby' || room.players.size < CONFIG.MIN_PLAYERS) return;

  // Config choisie par le host à l'écran de lancement (bornée côté serveur, évidemment).
  room.rounds = Math.min(10, Math.max(1, Math.trunc(+((msg && msg.rounds)) || CONFIG.ROUNDS)));
  for (const p of room.players.values()) { p.score = 0; p.ready = false; }
  room.round = 0;
  // On NE remet PAS `usedVideos` à zéro : tant qu'on reste dans le même lobby,
  // relancer une partie ne doit pas refaire tomber les mêmes clips. Le cycle
  // repart tout seul quand tout le catalogue est passé (cf. engine.pickVideo).
  nextRound(room);
}

// Le host pilote : chaque 'next' fait avancer la phase en cours.
function onNext(ws) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune room');
  if (ws.id !== room.hostId) return sendError(ws, 'seul le host peut passer');

  if (room.phase === 'watching') startRecording(room);
  else if (room.phase === 'recording') endRecording(room);
  else if (room.phase === 'rating') closeTake(room);       // passe l'imitation en cours
  else if (room.phase === 'results') nextRound(room);
  else sendError(ws, 'rien à passer ici');
}

// ---------------------------------------------------------------- machine à états

function nextRound(room) {
  purge(room);
  if (room.round >= (room.rounds || CONFIG.ROUNDS)) return endGame(room);
  room.round++;

  const { video, used } = engine.pickVideo(VIDEOS, room.usedVideos, room.lastVideoId);
  if (!video) {                                   // catalogue vide : on ne plante pas
    roomBroadcast(room, { type: 'error', message: 'aucune vidéo dans le catalogue' });
    room.phase = 'lobby'; sendRoomState(room); return;
  }
  room.usedVideos = used;
  room.lastVideoId = video.id;
  room.video = video;

  room.phase = 'watching';
  phase(room, { phase: 'watching', round: room.round, of: room.rounds || CONFIG.ROUNDS, video: video.id, url: video.url || null });
}

function startRecording(room) {
  room.phase = 'recording';
  room.closing = false;
  // « prêt » repart à zéro : pendant l'enregistrement il signifie « j'ai fini ma prise »
  for (const p of room.players.values()) p.ready = false;
  phase(room, { phase: 'recording', video: room.video.id, url: room.video.url || null });
  sendRoomState(room);
}

// Le host clôt l'enregistrement : on prévient tout le monde (les prises en cours
// se stoppent et s'envoient), puis la grâce d'upload laisse arriver les frames.
function endRecording(room) {
  if (room.closing) return;
  room.closing = true;
  roomBroadcast(room, { type: 'hurry' });
  setGraceTimer(room, CONFIG.RECORD_GRACE_MS, () => {
    room.closing = false;
    startRating(room);
  });
}

function startRating(room) {
  room.phase = 'rating';
  if (room.takes.size === 0) return showResults(room); // personne n'a rendu

  room.queue = engine.shuffle([...room.takes.entries()]);
  room.listenIdx = 0;
  phase(room, { phase: 'rating', count: room.takes.size });
  playTake(room);
}

function playTake(room) {
  const next = room.queue.shift();
  if (!next) return showResults(room);
  const [owner, take] = next;
  room.listenIdx++;
  room.current = { owner, ratings: new Map() };

  const author = room.players.get(owner);
  for (const p of room.players.values()) {
    sendJson(p.ws, {
      type: 'listen', idx: room.listenIdx, of: room.listenIdx + room.queue.length,
      player: owner, name: author ? author.name : '?', avatar: author ? author.avatar : '🙂',
      mime: take.mime,
    });
    p.ws.send(take.buf); // la frame binaire, telle que reçue
  }
  // Pas de timer : la prise avance quand tout le monde a noté, ou sur 'next' du host.
}

function closeTake(room) {
  const cur = room.current;
  if (cur) {
    const p = room.players.get(cur.owner);
    if (p) p.score += engine.sumRatings(cur.ratings);
    room.current = null;
    roomBroadcast(room, { type: 'scores', scores: scoreboard(room) }); // scoreboard live
  }
  playTake(room);
}

function showResults(room) {
  room.phase = 'results';
  phase(room, { phase: 'results', scores: scoreboard(room) });
  purge(room); // ← purge absolue : les audios du round meurent ici, la RAM revient à plat
  // Le host enchaîne avec 'next' quand il veut.
}

function endGame(room) {
  room.phase = 'lobby'; // la room reste vivante, le host peut relancer
  roomBroadcast(room, { type: 'phase', phase: 'end', podium: scoreboard(room) });
  sendRoomState(room);
}

// ---------------------------------------------------------------- audio

function onAudioMeta(ws, msg) {
  ws.audioMeta = { mime: String(msg.mime || 'audio/webm').slice(0, 64) };
}

function onAudio(ws, buf) {
  const room = rooms.get(ws.room);
  if (!room || room.phase !== 'recording') return sendError(ws, "pas en phase d'enregistrement");
  if (!ws.audioMeta) return sendError(ws, 'méta audio manquante');
  if (buf.length > CONFIG.MAX_AUDIO) { ws.audioMeta = null; return sendError(ws, 'audio trop lourd'); }

  // Refaire une prise est un droit : la dernière reçue remplace la précédente.
  room.takes.set(ws.id, { buf, mime: ws.audioMeta.mime });
  ws.audioMeta = null;
}

// ---------------------------------------------------------------- notation

// La note n'interrompt rien : l'imitation joue jusqu'au bout, chacun peut la
// réécouter, et c'est le host qui passe à la suivante ('next'). On diffuse juste
// l'avancement des votes pour que tout le monde (surtout le host) le voie.
function onRate(ws, value) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune partie en cours');
  const res = engine.validateRate(room.phase, room.current, ws.id, value);
  if (!res.ok) return sendError(ws, res.error);
  room.current.ratings.set(ws.id, value);
  const eligible = room.players.size - (room.players.has(room.current.owner) ? 1 : 0);
  // on joint QUI a noté (et le propriétaire de la prise, qui ne vote pas) :
  // le front peut ainsi nommer ceux qu'on attend au lieu d'un simple compteur
  roomBroadcast(room, { type: 'rated', count: room.current.ratings.size, of: eligible,
    ids: [...room.current.ratings.keys()], owner: room.current.owner });
}

// ---------------------------------------------------------------- départs

function onLeave(ws) {
  const room = rooms.get(ws.room);
  if (!room) return;
  room.players.delete(ws.id);
  room.takes.delete(ws.id);
  if (room.current) room.current.ratings.delete(ws.id);

  if (room.players.size === 0) { // room vide : tout disparaît, timer compris
    clearTimeout(room.timer);
    rooms.delete(room.code);
    return;
  }
  if (ws.id === room.hostId) room.hostId = room.players.keys().next().value;

  if (room.phase !== 'lobby' && room.players.size < CONFIG.MIN_PLAYERS) {
    clearTimeout(room.timer);
    purge(room);
    room.phase = 'lobby';
    roomBroadcast(room, { type: 'error', message: 'plus assez de joueurs - retour au lobby' });
  }
  sendRoomState(room); // met aussi à jour le badge host chez tout le monde
}

// ---------------------------------------------------------------- helpers

function purge(room) {
  room.takes.clear();
  room.queue = [];
  room.current = null;
  room.listenIdx = 0;
  room.closing = false;
}

function scoreboard(room) {
  return [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function setGraceTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(fn, ms);
}

function phase(room, payload) {
  roomBroadcast(room, { type: 'phase', ...payload });
}

function sendRoomState(room) {
  const players = [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, ready: p.ready, score: p.score, host: p.id === room.hostId }));
  for (const p of room.players.values()) {
    sendJson(p.ws, { type: 'room', code: room.code, phase: room.phase, you: p.id, players });
  }
}

function roomBroadcast(room, obj) {
  for (const p of room.players.values()) sendJson(p.ws, obj);
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

const sendError = (ws, message) => sendJson(ws, { type: 'error', message });

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`imitation-server à l'écoute sur :${PORT}`));
