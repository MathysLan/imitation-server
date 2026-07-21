// Serveur arbitre du jeu d'imitation. Node + ws, rien d'autre.
// Machine à états pilotée serveur :
//   lobby → watching → recording → broadcasting → voting → results → (round suivant | end)
// Le client ne décide de rien : il reçoit des ordres de phase et obéit.
//
// Protocole texte (JSON) + frames binaires (les prises audio) :
//   client  → { action:'join', name, code? }        sans code : crée la room (host)
//   client  → { action:'start' }                    host uniquement, depuis le lobby
//   client  → { action:'audio-meta', mime, size }   puis UNE frame binaire juste derrière
//   client  → { action:'vote', for }                pendant la phase voting
//   serveur → { type:'room', ... }                  état du lobby (joueurs, scores, host)
//   serveur → { type:'phase', phase, ... }          changement d'état, avec deadline
//   serveur → { type:'listen', player, name, mime } puis UNE frame binaire (la prise)
//   serveur → { type:'error', message }

const http = require('http');
const { WebSocketServer } = require('ws');
const engine = require('./engine');
const VIDEOS = require('./videos');

// Durées surchargeables par variables d'env : indispensable pour les tests d'intégration.
const CONFIG = {
  WATCH_MS: +process.env.WATCH_MS || 0,               // 0 = durée réelle de la vidéo
  RECORD_MS: +process.env.RECORD_MS || 15000,          // temps d'enregistrement micro
  RECORD_GRACE_MS: +process.env.RECORD_GRACE_MS || 3000, // marge d'upload avant de trancher
  LISTEN_GAP_MS: +process.env.LISTEN_GAP_MS || 2000,   // respiration entre deux écoutes
  VOTE_MS: +process.env.VOTE_MS || 20000,
  RESULTS_MS: +process.env.RESULTS_MS || 8000,
  ROUNDS: +process.env.ROUNDS || 3,
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 8,
  MAX_AUDIO: 1.5 * 1024 * 1024,                        // ~1,5 Mo par prise, large pour 15 s
};

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
    takes: new Map(),   // id → { buf, mime } - en RAM le temps du round, purgé après
    votes: new Map(),   // votant → candidat
    candidates: [],
    timer: null,
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
    else if (msg.action === 'audio-meta') onAudioMeta(ws, msg);
    else if (msg.action === 'vote') onVote(ws, msg.for);
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

// ---------------------------------------------------------------- machine à états

function nextRound(room) {
  purge(room);
  if (room.round >= CONFIG.ROUNDS) return endGame(room);
  room.round++;

  const video = engine.pickVideo(VIDEOS, room.usedVideos);
  room.usedVideos.push(video.id);
  room.phase = 'watching';
  const ms = CONFIG.WATCH_MS || video.dur * 1000;
  phase(room, { phase: 'watching', round: room.round, of: CONFIG.ROUNDS, video: video.id, deadline: Date.now() + ms });
  setPhaseTimer(room, ms, () => startRecording(room));
}

function startRecording(room) {
  room.phase = 'recording';
  phase(room, { phase: 'recording', deadline: Date.now() + CONFIG.RECORD_MS });
  // Le serveur n'attend jamais un client muet : la grâce couvre le temps d'upload, puis on tranche.
  setPhaseTimer(room, CONFIG.RECORD_MS + CONFIG.RECORD_GRACE_MS, () => startBroadcast(room));
}

function startBroadcast(room) {
  room.phase = 'broadcasting';
  if (room.takes.size === 0) return finishVoting(room); // personne n'a rendu : résultats à vide, round suivant

  phase(room, { phase: 'broadcasting', count: room.takes.size });
  const queue = engine.shuffle([...room.takes.entries()]);

  const playNext = () => {
    const next = queue.shift();
    if (!next) return startVoting(room);
    const [id, take] = next;
    const author = room.players.get(id);
    for (const p of room.players.values()) {
      sendJson(p.ws, { type: 'listen', player: id, name: author ? author.name : '?', mime: take.mime });
      p.ws.send(take.buf); // la frame binaire, telle que reçue
    }
    setPhaseTimer(room, CONFIG.RECORD_MS + CONFIG.LISTEN_GAP_MS, playNext);
  };
  playNext();
}

function startVoting(room) {
  room.phase = 'voting';
  room.candidates = [...room.takes.keys()].filter((id) => room.players.has(id));
  room.votes.clear();
  phase(room, {
    phase: 'voting',
    deadline: Date.now() + CONFIG.VOTE_MS,
    candidates: room.candidates.map((id) => ({ id, name: room.players.get(id).name })),
  });
  setPhaseTimer(room, CONFIG.VOTE_MS, () => finishVoting(room));
}

function finishVoting(room) {
  clearTimeout(room.timer);
  const counts = engine.tally(room.votes);
  for (const [id, n] of counts) {
    const p = room.players.get(id);
    if (p) p.score += n;
  }
  room.phase = 'results';
  phase(room, {
    phase: 'results',
    votes: [...counts].map(([id, n]) => ({ id, votes: n })),
    scores: scoreboard(room),
    deadline: Date.now() + CONFIG.RESULTS_MS,
  });
  purge(room); // ← purge absolue : les audios du round meurent ici, la RAM revient à plat
  setPhaseTimer(room, CONFIG.RESULTS_MS, () => nextRound(room));
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
  if (room.takes.has(ws.id)) return sendError(ws, 'prise déjà reçue');
  if (buf.length > CONFIG.MAX_AUDIO) { ws.audioMeta = null; return sendError(ws, 'audio trop lourd'); }

  room.takes.set(ws.id, { buf, mime: ws.audioMeta.mime });
  ws.audioMeta = null;
  if (room.takes.size === room.players.size) startBroadcast(room); // tout le monde a rendu : on avance
}

// ---------------------------------------------------------------- votes

function onVote(ws, forId) {
  const room = rooms.get(ws.room);
  if (!room) return sendError(ws, 'aucune partie en cours');
  const res = engine.validateVote(room.phase, room.candidates, room.votes, ws.id, forId);
  if (!res.ok) return sendError(ws, res.error);
  room.votes.set(ws.id, forId);
  if (room.votes.size === room.players.size) finishVoting(room);
}

// ---------------------------------------------------------------- départs

function onLeave(ws) {
  const room = rooms.get(ws.room);
  if (!room) return;
  room.players.delete(ws.id);
  room.takes.delete(ws.id);
  room.votes.delete(ws.id);

  if (room.players.size === 0) { // room vide : tout disparaît, timers compris
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
  sendRoomState(room);

  // si tous les restants ont déjà rendu / voté, pas la peine d'attendre le timer
  if (room.phase === 'recording' && room.takes.size === room.players.size) startBroadcast(room);
  else if (room.phase === 'voting' && room.votes.size === room.players.size) finishVoting(room);
}

// ---------------------------------------------------------------- helpers

function purge(room) {
  room.takes.clear();
  room.votes.clear();
  room.candidates = [];
}

function scoreboard(room) {
  return [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function setPhaseTimer(room, ms, fn) {
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
