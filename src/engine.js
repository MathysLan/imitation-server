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

function validateVote(phase, candidates, votes, voterId, forId) {
  if (phase !== 'voting') return fail("ce n'est pas le moment de voter");
  if (votes.has(voterId)) return fail('tu as déjà voté');
  if (forId === voterId) return fail('pas pour toi-même');
  if (!candidates.includes(forId)) return fail('candidat inconnu');
  return { ok: true };
}

// votes : Map(votant → candidat) → Map(candidat → nombre de voix)
function tally(votes) {
  const counts = new Map();
  for (const forId of votes.values()) counts.set(forId, (counts.get(forId) || 0) + 1);
  return counts;
}

const fail = (error) => ({ ok: false, error });

module.exports = { pickVideo, shuffle, validateVote, tally };
