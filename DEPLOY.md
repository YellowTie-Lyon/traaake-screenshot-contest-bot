# Déploiement VPS — Traaake Bot

## Prérequis

- Node.js >= 18
- PM2 (`npm install -g pm2`)
- Un fichier `.env` sur le VPS (copié depuis `.env.example`)

## 1. Migration Supabase

Dans l'éditeur SQL de Supabase, exécuter :

```
supabase/migrations/001_environments_bot_fields.sql
```

Puis renseigner les valeurs pour chaque ligne de la table `environments` :

| Colonne | Valeur |
|---|---|
| `discord_bot_token` | Token de l'application Discord correspondante |
| `discord_app_id` | Client ID de l'application Discord |
| `is_active` | `false` par défaut (le dashboard gère l'activation) |

## 2. Variables d'environnement sur le VPS

Créer `/home/bot/traaake-screenshot-contest-bot/.env` :

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
ENVIRONMENT_ID_PROD=<uuid de la ligne prod dans environments>
ENVIRONMENT_ID_TEST=<uuid de la ligne test dans environments>
```

## 3. Démarrage

```bash
git clone https://github.com/YellowTie-Lyon/traaake-screenshot-contest-bot
cd traaake-screenshot-contest-bot
npm install --omit=dev

# Charger le .env dans le shell courant pour que PM2 le transmette
set -a && source .env && set +a

pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # pour que PM2 redémarre au reboot du VPS
```

## 4. Commandes utiles

```bash
pm2 status                    # état des deux processus
pm2 logs traaake-bot-prod     # logs prod en temps réel
pm2 logs traaake-bot-test     # logs test en temps réel
pm2 restart traaake-bot-prod  # redémarrage manuel
```

## 5. Flux de basculement TEST ↔ PROD

1. Dans le dashboard → sélectionner l'environnement cible
2. Supabase met `environments.is_active = true` pour la cible, `false` pour l'autre
3. Le processus bot inactif reçoit l'event Realtime → se connecte à Discord
4. L'ancien processus actif reçoit `is_active = false` → se déconnecte proprement

**Aucun redémarrage du VPS ou de PM2 n'est nécessaire.**

## 6. Sécurité — RLS sur `environments`

Ajouter cette policy Supabase pour que `discord_bot_token` ne soit jamais lisible
depuis le frontend (client anon) :

```sql
-- Le frontend ne peut lire que id, name, is_active
create policy "anon can read safe fields only"
  on environments for select
  to anon
  using (true)
  with check (false);

-- Bloquer l'accès au token depuis le client anon via une vue
create view public.environments_public as
  select id, name, is_active, discord_app_id
  from environments;
```

Les tokens restent accessibles uniquement via `service_role` (utilisé par le bot et
le backend du dashboard pour écrire `is_active`).
