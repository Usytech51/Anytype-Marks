# Anytype-Marks
Sync your Firefox bookmarks with Anytype, locally and encrypted (AES-256). Two-way, offline-first, tags with automatic rules, Reader-Mode page snapshots, folders and ordering preserved. No data ever leaves your machine — no third-party server.


Français

Anytype Marks synchronise vos favoris Firefox avec Anytype, l'espace de travail local-first et chiffré. Tout se passe entre Firefox et l'application Anytype installée sur votre machine : aucun serveur tiers, aucune collecte de données.

Synchronisation bidirectionnelle
Créations, modifications, suppressions, déplacements, tags et ordre sont répercutés dans les deux sens. Le dossier et la position de chaque favori sont stockés dans des propriétés Anytype dédiées (« Dossier Firefox », « Ordre Firefox ») : votre organisation est reconstruite fidèlement, dossiers créés au besoin. Les conflits sont détectés et résolus selon votre politique (dernière modification, Firefox prioritaire, Anytype prioritaire, ou demande à chaque fois) avec une comparaison côte à côte.

Fonctionne hors ligne
Anytype fermé ? Pas de connexion ? Chaque opération est mise en file d'attente locale chiffrée et rejouée automatiquement dès qu'Anytype répond — sans intervention, en respectant les limites de débit de l'API.

Tags intelligents
Champ de tags avec autocomplétion (tags Anytype + locaux). Règles de tags automatiques configurables : selon le dossier, le titre ou l'URL (égal, commence par, contient, ne contient pas, regex), avec variables dynamiques — la condition « Travail/clients/<<client>> » et le tag « <<client>> » donnent automatiquement le tag « Entreprise1 » à un favori rangé dans Travail/clients/Entreprise1. Les tags apparaissent dès le choix du dossier dans le popup et suivent les déplacements.

Sauvegarde des pages
En un clic, l'article est extrait avec Readability (le moteur du mode Lecture de Firefox), images comprises, et conservé chiffré localement puis en Markdown structuré dans Anytype — consultable même si le site disparaît. Un tag « Sauvegardé » est ajouté automatiquement.

Gestionnaire complet
Liste virtualisée fluide au-delà de 20 000 favoris, recherche instantanée tolérante aux fautes et aux accents (portant aussi sur le contenu des pages sauvegardées), filtres combinables, glisser-déposer (dossiers et réorganisation), arborescence avec la Barre personnelle en tête, thème clair/sombre intégré à Firefox, interface en français et en anglais.

Sécurité et vie privée
Toutes les données locales (index, file d'attente, token, pages) sont chiffrées en AES-256-GCM. Les seules communications sortantes vont vers l'API locale d'Anytype (localhost). L'extension ne collecte ni ne transmet aucune donnée.

Prérequis : application Anytype Desktop avec l'API locale activée (Paramètres → API). Connexion en 30 secondes par code à 4 chiffres.

English

Anytype Marks syncs your Firefox bookmarks with Anytype, the local-first encrypted workspace. Everything happens between Firefox and the Anytype app on your machine: no third-party server, no data collection.

Two-way sync
Creations, edits, deletions, moves, tags and ordering flow both ways. Each bookmark's folder and position are stored in dedicated Anytype properties ("Dossier Firefox", "Ordre Firefox"), so your organization is rebuilt faithfully — folders created on the fly. Conflicts are detected and resolved by your chosen policy (latest change, Firefox wins, Anytype wins, or ask every time) with a side-by-side comparison.

Offline-first
Anytype closed? No connection? Every operation is queued in an encrypted local queue and replayed automatically as soon as Anytype responds — no clicks needed, API rate limits respected.

Smart tags
Tag field with autocompletion (Anytype + local tags). Configurable automatic tag rules based on folder, title or URL (equals, starts with, contains, does not contain, regex) with dynamic variables — condition "Work/clients/<<client>>" and tag "<<client>>" automatically tag a bookmark filed under Work/clients/Company1 with "Company1". Tags appear as soon as you pick a folder in the popup and follow bookmark moves.

Page snapshots
One click extracts the article with Readability (the engine behind Firefox Reader Mode), images included, stored encrypted locally and as structured Markdown in Anytype — readable even if the site disappears. A "Saved" tag is added automatically.

Full manager
Virtualized list smooth beyond 20,000 bookmarks, instant typo- and accent-tolerant search (including saved page content), combinable filters, drag & drop (folders and reordering), folder tree with the Bookmarks Toolbar first, light/dark theme matching Firefox, French and English UI.

Security & privacy
All local data (index, queue, token, pages) is encrypted with AES-256-GCM. The only outgoing traffic goes to Anytype's local API (localhost). The extension collects and transmits nothing.

Requirement: Anytype Desktop with the local API enabled (Settings → API). Connect in 30 seconds with a 4-digit code.

