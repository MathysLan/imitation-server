// Test du tirage des vidéos : on ne doit PAS retomber sur les mêmes clips
// quand on relance une partie sans quitter le lobby.
const engine = require('./src/engine');
let f = 0; const check = (l, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + l); if (!c) f++; };

const cat = (n) => Array.from({ length: n }, (_, i) => ({ id: 'vid_' + (i + 1) }));

// --- un cycle complet ne répète jamais une vidéo ---------------------------
{
  const videos = cat(6);
  let used = [], last = null;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const r = engine.pickVideo(videos, used, last);
    used = r.used; last = r.video.id; seen.push(r.video.id);
  }
  check('un cycle : les 6 vidéos sortent, sans doublon', new Set(seen).size === 6);
}

// --- LE CAS DE MATHYS : on relance une partie dans le même lobby -----------
{
  const videos = cat(8);
  let used = [], last = null;
  const partie1 = [];
  for (let i = 0; i < 3; i++) {                    // partie 1 : 3 manches
    const r = engine.pickVideo(videos, used, last);
    used = r.used; last = r.video.id; partie1.push(r.video.id);
  }
  const partie2 = [];
  for (let i = 0; i < 3; i++) {                    // partie 2, MÊME lobby (used conservé)
    const r = engine.pickVideo(videos, used, last);
    used = r.used; last = r.video.id; partie2.push(r.video.id);
  }
  const repeats = partie2.filter((id) => partie1.includes(id));
  check('relancer une partie ne redonne aucun clip déjà vu', repeats.length === 0);
  check('les 6 clips joués sont tous différents', new Set([...partie1, ...partie2]).size === 6);
}

// --- catalogue épuisé : on repart proprement pour un tour ------------------
{
  const videos = cat(4);
  let used = [], last = null;
  const seen = [];
  for (let i = 0; i < 4; i++) {                    // on épuise le catalogue
    const r = engine.pickVideo(videos, used, last);
    used = r.used; last = r.video.id; seen.push(r.video.id);
  }
  check('catalogue épuisé : la liste des vues est pleine', used.length === 4);
  const next = engine.pickVideo(videos, used, last);
  check('épuisé → nouveau cycle (la liste repart d\'une seule entrée)', next.used.length === 1);
  check('épuisé → on ne rejoue pas le clip qui vient de passer', next.video.id !== last);
}

// --- sur la durée, la répartition reste correcte ---------------------------
{
  const videos = cat(5);
  let used = [], last = null;
  const counts = {};
  for (let i = 0; i < 500; i++) {
    const r = engine.pickVideo(videos, used, last);
    used = r.used; last = r.video.id;
    counts[r.video.id] = (counts[r.video.id] || 0) + 1;
  }
  const vals = Object.values(counts);
  check('500 tirages : les 5 vidéos sont toutes utilisées', vals.length === 5);
  check('500 tirages : répartition équilibrée (aucune oubliée)',
    Math.max(...vals) - Math.min(...vals) <= 2);
}

// --- cas limites -----------------------------------------------------------
{
  check('catalogue vide → pas de crash, video = null', engine.pickVideo([], [], null).video === null);
  const one = engine.pickVideo(cat(1), ['vid_1'], 'vid_1');
  check('catalogue à 1 vidéo → on la rejoue sans planter', one.video.id === 'vid_1');
}

console.log(f === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${f} test(s) échoué(s)`);
process.exit(f === 0 ? 0 : 1);
