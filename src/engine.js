// Logique pure du jeu d'imitation : des entrées → des sorties, c'est tout.
// Pas de socket, pas de timer, pas d'état global : tout est testable à sec.

// Tire une vidéo pas encore vue DANS CETTE ROOM. `usedIds` persiste d'une partie
// à l'autre tant qu'on reste dans le même lobby : on ne retombe donc pas sur les
// mêmes clips en relançant. Quand tout le catalogue est passé, on repart pour un
// nouveau tour — en évitant de rejouer tout de suite le dernier clip vu.
// Renvoie { video, used } : la nouvelle liste des vues, que le serveur stocke.
function pickVideo(videos, usedIds = [], lastId = null) {
  if (!videos || videos.length === 0) return { video: null, used: usedIds || [] };
  let used = usedIds || [];
  let pool = videos.filter((v) => !used.includes(v.id));
  if (pool.length === 0) {                          // catalogue épuisé → on relance un cycle
    used = [];
    pool = videos.filter((v) => v.id !== lastId);   // pas deux fois de suite le même
    if (pool.length === 0) pool = videos;           // cas d'un catalogue à une seule vidéo
  }
  const video = pool[Math.floor(Math.random() * pool.length)];
  return { video, used: [...used, video.id] };
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Notation d'une imitation : 👍×2 (+2), 👍 (+1), 👎 (-1). Une note par joueur et par prise.
function validateRate(phase, current, raterId, value) {
  if (phase !== 'rating') return fail("ce n'est pas le moment de noter");
  if (!current) return fail('aucune imitation en cours');
  if (raterId === current.owner) return fail('pas ta propre imitation');
  if (current.ratings.has(raterId)) return fail('déjà noté');
  if (![2, 1, -1].includes(value)) return fail('note invalide');
  return { ok: true };
}

// ratings : Map(noteur → valeur) → total du round pour cette prise
function sumRatings(ratings) {
  let total = 0;
  for (const v of ratings.values()) total += v;
  return total;
}

const fail = (error) => ({ ok: false, error });

module.exports = { pickVideo, shuffle, validateRate, sumRatings };
