// Tests unitaires de avatar.js — la validation de l'avatar reçu au `join`.
//
//   node test-avatar.js
//
// ⚠️ Même fichier dans les six serveurs qui reçoivent une identité. Les images
// de test-fixtures/ sont de VRAIES images, produites par le canvas d'Edge et
// par GameProfile.normalizeImage() du portfolio (96×96, webp) : on teste le
// chemin réel, pas une chaîne « data:image/webp;base64,test ».
const fs = require('fs');
const path = require('path');
const A = require(fs.existsSync(path.join(__dirname, 'src', 'avatar.js')) ? './src/avatar.js' : './avatar.js');

let ok = 0, ko = 0;
const t = (name, cond, detail) => {
  if (cond) { ok++; console.log('OK   ' + name); }
  else { ko++; console.log('KO   ' + name + (detail ? ' — ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const url = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
const fx = (f) => fs.readFileSync(path.join(__dirname, 'test-fixtures', f));

const WEBP = fx('avatar-96.webp');       // la PP réelle : 96×96, ~2,5 Ko
const PNG = fx('avatar-96.png');         // le repli png d'un navigateur sans encodeur webp
const LOURDE = fx('avatar-13k.webp');    // un vrai webp, valide, mais > 12 Ko
const PP = url('image/webp', WEBP);

// --- les fixtures sont bien ce qu'elles prétendent être
t('fixture : la PP est un vrai webp (RIFF…WEBP)', WEBP.toString('latin1', 0, 4) === 'RIFF' && WEBP.toString('latin1', 8, 12) === 'WEBP');
t(`fixture : la PP pèse ${WEBP.length} octets (≤ 12 Ko)`, WEBP.length <= A.MAX_IMAGE_BYTES);
t(`fixture : l'image lourde pèse ${LOURDE.length} octets (> 12 Ko, et c'est un vrai webp)`,
  LOURDE.length > A.MAX_IMAGE_BYTES && LOURDE.toString('latin1', 8, 12) === 'WEBP');

// --- 1. emoji
t('emoji : gardé tel quel', same(A.cleanAvatar({ kind: 'emoji', emoji: '🦊' }, '🙂'), { kind: 'emoji', emoji: '🦊' }));
t('emoji à 3 unités UTF-16 (🕵️) accepté', A.cleanAvatar({ kind: 'emoji', emoji: '🕵️' }, '🙂').emoji === '🕵️');

// --- 2. image valide
const img = A.cleanAvatar({ kind: 'image', emoji: '🦊', src: PP }, '🙂');
t('image webp valide : kind image', img.kind === 'image');
t('image webp valide : src gardée À L\'IDENTIQUE (ni décodée ni réencodée)', img.src === PP);
t('image webp valide : l\'emoji de repli voyage avec', img.emoji === '🦊');
t('image png valide acceptée', A.cleanAvatar({ kind: 'image', emoji: '🦊', src: url('image/png', PNG) }, '🙂').kind === 'image');
t('seuls kind / emoji / src sont recopiés',
  same(Object.keys(A.cleanAvatar({ kind: 'image', emoji: '🦊', src: PP, ws: 'x', admin: true, __proto__: { y: 1 } }, '🙂')).sort(), ['emoji', 'kind', 'src']));

// --- 3. image refusée → repli sur l'emoji (jamais d'exception)
const refuse = (name, raw, emoji = '🦊') => {
  let r, boom = null;
  try { r = A.cleanAvatar(raw, '🙂'); } catch (e) { boom = e; }
  t(name, !boom && r && r.kind === 'emoji' && !('src' in r) && r.emoji === emoji,
    boom ? boom.message : JSON.stringify(r).slice(0, 120));
};
refuse('> 12 Ko refusée (vrai webp de ' + LOURDE.length + ' o)', { kind: 'image', emoji: '🦊', src: url('image/webp', LOURDE) });
refuse('SVG refusé', { kind: 'image', emoji: '🦊', src: url('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')) });
refuse('SVG déguisé en webp refusé (signature)', { kind: 'image', emoji: '🦊', src: url('image/webp', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')) });
refuse('type MIME inattendu refusé (gif)', { kind: 'image', emoji: '🦊', src: url('image/gif', Buffer.from('GIF89a\x01\x00\x01\x00')) });
refuse('type MIME inattendu refusé (jpeg)', { kind: 'image', emoji: '🦊', src: url('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])) });
refuse('type MIME inattendu refusé (text/html)', { kind: 'image', emoji: '🦊', src: 'data:text/html;base64,' + Buffer.from('<b>x</b>').toString('base64') });
refuse('png annoncé webp refusé (la signature ne ment pas)', { kind: 'image', emoji: '🦊', src: url('image/webp', PNG) });
refuse('webp annoncé png refusé', { kind: 'image', emoji: '🦊', src: url('image/png', WEBP) });
refuse('src qui n\'est pas une data-URL refusée (http)', { kind: 'image', emoji: '🦊', src: 'https://exemple.test/photo.webp' });
refuse('src javascript: refusée', { kind: 'image', emoji: '🦊', src: 'javascript:alert(1)' });
refuse('data-URL sans base64 refusée', { kind: 'image', emoji: '🦊', src: 'data:image/webp,RIFF' });
refuse('base64 non canonique refusé', { kind: 'image', emoji: '🦊', src: PP.replace('base64,', 'base64,A') });
refuse('guillemet dans src refusé', { kind: 'image', emoji: '🦊', src: PP.slice(0, 40) + '"onerror="x' });
refuse('src vide refusée', { kind: 'image', emoji: '🦊', src: '' });
refuse('src absente refusée', { kind: 'image', emoji: '🦊' });
refuse('src de mauvais type refusée (objet)', { kind: 'image', emoji: '🦊', src: { toString: () => PP } });
refuse('kind inconnu refusé', { kind: 'video', emoji: '🦊', src: PP });
refuse('kind absent refusé (même avec une image valide)', { emoji: '🦊', src: PP });

// --- 4. structure incorrecte → emoji par défaut du jeu
refuse('avatar tableau → défaut', [PP], '🙂');
refuse('avatar nombre → défaut', 42, '🙂');
refuse('avatar booléen → défaut', true, '🙂');
refuse('avatar absent → défaut', undefined, '🙂');
refuse('avatar null → défaut', null, '🙂');
refuse('emoji trop long (ZWJ, 8 unités) → défaut', { kind: 'emoji', emoji: '👨‍👩‍👧' }, '🙂');
refuse('emoji avec du HTML → défaut', { kind: 'emoji', emoji: '<b>' }, '🙂');
refuse('emoji vide → défaut', { kind: 'emoji', emoji: '' }, '🙂');
refuse('emoji de mauvais type → défaut', { kind: 'emoji', emoji: 1234 }, '🙂');
const imgSansEmoji = A.cleanAvatar({ kind: 'image', emoji: '<x>', src: PP }, '🙂');
t('image valide + emoji invalide : l\'image passe, l\'emoji devient celui du jeu',
  imgSansEmoji.kind === 'image' && imgSansEmoji.emoji === '🙂' && imgSansEmoji.src === PP);

// --- 5. ancien client : l'avatar était une simple chaîne
t('ancien client : emoji en chaîne accepté', same(A.cleanAvatar('🔥', '🙂'), { kind: 'emoji', emoji: '🔥' }));
t('ancien client : chaîne vide → défaut', same(A.cleanAvatar('', '🙂'), { kind: 'emoji', emoji: '🙂' }));
refuse('ancien client : data-URL en chaîne → PAS tronquée, refusée', PP, '🙂');

// --- 6. coût : une chaîne énorme est écartée sans être décodée
const enorme = 'data:image/webp;base64,' + 'A'.repeat(5 * 1024 * 1024);
const t0 = process.hrtime.bigint();
const r = A.cleanAvatar({ kind: 'image', emoji: '🦊', src: enorme }, '🙂');
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
t(`5 Mo de base64 écartés en ${ms.toFixed(2)} ms, sans décodage`, r.kind === 'emoji' && ms < 20);

console.log(`\n${ko ? 'DES TESTS ÉCHOUENT' : 'TOUT PASSE'} — ${ok} ok, ${ko} ko`);
process.exit(ko ? 1 : 0);
