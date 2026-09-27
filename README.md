# JML Annonces Auto

Application web destinée à transformer une annonce JML Immobilier en publication sociale standardisée.

## V1

- Coller une URL JML Immobilier.
- Vérifier que l'URL appartient bien à www.jml-immobilier.fr.
- Récupérer les données visibles de l'annonce.
- Détecter les images originales présentes sur la page.
- Afficher les photos récupérées pour contrôle.
- Interdire conceptuellement tout remplacement par une image générée.

### Règle non négociable

**Les photos d'une annonce doivent rester les photos originales de cette annonce.**

Si aucune photo originale n'est récupérée, l'étape de publication devra être bloquée. L'IA pourra ensuite aider à rédiger le texte, mais ne doit pas inventer ou remplacer les photos du bien.

## Lancer localement

```bash
npm install
npm start
```

Puis ouvrir http://localhost:3000
