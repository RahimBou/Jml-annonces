# JML Studio — application indépendante

JML Studio est une application autonome dans le dossier `jml-studio/`. Elle possède son propre serveur Node.js, son propre éditeur et son propre parseur d'annonces. Elle ne charge aucun script, aucune feuille de style, aucune route ni aucune API de JML Annonces.

## Déploiement de test sur Render

La configuration Blueprint de référence se trouve à la racine du dépôt : `/render.yaml`. Elle déclare deux services distincts : JML Annonces et JML Studio.

Paramètres attendus pour le service Studio :

- **Type** : Web Service
- **Service** : `jml-studio-test`
- **Branch** : `main`
- **Root Directory** : `jml-studio`
- **Build Command** : `npm install`
- **Start Command** : `npm start`
- **Health check path** : `/api/health`

Le fichier `jml-studio/render.yaml` est un rappel de configuration cohérent avec le Blueprint racine. Il ne remplace pas la configuration du Blueprint racine.

Ne pas modifier le service Render existant de JML Annonces pour déployer Studio. Studio doit être un service Web indépendant.

Après déploiement, vérifier :

- `https://jml-studio-test.onrender.com/` affiche l'éditeur.
- `https://jml-studio-test.onrender.com/api/health` renvoie un JSON avec `ok: true` et `service: "jml-studio-independent"`.

## Import d'une annonce JML Immobilier

1. Coller le lien public d'une annonce de `https://www.jml-immobilier.fr`.
2. Le serveur autonome télécharge directement la page source.
3. Le parseur local, isolé de JML Annonces, extrait les informations structurées, les caractéristiques et les photos de la galerie principale.
4. Les photos originales sont vérifiées par téléchargement. Jusqu'à 8 photos sont importées dans l'éditeur.
5. Studio crée une page portrait éditable par photo, avec titre, localisation, prix et caractéristiques lorsqu'ils sont disponibles.

Les téléchargements de pages et de photos suivent les redirections uniquement si chaque destination reste sur un domaine HTTPS autorisé de JML Immobilier. Les téléchargements sont limités en taille.

Le service n'appelle pas `jml-annonces.onrender.com` et n'utilise pas son endpoint `/api/scrape`.

## Fonctions de l'éditeur

- Formats carré, portrait, story et paysage
- Import de photos depuis l'appareil
- Import d'annonces JML Immobilier par URL
- Modèles éditoriaux JML
- Textes et formes, déplacement et redimensionnement
- Pages multiples
- Sauvegarde et réouverture locale via IndexedDB
- Export PNG d'une page
- Export ZIP des pages sans bibliothèque externe

## Limites de cette version de test

- Les projets sont enregistrés dans le navigateur utilisé ; pas de synchronisation entre appareils.
- L'import dépend de la structure HTML et de la galerie du site source. Les annonces sans galerie détectable ou dont les photos ne sont pas accessibles seront signalées.
- Les publications sur les réseaux sociaux ne sont pas déclenchées automatiquement par l'import. L'export reste soumis à validation.
