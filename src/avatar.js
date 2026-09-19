// Avatar d'un joueur : ce que le serveur garde de ce que le client annonce au
// `join`. Règle d'or, ici comme ailleurs : le client n'a aucune autorité. Il
// PROPOSE un avatar, ce fichier décide de ce qui entre dans l'état du joueur.
//
// Deux formes, et seulement deux, sortent d'ici :
//   { kind: 'emoji', emoji }
//   { kind: 'image', emoji, src }   src = data-URL webp ou png, ≤ 12 Ko décodés
// L'emoji est TOUJOURS présent : c'est le repli d'affichage chez les autres
// joueurs si l'image ne se charge pas.
//
// Une image refusée ne bloque pas le joueur : elle est écartée, et il entre
// avec son emoji. Est refusé : SVG, tout autre type MIME, base64 non canonique,
// octets qui ne sont pas vraiment du webp / png, plus de 12 Ko, structure
// inattendue, `kind` inconnu. Seuls `kind`, `emoji` et `src` sont recopiés :
// un champ en plus envoyé par le client ne repart jamais chez les autres.
//
// L'image n'est NI décodée NI réencodée : la data-URL validée est gardée telle
// quelle. Les 12 Ko sont ceux du profil local (games/shared/game-profile.js),
// qui la produit en 96×96 — un client honnête n'est donc jamais refusé.
//
// ⚠️ Le même fichier vit dans les six serveurs qui reçoivent une identité
// (imitation, demicercle, ban, precision, passeur, qui-ment). Le corriger dans
// l'un, c'est le corriger dans les six.
'use strict';

const MAX_IMAGE_BYTES = 12 * 1024;
// Plus longue data-URL possible pour 12 Ko : au-delà, on refuse sans même
// lancer la regex ni décoder quoi que ce soit.
const MAX_SRC_CHARS = 'data:image/webp;base64,'.length + Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const DATA_URL = /^data:image\/(webp|png);base64,([A-Za-z0-9+/]+={0,2})$/;
// En unités UTF-16, comme l'ancien `slice(0, 4)` et comme le profil local.
const MAX_EMOJI = 4;

function cleanEmoji(e) {
  if (typeof e !== 'string' || e.length === 0 || e.length > MAX_EMOJI) return null;
  // Ni blanc, ni caractère de contrôle, ni caractère qui a un sens en HTML :
  // un emoji n'en a jamais besoin.
  if (/[\s\u0000-\u001f\u007f<>&"'`]/.test(e)) return null;
  return e;
}

// Le type annoncé doit être le vrai : on lit la signature du fichier.
function magicOk(type, buf) {
  if (type === 'png') {
    return buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
  }
  // webp : « RIFF » <taille sur 4 octets> « WEBP »
  return buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP';
}

function cleanImage(src) {
  if (typeof src !== 'string' || src.length > MAX_SRC_CHARS) return null;
  const m = DATA_URL.exec(src);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  // Node décode le base64 avec indulgence (il saute ce qu'il ne comprend
  // pas) : on exige la forme canonique, sinon ce qu'on valide n'est pas ce
  // que les navigateurs des autres joueurs liront.
  if (buf.toString('base64') !== m[2]) return null;
  if (!magicOk(m[1], buf)) return null;
  return src;
}

// `raw` : ce que le client a mis dans `avatar`. `fallback` : l'emoji par
// défaut de ce jeu. Ne lève jamais : un avatar illisible donne l'emoji.
function cleanAvatar(raw, fallback) {
  // Ancien client (ou pas d'avatar du tout) : une simple chaîne, un emoji.
  if (raw === undefined || raw === null || typeof raw === 'string') {
    return { kind: 'emoji', emoji: cleanEmoji(raw) || fallback };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'emoji', emoji: fallback };
  const emoji = cleanEmoji(raw.emoji) || fallback;
  if (raw.kind === 'image') {
    const src = cleanImage(raw.src);
    if (src) return { kind: 'image', emoji, src };
  }
  // kind 'emoji', image refusée, ou kind inconnu : l'emoji seul.
  return { kind: 'emoji', emoji };
}

module.exports = { cleanAvatar, cleanImage, cleanEmoji, MAX_IMAGE_BYTES };
