// Liste de secours embarquée : utilisée UNIQUEMENT si videos.json (GitHub Pages)
// est injoignable au démarrage. En temps normal, refreshVideos() la remplace par
// le catalogue distant. Si le jeu ne propose QUE ces IDs, c'est le signe que le
// chargement distant a échoué → ouvre /videos sur le serveur pour voir lastError.
module.exports = [
  { id: 'vid_01' },
];
