# imitation-server

Serveur arbitre WebSocket du jeu d'imitation. Node.js + `ws`, rien d'autre.
Machine à états pilotée serveur, audios relayés en RAM et purgés à chaque round.

```
lobby → watching → recording → rating (écoute + notation, prise par prise) → results → (round suivant | end)
```

v3 :
- **plus aucun timer de gameplay : le host pilote** avec l'action `next`
  (visionnage → enregistrement → clôture → passer une imitation → round suivant)
- prises refaisables (la dernière reçue remplace la précédente) ; à la clôture,
  un `hurry` est diffusé et une grâce d'upload laisse arriver les dernières frames
- notation par imitation : 👍×2 (+2), 👍 (+1), 👎 (-1) - avance seule quand tout
  le monde a noté, ou sur `next` du host
- scoreboard diffusé après chaque prise notée
- **catalogue vidéos chargé depuis GitHub Pages** (`videos.json`, rechargé toutes
  les 10 min) : entrées `{ "id": "vid_01" }`, champ `url` optionnel pour un
  hébergement externe - plus besoin de durée

## Lancer en local

```bash
npm install
npm start          # port 8080 (ou $PORT)
```

## Tests

```bash
VIDEOS_URL= RECORD_GRACE_MS=200 ROUNDS=1 PORT=8124 node src/server.js &
PORT=8124 node test.js
```

## Réglages (variables d'env)

| Var               | Défaut  | Rôle                                              |
|-------------------|---------|---------------------------------------------------|
| `VIDEOS_URL`      | videos.json du site | catalogue distant ('' = liste locale) |
| `RECORD_GRACE_MS` | 2500    | grâce d'upload après la clôture du host           |
| `ROUNDS`          | 3       | rounds par partie                                 |

## Protocole

Texte (JSON) + frames binaires (les prises audio) sur le même socket :

| Sens    | Message |
|---------|---------|
| client  | `{ action:'join', name }` — crée la room (host) |
| client  | `{ action:'join', name, code }` — rejoint |
| client  | `{ action:'start' }` — host, depuis le lobby |
| client  | `{ action:'next' }` — host : phase suivante / clôture / skip |
| client  | `{ action:'audio-meta', mime, size }` puis **une frame binaire** (refaisable) |
| client  | `{ action:'rate', value }` — 2, 1 ou -1 sur la prise en cours |
| serveur | `{ type:'room', code, phase, you, players[] }` |
| serveur | `{ type:'phase', phase, … }` |
| serveur | `{ type:'hurry' }` — clôture de l'enregistrement : stoppe et envoie |
| serveur | `{ type:'listen', idx, of, player, name, mime }` puis **une frame binaire** |
| serveur | `{ type:'scores', scores }` — scoreboard live après chaque prise |
| serveur | `{ type:'error', message }` |

Garde-fous mémoire : `maxPayload` 2 Mo sur le socket, 1,5 Mo max par prise,
purge des audios à chaque fin de round, à l'abandon et à la fermeture de room.
