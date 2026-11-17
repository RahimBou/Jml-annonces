# JML Studio — application indépendante

JML Studio est une application autonome dans le dossier `jml-studio/`. Elle possède son propre serveur Node.js, son propre éditeur et son propre parseur d'annonces. Elle ne charge aucun script, aucune feuille de style, aucune route ni aucune API de JML Annonce.

## Déploiement de test sur Render

Le dépôt contient `render.yaml` pour créer un service Web indépendant.

Paramètres équivalents si le service est créé manuellement :

- **Type** : Web Service
- **Branch** : `feature/jml-studio-standalone`
- **Root Directory** : `jml-studio`
- **Build Command** : `npm install`
- **Start Command** : `npm start`
- **Health check path** : `/api/health`

Ne pas modifier le service Render existant de JML Annonce.

## Import d'une annonce JML Immobilier

1. Coller le lien public d'une annonce de `https://www.jml-immobilier.fr`.
2. Le serveur autonome télécharge directement la page source.
3. Le parseur local, isolé de JML Annonce, extrait les informations structurées, les caractéristiques et les photos de la galerie principale.
4. Les photos originales sont vérifiées par téléchargement. Jusqu'à 8 photos sont importées dans l'éditeur.
5. Studio crée une page portrait éditable par photo, avec titre, localisation, prix et caractéristiques lorsqu'ils sont disponibles.

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
