// Logique pure du jeu d'imitation : des entrées → des sorties, c'est tout.
// Pas de socket, pas de timer, pas d'état global : tout est testable à sec.

function pickVideo(videos, usedIds) {
  let pool = videos.filter((v) => !usedIds.includes(v.id));
  if (pool.length === 0) pool = videos; // tout a été vu : on repart du catalogue complet
  return pool[Math.floor(Math.random() * pool.length)];
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
