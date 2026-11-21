-- =====================================================================
--  Configuration de VOTRE Secret Santa
-- ---------------------------------------------------------------------
--  1. Copiez ce fichier dans Supabase > SQL Editor > New query.
--  2. Remplacez les valeurs marquées  <-- À MODIFIER.
--  3. Run.
--
--  ⚠️ Ne committez PAS une version remplie de ce fichier dans le dépôt
--  public (code du groupe, prénoms…). Si vous voulez en garder une copie
--  locale, appelez-la config.sql : elle est ignorée par .gitignore.
--  Ce script peut être relancé autant de fois que nécessaire.
-- =====================================================================

-- 1) Code d'accès du groupe (au moins 6 caractères, majuscules/minuscules indifférentes).
--    Choisissez quelque chose de pas trop devinable, ex. SAPIN-7342.
select private.set_group_code('CHANGEZ-MOI-2026');                         -- <-- À MODIFIER

-- 1 bis) Compte organisateur du site (lien « Espace organisateur » en bas de page).
--        Identifiant : 3 caractères min. Mot de passe : 6 caractères min.
--        (vous pourrez le changer ensuite depuis l'espace organisateur)
select private.set_admin('IDENTIFIANT', 'MOT-DE-PASSE');                   -- <-- À MODIFIER

-- 2) Dates (heure de Paris), budget, date d'échange.
update public.settings set
  event_name            = 'Secret Santa',                                   -- <-- À MODIFIER (titre affiché)
  registration_deadline = '2026-12-10 20:00'::timestamp at time zone 'Europe/Paris',  -- <-- fin des inscriptions
  draw_at               = '2026-12-12 18:00'::timestamp at time zone 'Europe/Paris',  -- <-- date du tirage
  budget                = '30 €',                                           -- <-- À MODIFIER
  exchange_date         = 'Samedi 20 décembre 2026'                         -- <-- À MODIFIER (texte libre)
where id = 1;

-- 3) Exclusions (facultatif) : ces deux personnes ne se tireront pas entre elles,
--    dans un sens comme dans l'autre. Écrivez les prénoms comme ils seront saisis
--    (majuscules et accents sont ignorés). Décommentez et adaptez :
-- insert into public.exclusions (name_a, name_b) values
--   ('Léa', 'Tom'),
--   ('Paul', 'Julie')
-- on conflict do nothing;

-- Pour retirer toutes les exclusions :
-- delete from public.exclusions where true;

-- 4) Vérification
select event_name,
       registration_deadline at time zone 'Europe/Paris' as fin_inscriptions_paris,
       draw_at at time zone 'Europe/Paris'               as tirage_paris,
       budget, exchange_date,
       group_code_hash is not null                       as code_groupe_defini
from public.settings;
