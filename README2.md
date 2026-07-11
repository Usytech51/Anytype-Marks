# Anytype Marks — Extension Firefox de synchronisation des favoris avec Anytype

Extension Firefox (Manifest V3) qui synchronise les favoris entre Firefox et Anytype de façon bidirectionnelle, fonctionne hors ligne, et stocke toutes ses données localement, chiffrées en AES-256-GCM. Aucune donnée ne transite par un serveur tiers : les seules communications sortantes vont vers l'application Anytype locale (`http://localhost:31009`).

Validée par `web-ext lint` (addons-linter Mozilla) : **0 erreur**.

## Installation

### Test (chargement temporaire)
1. Ouvrir Firefox → `about:debugging#/runtime/this-firefox`.
2. « Charger un module complémentaire temporaire… » → sélectionner `manifest.json` dans le dossier de l'extension.

### Production (installation permanente)
1. Le fichier `anytype-marks-1.0.0.zip` est prêt pour la soumission.
2. Le soumettre sur https://addons.mozilla.org/developers/ (distribution publique, ou signature « non répertoriée » pour un usage privé — le `.xpi` signé rendu par AMO s'installe ensuite par simple glisser-déposer dans Firefox).
3. Alternative entreprise : Firefox ESR + politique `xpinstall.signatures.required = false`.

## Première utilisation
1. Ouvrir Anytype Desktop et activer l'API locale (Paramètres → API).
2. Cliquer sur l'icône de l'extension → **Connecter Anytype**.
3. Saisir le code à 4 chiffres affiché par Anytype. Le token est stocké chiffré ; aucune reconnexion nécessaire sauf révocation.
4. Choisir l'espace Anytype cible (popup ou Paramètres). Les favoris Firefox existants sont alors importés et synchronisés.

## Fonctionnalités
- **Synchronisation bidirectionnelle** : création, modification, suppression, déplacement, tags, ordre — dans les deux sens, avec anti-écho.
- **Hors ligne** : toute opération est mise en file d'attente locale (chiffrée) et rejouée automatiquement dès qu'Anytype répond (opérations fusionnées : create+update → create, create+delete → annulé).
- **Conflits** : détection automatique ; politique configurable (dernière modification / Firefox / Anytype / demander) avec boîte de résolution côte à côte.
- **Sauvegarde de pages** : mode « lien uniquement » ou « sauvegarde complète » (HTML, texte, métadonnées, favicon, date), consultable même si le site disparaît. Capture depuis l'onglet actif, ou en arrière-plan si la permission optionnelle est accordée.
- **Gestionnaire complet** : liste virtualisée (fluide au-delà de 20 000 favoris), favicon, dossier, tags, date, indicateurs de synchronisation et de sauvegarde.
- **Recherche intelligente** : instantanée, partielle, insensible à la casse et aux accents, tolérante aux fautes de frappe ; porte sur titre, URL, tags, dossier et, sur demande, le contenu sauvegardé.
- **Filtres combinables** : A→Z / Z→A, date d'ajout, date de modification, dossier, tags, synchronisés / non synchronisés, sauvegarde complète / lien.
- **Organisation** : création / renommage / suppression de dossiers, déplacement et réorganisation par glisser-déposer.
- **Menu contextuel** : ouvrir, nouvel onglet, modifier, renommer, tags, déplacer, dupliquer, copier le lien, supprimer, forcer la synchronisation, ouvrir dans Anytype, voir la page sauvegardée.
- **Paramètres** : espace par défaut, sync automatique et fréquence, politique de conflit, mode de sauvegarde, images, thème clair/sombre/auto, notifications, taille max et purge automatique du cache.
- **Notifications discrètes** : succès, erreur, conflit, sauvegarde terminée (limitées à une par type et par minute).
- **i18n** : français et anglais (suit la langue de Firefox).

## Sécurité
- Chiffrement AES-256-GCM (WebCrypto) de l'index des favoris, de la file d'attente, du token Anytype et du contenu des pages (IndexedDB). La clé, générée aléatoirement, réside dans le stockage isolé de l'extension du profil Firefox.
- Le token n'est jamais affiché ni journalisé ; permissions d'hôte limitées à `localhost:31009` (la capture de pages en arrière-plan est une permission **optionnelle**, désactivée par défaut).

## Architecture
```
manifest.json                 MV3, background event page (compat. Firefox ≥ 115)
src/lib/util.js               namespace ABS, recherche floue, i18n, utilitaires
src/lib/crypto.js             AES-256-GCM (WebCrypto)
src/lib/store.js              stockage chiffré : storage.local + IndexedDB, quotas de cache
src/lib/anytype.js            client API locale Anytype (v. 2025-11-08) : challenge/API key,
                              espaces, objets bookmark, propriété tag, deep-links
src/lib/queue.js              file d'attente hors ligne avec coalescence
src/lib/mapper.js             passerelle browser.bookmarks (arbre, chemins, CRUD)
src/lib/sync.js               moteur bidirectionnel, conflits, badge, notifications
src/background/background.js  écouteurs, alarmes, capture de page, API de messages
src/popup/…                   ajout rapide + connexion Anytype
src/manager/…                 gestionnaire (liste virtuelle, filtres, DnD, conflits)
src/options/…                 paramètres
_locales/fr,en                traductions
```

Le portage Chrome/Edge/Brave est prévu : MV3, API `browser.*` (ajouter le polyfill `webextension-polyfill` et remplacer `background.scripts` par un service worker).

## Nouveautés 1.10.1 — lint AMO : 0 erreur, 0 avertissement
- **Readability.js patché** (modifications documentées dans l'en-tête du fichier, conformément à la licence Apache 2.0) : les affectations `innerHTML` sont remplacées par des opérations DOM équivalentes — restauration par cache de nœuds clonés, et `DOMParser` + `importNode` pour le contenu `<noscript>` (`createContextualFragment` est aussi signalé par le linter). Comportement vérifié par des tests d'extraction complets (jsdom), y compris la récupération d'image `<noscript>`. **Lint AMO : 0 erreur, 0 avertissement.**
- **Menu contextuel épuré** : « Renommer », « Changer les tags » et « Déplacer » sont retirés (tout est dans « Modifier »), ainsi que « Voir la page sauvegardée » (consultable depuis Anytype) ; la visionneuse et ses styles sont supprimés.

## Nouveautés 1.10.0 — préparation à la publication AMO
- **Manifeste conforme** : ajout de `browser_specific_settings.gecko.data_collection_permissions = { required: ["none"] }` (l'extension ne collecte ni ne transmet aucune donnée — déclaration officielle du consentement intégré Firefox) ; versions minimales relevées à Firefox 140 (desktop, ESR actuel) et 142 (Android), requises par cette clé et couvrant `optional_host_permissions` et `permissions.request`.
- **Zéro `innerHTML` dynamique dans notre code** : lignes du gestionnaire, barres latérales (dossiers, tags) et modale de conflit reconstruites en DOM pur (`createElement`/`textContent`), vidages en `replaceChildren()`, extraction d'article via `DOMParser` (document inerte, aucun script exécuté). Le lint passe de 12 avertissements à 2.
- **2 avertissements restants, tous deux dans `src/lib/vendor/Readability.js`** — la bibliothèque officielle de Mozilla qui motorise le mode Lecture de Firefox, incluse telle quelle (licence Apache 2.0). Ses `innerHTML` internes opèrent sur un document cloné inerte. Note pour l'examen AMO : fichier vendored non modifié, source https://github.com/mozilla/readability (v0.6.0).
- **Aide corrigée** : « (ou $var…) » affichait un seul `$` — en i18n WebExtensions, `$$` s'affiche `$` ; le message est correctement échappé et montre bien `$$var`.

## Nouveautés 1.9.2
- **Saisie des tags dans les règles** : chaque lettre créait un tag — la synchronisation à la frappe appelait `get()`, qui valide le texte en cours. Le composant expose maintenant un callback `onChange` déclenché uniquement quand un tag est réellement ajouté ou retiré ; la validation est identique au popup : **virgule, Entrée, clic sur une suggestion, ou sortie du champ**.
- **Aide des règles** : l'explication est réécrite et déplacée dans un **popup d'aide « ? »** à côté du titre de la section (fonctionnement, moment d'application, variables dynamiques avec l'exemple Travail/clients/<<client>> → Entreprise1, composition, regex) ; l'intro de la section devient une ligne courte.
- **Réordonnancement dans le gestionnaire** : un changement d'ordre seul n'était **jamais répercuté dans Firefox** (seul un changement de dossier déclenchait le déplacement) ; c'est corrigé, avec resynchronisation des voisins décalés vers Anytype. Le dépôt « en haut de liste » est aussi corrigé : l'index cible tient compte de la sémantique de `bookmarks.move` (position finale après retrait) lors d'une descente dans le même dossier.

## Nouveautés 1.9.1 — correctifs variables dynamiques
- **Popup** : les tags de règles n'apparaissaient qu'après un changement manuel de dossier — l'évaluation initiale partait avant le chargement du sélecteur. Les règles sont désormais évaluées dès l'ouverture, avec le dossier par défaut.
- **`<<var>>` fiabilisé** : deux cas faisaient échouer silencieusement la syntaxe `<<var>>` (là où `$$var` passait) — un nom avec tiret (`<<ma-var>>` → nom de groupe regex invalide) et la répétition d'une même variable dans une condition (groupe dupliqué → SyntaxError avalée). Les groupes reçoivent maintenant des noms techniques sûrs mappés vers vos variables, et toutes les regex du moteur sont locales (plus d'état partagé). Nouveaux tests : équivalence stricte `<<var>>`/`$$var`, tirets, variables répétées, mélange des syntaxes, appels en boucle.

## Nouveautés 1.9.0 — variables dynamiques dans les règles
- **Tags dynamiques `<<var>>` / `$$var`** : une condition peut capturer un segment de dossier — condition « dossier contient `Travail/clients/<<client>>` » + tag « `<<client>>` » → le dossier `Travail/clients/Entreprise1` produit le tag **Entreprise1**, `Travail/clients/dupons` produit **dupons**. Les deux syntaxes `<<var>>` et `$$var` sont acceptées ; plusieurs variables par condition sont possibles (`Travail/<<type>>/<<nom>>`) ; les tags peuvent composer (`projet-<<nom>>`) ; la casse d'origine est conservée ; un tag dont la variable n'est pas résolue est ignoré (jamais de tag vide). Avec l'opérateur regex, les groupes de capture deviennent `<<1>>`, `<<2>>` et les groupes nommés `(?<org>…)` deviennent `<<org>>`. Pour un dossier, une variable capture exactement **un segment** de chemin. Le tout est couvert par des tests automatisés, y compris vos deux exemples.

## Nouveautés 1.8.0
- **Règles de tags automatiques** (Paramètres → « Règles de tags automatiques ») : règles multiples, chacune avec un nom, un mode (« toutes les conditions » / « au moins une »), des conditions sur **Dossier / Titre / URL** avec les opérateurs **est égal à / commence par / contient / ne contient pas / regex**, et une liste de tags à ajouter (avec autocomplétion). Toutes les règles correspondantes s'appliquent. Effet **immédiat dans le popup** dès le choix du dossier (tags auto ajoutés/retirés en direct), **lors des déplacements** de favoris dans Firefox, à la création (étoile native comprise), à l'édition et au **renommage de dossiers** (chemins ré-évalués). Moteur testé sur les cas « dossier = pro », « travail/client1 → pro + clients », regex, exclusions.
- **Création de dossier avec choix du parent** : dialogue dédié (nom + dossier parent, présélectionné selon le contexte), y compris pour « Nouveau sous-dossier ».
- **Filtre de dossier strict** : sélectionner un dossier n'affiche plus que son **contenu direct** (plus les sous-dossiers).
- **Tri mémorisé** : le choix du tri du gestionnaire est conservé entre les sessions.
- **Épurations** : menu « Sauvegarde : tous/complète/lien » retiré (le tag « Sauvegardé » assure le filtrage), bouton « Conflits » retiré (résolution toujours accessible en cliquant une ligne en conflit ou via le menu contextuel).

## Nouveautés 1.7.0 — merge fiable avec un espace Anytype déjà peuplé
- **Pull avant flush (correctif critique du merge)** : à la première synchronisation d'un espace contenant déjà des bookmarks, l'import Firefox était envoyé AVANT l'adoption par URL → doublons dans Anytype, puis PATCH avec tags vides qui **effaçait les tags des originaux**. Le cycle est inversé : le pull (et l'adoption) s'exécute toujours en premier.
- **Adoption = fusion** : les tags sont désormais **unis** (jamais remplacés), la description distante est reprise si la locale est vide, et l'URL est canonisée (casse, barre finale, ancre) pour maximiser les correspondances.
- **Garde-fou absolu anti-effacement de tags** : une entrée locale sans tags face à un objet Anytype tagué fusionne d'abord les tags — quelle que soit la politique de conflit, aucune branche ne peut plus pousser une liste vide par-dessus des tags existants. Une **passe de réparation** re-synchronise aussi, sans condition d'horodatage, les entrées endommagées par les versions précédentes.
- **Ordre enfin exact dans la Barre personnelle** : les repositionnements ne sont plus appliqués au fil de l'eau (chaque insertion décalait les précédentes) mais collectés puis appliqués en **une passe finale triée par dossier et index croissant**, suivie d'une relecture de l'arbre pour réaligner l'index local. Testé.
- **Changement d'Espace sécurisé** : découvert à l'audit — changer d'espace faisait passer les objets de l'ancien espace pour supprimés et pouvait **effacer des favoris Firefox**. Les liens sont maintenant réinitialisés au changement d'espace ; l'adoption relie ce qui existe dans le nouvel espace, le reste y est créé.
- **Audit des paramètres** : chaque réglage a été vérifié de bout en bout (espace, sync auto + fréquence via alarme, politique de conflit, mode de sauvegarde, images, thème, notifications, taille et purge du cache).

## Nouveautés 1.6.0 — fiabilisation import/export pour la production
- **Cause racine des tags/dossiers effacés** : les réponses de l'endpoint de recherche d'Anytype peuvent être **partielles** (propriétés omises). L'extension traitait « propriété absente » comme « propriété vide », écrasait les tags/dossiers locaux, puis le push les effaçait dans Anytype. Désormais : absent = inconnu (`undefined`), et **toute application vers Firefox se fait depuis l'objet complet** (`GET /objects/{id}`), jamais depuis un résultat de recherche. Test automatisé couvrant ce scénario.
- **Suppressions confirmées** : un favori absent des résultats de recherche n'est plus supprimé de Firefox qu'après **confirmation par lecture directe** (404/410/archivé). Une réponse incomplète ou une erreur transitoire ne peut plus détruire de données.
- **Propriété « Ordre Firefox »** (nombre, créée automatiquement) : l'ordre des favoris dans leur dossier est exporté vers Anytype, appliqué au pull (positionnement à l'index), et les voisins décalés par un déplacement sont resynchronisés (réconciliation débouncée). Limitation assumée : l'ordre des dossiers eux-mêmes n'est pas représentable dans Anytype (les dossiers n'y sont pas des objets).
- **Anti-doublons (adoption par URL)** : au pull, un objet Anytype correspondant à une entrée locale non encore liée (même URL) est **lié** au lieu de créer un doublon — protège les réinstallations et les imports croisés.
- **Course onCreated neutralisée** : l'événement Firefox pouvait précéder le guard du créateur (pull ou formulaire) et fabriquer une entrée doublon sans tags ; un délai de revérification l'élimine.

## Nouveautés 1.5.0
- **Connexion guidée** : après la saisie du code Anytype, le popup enchaîne sur le **choix de l'Espace** (liste déroulante + validation) au lieu d'un choix automatique.
- **Tag « Sauvegardé » automatique** : toute page sauvegardée reçoit le tag « Sauvegardé » (retiré si l'on repasse en lien seul ou si le cache est vidé), synchronisé vers Anytype comme les autres tags. Le badge dédié du gestionnaire disparaît au profit de ce tag.
- **Lignes du gestionnaire épurées** : l'URL et le dossier ne sont plus affichés dans les lignes (consultables en infobulle sur le titre) ; les tags gagnent la place libérée.
- **Bouton « Barre personnelle » retiré** : il faisait doublon avec l'arborescence des dossiers.
- **Ligne d'état enfin centrée** : le `flex: 1` du texte de statut l'étirait sur toute la largeur et neutralisait le centrage — corrigé.

## Nouveautés 1.4.0
- **Anytype → Firefox : l'organisation est respectée.** Le pull lit la propriété « Dossier Firefox » de chaque objet : un bookmark créé dans Anytype est rangé dans le dossier Firefox correspondant (chaîne de dossiers créée si nécessaire), et un changement de cette propriété dans Anytype **déplace** le favori dans Firefox. Sans propriété renseignée, repli sur « Autres marque-pages ».
- **Sélecteur de dossiers hiérarchique** : le popup et l'éditeur affichent « Barre personnelle », « – S4I », « –– sous dossier » (le chemin complet reste visible en infobulle) au lieu de répéter les chemins.
- **Popup allégé** : le choix de l'Espace Anytype est retiré — l'espace configuré dans les Paramètres fait foi (à la première connexion, le premier espace disponible est sélectionné automatiquement).
- **Gestionnaire** : la ligne d'état (ruban + « Anytype connecté ») est centrée dans la barre latérale.

## Nouveautés 1.3.1
- **Permissions (correctif important)** : les motifs d'hôte du manifeste contenaient un numéro de port (`http://localhost:31009/*`), ce qui est interdit par la spécification des match patterns — Firefox les ignorait silencieusement, et seule la permission « tous les sites web » faisait fonctionner l'extension. Les motifs sont désormais valides (`http://localhost/*`, `http://127.0.0.1/*`, couvrant tous les ports dont 31009). De plus, comme Firefox MV3 n'accorde pas ces permissions à l'installation, un clic sur « Connecter Anytype » ouvre maintenant la demande de permission native ; en cas de refus, un message explicite s'affiche. Vous pouvez retirer « Accéder à vos données pour tous les sites web » : elle n'est plus nécessaire (elle reste proposée en option uniquement pour la capture de pages en arrière-plan).
- **Gestionnaire** : l'en-tête « Anytype Marks » (ruban + titre) est centré dans la barre latérale.

## Nouveautés 1.3.0
- **Tags depuis le popup (cause réelle trouvée)** : un tag tapé sans appuyer sur Entrée restait dans le champ de saisie et n'était jamais envoyé — c'est pourquoi le clic droit « Changer les tags » fonctionnait mais pas le formulaire d'ajout. Le texte en attente est désormais validé automatiquement à l'envoi du formulaire et à la perte de focus. Le cache des propriétés tag/dossier réessaie par ailleurs après 60 s au lieu de mémoriser un échec définitivement.
- **Étiquettes natives Firefox** : impossible à synchroniser — l'API WebExtensions n'expose pas les étiquettes des marque-pages (Bugzilla 1225916, jamais résolu ; aucune extension signée ne peut y accéder). Les tags de l'extension, chiffrés localement et synchronisés avec Anytype, en sont le remplacement.
- **Icônes** : redessinées en 1024 px (dégradés, ombre portée, reflet) puis réduites en LANCZOS — nettes à toutes les tailles (16→128, +64 px ajoutée).
- **Popup** : l'option « Sauvegarde complète » est **grisée automatiquement** si la page n'a pas de mode Lecture (détection par le module officiel `isProbablyReaderable` de Firefox) ; bouton « Ouvrir le gestionnaire » agrandi (44 px).
- **Ergonomie** : bandeau des filtres actifs sur fond `var(--bg)` (#f7f6f3 clair / #1c1b22 sombre) avec padding 10 px ; icônes des boutons Synchroniser/Paramètres passées à 30 px ; bloc « état vide » supprimé.

## Nouveautés 1.2.0
- **Sauvegarde de pages** : le corps envoyé à Anytype est désormais du **Markdown structuré** (titres, paragraphes avec vrais retours à la ligne, listes, citations, code, liens) incluant les **images de l'article** `![…](url)`. Dans la visionneuse locale, une image dont l'incrustation en data-URL échoue (blocage CORS inter-domaines) conserve son URL d'origine au lieu de disparaître.
- **Tags à la création (correctif définitif)** : deux courses d'exécution corrigées — l'opération portant les tags n'est plus absorbée par une création déjà en cours d'envoi, et la file ne réécrit plus une version périmée de l'entrée après l'appel réseau (ce qui effaçait les tags posés pendant l'envoi). Test automatisé ajouté.
- **Arborescence** : la Barre personnelle apparaît en premier (puis Menu, Autres, Mobile) ; les racines système vides sont masquées ; l'ordre suit l'arbre Firefox et non plus l'alphabet.
- **Mise en page** : barre latérale élargie (285 px) avec boutons Synchroniser/Paramètres empilés pleine largeur (plus jamais coupés) ; le panneau de droite est une surface blanche continue jusqu'au bas de la fenêtre.

## Nouveautés 1.1.0
- **Tags** : association fiable dès la création (PATCH de confirmation après le POST), suppression de tous les tags répercutée dans Anytype, champ de saisie avec autocomplétion des tags existants (Anytype + locaux) dans le popup et l'éditeur.
- **Débit API** : limiteur token-bucket aligné sur les limites d'Anytype (rafale de 60, puis 1 req/s), reprise automatique sur 429/503 avec Retry-After, la file se vide désormais seule sans re-cliquer, opérations en échec répété abandonnées après 10 essais.
- **Sauvegarde de pages** : extraction via **Readability.js** (le moteur du mode Lecture de Firefox) — contenu principal sans parasites, **images de l'article incrustées** en data-URL (15 max, 4 Mo par page), visionneuse mise en page dans une iframe sandbox.
- **Dossiers** : renommage et déplacement de dossiers Firefox répercutés dans Anytype ; le chemin du dossier est stocké dans une **propriété dédiée « Dossier Firefox »** (créée automatiquement dans l'espace) et non plus dans le corps.
- **Gestionnaire** : filtre « Barre personnelle », liste occupant toute la hauteur, rangées et textes agrandis (~10 %), boutons Synchroniser/Paramètres élargis et libellés, compteur intégré à la barre d'outils, recherche dans le contenu sauvegardé désormais automatique (la case dédiée a été retirée).

## Limites connues
- L'ordre exact et la hiérarchie de dossiers Firefox sont reflétés dans Anytype via le corps de l'objet (Anytype n'a pas de notion native de dossiers de favoris) ; les collections Anytype sont prévues en évolution future.
- La capture de pages protégées (about:, AMO, PDF viewer) n'est pas possible — limitation de Firefox.
