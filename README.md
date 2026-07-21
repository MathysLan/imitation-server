# imitation-server

Serveur arbitre WebSocket du jeu d'imitation. Node.js + `ws`, rien d'autre.
Machine à états pilotée serveur, audios relayés en RAM et purgés à chaque round.

```
lobby → watching → recording → rating (écoute + notation, prise par prise) → results → (round suivant | end)
```

v2 :
- la vidéo tourne pendant l'enregistrement : la fenêtre suit la durée du clip
- prises refaisables (la dernière reçue remplace la précédente)
- notation par imitation : 👍×2 (+2), 👍 (+1), 👎 (-1), une note par joueur et par prise
- scoreboard diffusé après chaque prise notée
- **catalogue vidéos chargé depuis GitHub Pages** (`videos.json`, rechargé toutes
  les 10 min) : ajouter un clip ne demande aucun redéploiement du serveur

## Lancer en local

```bash
npm install
npm start          # port 8080 (ou $PORT)
```

## Tests

```bash
VIDEOS_URL= WATCH_MS=150 RECORD_MS=400 RECORD_GRACE_MS=150 LISTEN_MS=1500 \
RESULTS_MS=200 ROUNDS=1 PORT=8124 node src/server.js &
PORT=8124 node test.js
```

## Réglages (variables d'env)

| Var               | Défaut  | Rôle                                              |
|-------------------|---------|---------------------------------------------------|
| `VIDEOS_URL`      | videos.json du site | catalogue distant ('' = liste locale) |
| `WATCH_MS`        | durée du clip | fenêtre de visionnage                       |
| `RECORD_MS`       | clip + extra  | fenêtre d'enregistrement (0 = auto)         |
| `RECORD_EXTRA_MS` | 2000    | marge pour appuyer sur ⏺                          |
| `RECORD_GRACE_MS` | 3000    | marge d'upload avant de trancher                  |
| `LISTEN_MS`       | rec + gap | fenêtre d'écoute/notation par prise (0 = auto)  |
| `LISTEN_GAP_MS`   | 2000    | respiration entre deux écoutes                    |
| `RESULTS_MS`      | 8000    | affichage des résultats                           |
| `ROUNDS`          | 3       | rounds par partie                                 |

## Protocole

Texte (JSON) + frames binaires (les prises audio) sur le même socket :

| Sens    | Message |
|---------|---------|
| client  | `{ action:'join', name }` — crée la room (host) |
| client  | `{ action:'join', name, code }` — rejoint |
| client  | `{ action:'start' }` — host, depuis le lobby |
| client  | `{ action:'audio-meta', mime, size }` puis **une frame binaire** (refaisable) |
| client  | `{ action:'rate', value }` — 2, 1 ou -1 sur la prise en cours |
| serveur | `{ type:'room', code, phase, you, players[] }` |
| serveur | `{ type:'phase', phase, deadline, … }` |
| serveur | `{ type:'listen', idx, of, player, name, mime, video, deadline }` puis **une frame binaire** |
| serveur | `{ type:'scores', scores }` — scoreboard live après chaque prise |
| serveur | `{ type:'error', message }` |

Garde-fous mémoire : `maxPayload` 2 Mo sur le socket, 1,5 Mo max par prise,
purge des audios à chaque fin de round, à l'abandon et à la fermeture de room.
