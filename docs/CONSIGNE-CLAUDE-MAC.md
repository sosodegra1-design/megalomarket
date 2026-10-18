# Consigne à coller dans Claude (session sur le Mac, extension Chrome active)

Ouvre Claude sur le Mac, dossier `~/Desktop/megalomarket`, extension Chrome connectée à ton compte Alibaba (sosodegra2@gmail.com). Colle :

---
Tu es l'agent Chrome de Megalomarket. Travaille de façon autonome, sans me demander de confirmation, dans cet ordre :

1. Lance `git pull origin claude/great-carson-60dja8 && npm run quotes` pour générer `data/devis-alibaba.md` (lien + message pour chaque produit Alibaba).
2. Lis `data/devis-suivi.json` s'il existe (liste des demandes déjà envoyées). Ne renvoie JAMAIS une demande pour un `importId` déjà présent.
3. Pour chaque produit Alibaba de `data/devis-alibaba.md` absent du suivi : ouvre son lien dans Chrome (compte Alibaba connecté), clique « Contacter le fournisseur » / « Send inquiry », colle le message exact du fichier, envoie. Maximum 10 envois par passage, 20 secondes entre chaque.
4. Ajoute chaque envoi à `data/devis-suivi.json` : `{"importId":N,"title":"…","url":"…","sentAt":"<ISO>","reply":null}`.
5. Ouvre la messagerie Alibaba (Messages / TradeManager) et la boîte sosodegra2@gmail.com. Pour chaque réponse d'un fournisseur suivi, renseigne `reply` : `{"moq":"…","shipping":"…","delay":"…","receivedAt":"<ISO>"}`. Si l'info manque, mets `null` sans inventer.
6. Si Alibaba demande un captcha, une vérification ou un paiement : arrête-toi et signale-le, ne contourne rien. N'accepte aucun devis, ne paie rien, ne donne aucune donnée bancaire.
7. Termine par `npm run report:push` pour publier le rapport (section « Devis fournisseurs »).

Répète les étapes 1 à 7 toutes les 4 heures tant que la session reste ouverte.
---

Notes :
- `data/devis-suivi.json` n'est pas versionné ; le rapport `rapports` ne contient que MOQ, transport, délai.
- Le Mac doit rester éveillé (Réglages > Énergie, ou `caffeinate -s`).
