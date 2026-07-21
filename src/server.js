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

async function refreshVideos() {
  if (!VIDEOS_URL) return;
  try {
    const res = await fetch(VIDEOS_URL, { cache: 'no-store' });
    const list = await res.json();
    if (Array.isArray(list) && list.length && list.every((v) => v.id)) {
      VIDEOS = list.map((v) => ({ id: String(v.id), url: v.url ? String(v.url) : null }));
      console.log(`catalogue vidéos rechargé : ${VIDEOS.length} clip(s)`);
    }
  } catch { /* réseau ou JSON cassé : on garde la dernière liste valide */ }
}
refreshVideos();
setInterval(refreshVideos, 10 * 60 * 1000).unref();

const rooms = new Map(); // code → room
let nextId = 1;

const server = http.createServer((_req, res) => {
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
    round: 0,
    usedVideos: [],
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
    else if (msg.action === 'start') onStart(ws);
    else if (msg.action === 'next') onNext(ws);
    else if (msg.action === 'audio-meta') onAudioMeta(ws, msg);
    else if (msg.action === 'rate') onRate(ws, msg.value);
    else sendError(ws, 'action inconnue');
  });
  ws.on('close', () => onLeave(ws));
});

// ---------------------------------------------------------------- lobby

function onJoin(ws, { name, code }) {
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
  room.players.set(ws.id, { id: ws.id, name: cleanName, ws, score: 0 });
  sendRoomState(room);
}

function onStart(ws) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune room');
  if (ws.id !== room.hostId) return sendError(ws, 'seul le host peut lancer');
  if (room.phase !== 'lobby') return sendError(ws, 'partie déjà lancée');
  if (room.players.size < CONFIG.MIN_PLAYERS) return sendError(ws, `il faut au moins ${CONFIG.MIN_PLAYERS} joueurs`);

  for (const p of room.players.values()) p.score = 0;
  room.round = 0;
  room.usedVideos = [];
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
  if (room.round >= CONFIG.ROUNDS) return endGame(room);
  room.round++;

  const video = engine.pickVideo(VIDEOS, room.usedVideos);
  room.usedVideos.push(video.id);
  room.video = video;

  room.phase = 'watching';
  phase(room, { phase: 'watching', round: room.round, of: CONFIG.ROUNDS, video: video.id, url: video.url || null });
}

function startRecording(room) {
  room.phase = 'recording';
  room.closing = false;
  phase(room, { phase: 'recording', video: room.video.id, url: room.video.url || null });
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
      player: owner, name: author ? author.name : '?', mime: take.mime,
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

function onRate(ws, value) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune partie en cours');
  const res = engine.validateRate(room.phase, room.current, ws.id, value);
  if (!res.ok) return sendError(ws, res.error);
  room.current.ratings.set(ws.id, value);
  if (ratingsComplete(room)) closeTake(room); // tout le monde a noté : prise suivante
}

function ratingsComplete(room) {
  if (!room.current) return false;
  const eligible = room.players.size - (room.players.has(room.current.owner) ? 1 : 0);
  return eligible > 0 && room.current.ratings.size >= eligible;
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

  if (room.phase === 'rating' && ratingsComplete(room)) closeTake(room);
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
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
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
    .map((p) => ({ id: p.id, name: p.name, score: p.score, host: p.id === room.hostId }));
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
