# JML Studio — version indépendante de test

Cette application est isolée dans le dossier `jml-studio/`. Elle ne charge aucun script, aucune feuille de style et aucune API de JML Annonce.

## Déploiement de test sur Render

Créer un **nouveau service Static Site** relié au dépôt `RahimBou/Jml-annonces` avec :

- **Branch** : `feature/jml-studio-standalone`
- **Root Directory** : `jml-studio`
- **Build Command** : laisser vide
- **Publish Directory** : `.`

Le service Render est distinct de JML Annonce. Ne pas modifier le service Render existant.

## Fonctionnalités présentes

- Formats carré, portrait, story et paysage
- Import de photos depuis l'appareil
- Textes et formes, déplacement et redimensionnement
- Modèles éditoriaux JML
- Pages multiples
- Sauvegarde et réouverture locale via IndexedDB
- Export PNG d'une page
- Export ZIP des pages sans bibliothèque externe

## Limites connues

Les projets sont sauvegardés localement dans le navigateur et ne sont pas synchronisés entre appareils. L'import des annonces et la publication sur les réseaux sociaux ne sont pas connectés dans cette version de test.
