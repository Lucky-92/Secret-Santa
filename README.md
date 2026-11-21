# 🎁 Secret Santa

Petit site statique de Secret Santa : un QR code, un code de groupe, des inscriptions, un tirage au sort automatique et secret.

- **Front** : HTML/CSS/JS simples, hébergés sur GitHub Pages.
- **Back** : Supabase (offre gratuite). Tout passe par des fonctions RPC, et la RLS bloque tout accès direct aux tables.
- **Secret** : aucune page ni fonction n'affiche la liste des paires. Chacun ne voit que la personne à qui il offre, avec son prénom et son code personnel.

## Contenu du dépôt

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css`, `app.js` | Le site |
| `config.js` | URL Supabase + clé publique `anon` (à remplir) |
| `qr.html` | Outil pour générer le QR code en PNG |
| `supabase.sql` | Tables, RLS, fonctions (à coller dans Supabase) |
| `config.example.sql` | Modèle de configuration : code du groupe, dates, budget, exclusions |

> 🔒 Le dépôt est public : il ne contient **aucune donnée personnelle**. Le code du groupe, les dates, les prénoms et les exclusions sont saisis **directement dans Supabase**, jamais dans un fichier commité.

---

## 1. Créer le projet Supabase

1. Créez un compte sur <https://supabase.com>, puis cliquez sur **New project**.
2. Donnez-lui un nom (ex. `secret-santa`), choisissez un mot de passe de base de données (gardez-le pour vous) et une région proche, par exemple **West EU (Paris)**.
3. Attendez environ 1 minute que le projet soit prêt.

## 2. Installer la base

1. Dans le menu de gauche, ouvrez **SQL Editor**, puis **New query**.
2. Copiez-collez **tout** le contenu de `supabase.sql` et cliquez sur **Run**. Le message attendu est « Success. No rows returned ».

Le script peut être relancé sans perdre de données, par exemple après une mise à jour.

## 3. Configurer votre Secret Santa

1. Dans le SQL Editor, ouvrez une **nouvelle** requête.
2. Collez le contenu de `config.example.sql` et modifiez les lignes marquées `<-- À MODIFIER` :
   - **code du groupe** (6 caractères minimum, majuscules et minuscules indifférentes), par exemple `SAPIN-7342` ;
   - **fin des inscriptions** et **date du tirage**, en heure de Paris ;
   - **budget** et **date d'échange** (texte libre) ;
   - **exclusions** éventuelles, par exemple Léa et Tom qui ne doivent pas se tirer entre eux.
3. Cliquez sur **Run**. La dernière requête affiche un récapitulatif à vérifier.

⚠️ Ne remplissez pas `config.example.sql` dans le dépôt. Si vous voulez garder une copie locale, nommez-la `config.sql` : elle est ignorée par Git.

Le code du groupe est stocké **haché** : même dans la base, personne ne peut le relire. Pour le changer, relancez simplement `select private.set_group_code('NOUVEAU-CODE');`.

## 4. Brancher le site sur Supabase

1. Dans Supabase, ouvrez **Project Settings**, puis **API Keys** (ou **Data API**). Récupérez :
   - la **Project URL**, par exemple `https://abcdefghijkl.supabase.co` ;
   - la clé **`anon` `public`** (`eyJ…`) **ou** la clé **publishable** (`sb_publishable_…`).
2. Collez-les dans `config.js`.

> ⛔ **Jamais** la clé `service_role` ni une clé `secret` (`sb_secret_…`). Le site refuse de démarrer s'il en détecte une.
> La clé `anon` est faite pour être publique : avec elle, on ne peut appeler que les 5 fonctions prévues.

**Tester en local (facultatif)** : depuis le dossier du projet, lancez `python -m http.server 8000`, puis ouvrez <http://localhost:8000>.

## 5. Publier sur GitHub Pages

1. Sur GitHub, créez un dépôt **public**, par exemple `secret-santa`.
2. Envoyez-y les fichiers :
   ```bash
   git init
   git add .
   git commit -m "Secret Santa"
   git branch -M main
   git remote add origin https://github.com/VOTRE-PSEUDO/secret-santa.git
   git push -u origin main
   ```
3. Sur GitHub, ouvrez **Settings**, puis **Pages**. Sous **Source**, choisissez **Deploy from a branch**, puis la branche **main** et le dossier **/ (root)**. Cliquez sur **Save**.
4. Après une à deux minutes, le site est en ligne à l'adresse `https://VOTRE-PSEUDO.github.io/secret-santa/`.

## 6. Générer le QR code

1. Ouvrez `https://VOTRE-PSEUDO.github.io/secret-santa/qr.html`.
2. L'adresse du site est déjà remplie. Cliquez sur **Télécharger le PNG**.
3. Partagez l'image, et donnez le **code du groupe** à part (à l'oral, par message…) : le QR code ne contient que l'adresse.

---

## 🧪 Tester le tirage avant le vrai

Dans le SQL Editor :

```sql
-- Inscriptions closes dans 3 minutes, tirage dans 5 minutes
select private.test_mode(3, 5);
```

1. Ouvrez le site sur 2 ou 3 téléphones (ou onglets en navigation privée) et inscrivez des prénoms fictifs. Notez les codes.
2. Laissez le compte à rebours arriver à zéro sur une page ouverte : le tirage se déclenche tout seul.
3. Avec chaque prénom et son code, vérifiez que chacun voit une seule personne, jamais lui-même.
4. Contrôlez le tirage **sans voir les paires** :
   ```sql
   select * from private.check_draw();
   ```
   Le résultat indique le nombre d'attributions, les auto-attributions (toujours 0), les paires réciproques (0), la longueur du cycle (égale au nombre d'inscrits), les exclusions non respectées (toujours 0) et les exclusions dont un prénom n'est pas inscrit (pratique pour repérer une faute de frappe).
5. Remettez tout à zéro, puis relancez votre configuration (étape 3) avec les vraies dates :
   ```sql
   select private.reset_all();   -- supprime les inscrits de test et le tirage
   ```

---

## 🔑 Espace organisateur (sur le site)

Le lien **« Espace organisateur »** se trouve en bas de page. On peut aussi y aller directement avec l'adresse du site suivie de `#admin`. Il permet de :

- voir le nombre d'inscrits, leurs prénoms, les dates et l'état du tirage (**jamais les paires**) ;
- **fixer le temps restant avant le tirage** (jours, heures, minutes à partir de maintenant ; si tout vaut 0, le tirage a lieu dans 1 minute). Un tirage déjà effectué est annulé et refait à la nouvelle heure. Si la fin des inscriptions est déjà passée, ou tombe après la nouvelle heure de tirage, elle est alignée sur le tirage, ce qui rouvre les inscriptions jusque-là ;
- **rincer les participants**, c'est-à-dire supprimer tous les inscrits et le tirage ;
- changer le mot de passe (8 caractères minimum).

**Activer le compte** (une fois, dans le SQL Editor, avec vos propres valeurs) :
```sql
select private.set_admin('identifiant', 'mot-de-passe');
```
L'identifiant et le mot de passe ne sont jamais dans le dépôt. Le mot de passe est stocké haché. Après 5 essais ratés, l'espace est bloqué 15 minutes. Pour le débloquer plus tôt : `select private.admin_unlock();`. En cas d'oubli, relancez simplement `private.set_admin(...)`.

---

## 🛠️ Commandes utiles pour l'organisateur (SQL Editor)

| Besoin | Commande |
|---|---|
| Vérifier le tirage sans voir les paires | `select * from private.check_draw();` |
| Quelqu'un a perdu son code | `select private.new_personal_code('Prénom');` renvoie un nouveau code à lui transmettre |
| Supprimer une inscription (avant le tirage) | `select private.delete_participant('Prénom');` |
| Ajouter une exclusion | `insert into public.exclusions values ('Léa', 'Tom');` |
| Annuler le tirage (garder les inscrits) | `select private.reset_draw();` |
| Tout remettre à zéro | `select private.reset_all();` |
| Changer le code du groupe | `select private.set_group_code('NOUVEAU-CODE');` |

Ces fonctions sont dans le schéma `private`, qui n'est pas exposé par l'API. Le site ne peut donc pas les appeler.

---

## Fonctionnement

1. **Accueil** : le visiteur saisit le code du groupe, vérifié côté serveur (`check_group_code`, comparaison bcrypt). Il est ensuite mémorisé sur l'appareil.
2. **Inscription** (jusqu'à la date limite) : prénom + liste d'envies facultative. Les doublons sont bloqués sans tenir compte des majuscules, des accents ni des espaces (« Léa » = « lea »).
3. **Code personnel** : 6 caractères aléatoires générés côté serveur (alphabet sans `0`, `O`, `1`, `I`), affichés **une seule fois**. Seul leur hash bcrypt est stocké.
4. **Compte à rebours** jusqu'au tirage, calé sur l'horloge du serveur.
5. **Tirage** : le premier visiteur après l'heure le déclenche. La fonction est idempotente et verrouillée : même si plusieurs personnes arrivent à la même seconde, il n'y a qu'un tirage. Le tirage forme un **cycle unique** : on mélange les participants, chacun offre au suivant et le dernier au premier (A → B → C → … → A). Personne ne tombe sur soi-même, il n'y a pas de paire réciproque (A ↔ B, sauf avec seulement 2 inscrits), et les exclusions sont respectées.
6. **Révélation** : prénom + code personnel affichent uniquement la personne à qui l'on offre et sa liste d'envies. Après 10 codes faux, le prénom est bloqué 15 minutes.
7. Chacun peut **modifier sa liste d'envies** à tout moment avec son code, y compris après le tirage.

### Sécurité

- RLS activée sur les 4 tables, sans aucune policy, et privilèges retirés à `anon` et `authenticated` : la clé publique ne lit ni n'écrit aucune table.
- Seules 5 fonctions RPC sont exécutables par `anon` : `check_group_code`, `get_event_info`, `register_participant`, `update_wishlist` et `get_my_match`. Aucune ne renvoie de paire autre que la sienne.
- Le code du groupe et les codes personnels ne sont stockés que sous forme de hash.
- Le site affiche tous les textes sans jamais injecter de HTML (pas de XSS possible via une liste d'envies).

**Limite à connaître** : en tant que propriétaire du projet Supabase, vous pouvez techniquement ouvrir la table `assignments` dans le Table Editor. Ne le faites pas 😉 et utilisez `private.check_draw()`. Aucun autre participant ne peut le faire.

### ⚠️ Pause des projets gratuits

Supabase met en **pause** un projet gratuit après environ 7 jours sans activité. Si les inscriptions sont longues ou s'il y a un creux avant le tirage, connectez-vous au tableau de bord quelques jours avant le tirage et cliquez sur **Restore** si le projet est en pause. Toutes les données sont conservées.
