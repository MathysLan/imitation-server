# imitation-server

Serveur arbitre WebSocket du jeu d'imitation. Node.js + `ws`, rien d'autre.
Machine à états pilotée serveur, audios relayés en RAM et purgés à chaque round.

```
lobby → watching → recording → broadcasting → voting → results → (round suivant | end)
```

## Lancer en local

```bash
npm install
npm start          # port 8080 (ou $PORT)
```

## Tests

```bash
WATCH_MS=150 RECORD_MS=300 RECORD_GRACE_MS=200 LISTEN_GAP_MS=100 \
VOTE_MS=3000 RESULTS_MS=200 ROUNDS=1 PORT=8124 node src/server.js &
PORT=8124 node test.js
```

Partie complète à 3 joueurs simulés : rooms, machine à états, faux blobs audio
rediffusés et vérifiés octet par octet, tricheries refusées, abandon en cours
de partie. Toutes les durées sont surchargeables par variables d'env.

## Réglages (variables d'env, valeurs par défaut)

| Var               | Défaut  | Rôle                                        |
|-------------------|---------|---------------------------------------------|
| `WATCH_MS`        | durée réelle du clip | 0 = utilise `dur` de videos.js |
| `RECORD_MS`       | 15000   | temps d'enregistrement micro                |
| `RECORD_GRACE_MS` | 3000    | marge d'upload avant de trancher            |
| `LISTEN_GAP_MS`   | 2000    | respiration entre deux écoutes              |
| `VOTE_MS`         | 20000   | durée du vote                               |
| `RESULTS_MS`      | 8000    | affichage des résultats                     |
| `ROUNDS`          | 3       | rounds par partie                           |

## Vidéos de référence

`src/videos.js` ne contient que des IDs et des durées. Les fichiers `.mp4`
vivent sur GitHub Pages : `games/imitation/videos/<id>.mp4` (H.264 + AAC,
< 100 Mo par fichier). Ajouter un clip = une ligne + un fichier dans le site.

## Protocole

Texte (JSON) + frames binaires (les prises audio) sur le même socket :

| Sens    | Message |
|---------|---------|
| client  | `{ action:'join', name }` — crée la room (host) |
| client  | `{ action:'join', name, code }` — rejoint |
| client  | `{ action:'start' }` — host, depuis le lobby |
| client  | `{ action:'audio-meta', mime, size }` puis **une frame binaire** |
| client  | `{ action:'vote', for }` |
| serveur | `{ type:'room', code, phase, you, players[] }` |
| serveur | `{ type:'phase', phase, deadline, … }` |
| serveur | `{ type:'listen', player, name, mime }` puis **une frame binaire** |
| serveur | `{ type:'error', message }` |

Garde-fous mémoire : `maxPayload` 2 Mo sur le socket, 1,5 Mo max par prise,
`takes.clear()` à chaque fin de round, à l'abandon et à la fermeture de room.
# imitation-server
