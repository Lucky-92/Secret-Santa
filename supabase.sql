-- =====================================================================
--  Secret Santa : schéma Supabase
-- ---------------------------------------------------------------------
--  À coller tel quel dans Supabase > SQL Editor > New query > Run.
--  Ce fichier ne contient AUCUNE donnée personnelle ni code secret :
--  la configuration (code du groupe, dates, budget, exclusions) se fait
--  ensuite avec config.example.sql, directement dans le SQL Editor.
--  Vous pouvez relancer ce fichier sans perdre de données.
--
--  Principes de sécurité :
--   * RLS activée sur toutes les tables, sans aucune policy : la clé
--     anon ne peut ni lire ni écrire les tables directement.
--   * Les privilèges sur les tables sont aussi retirés à anon/authenticated.
--   * Le site ne passe que par 5 fonctions RPC (security definer).
--   * Aucune fonction ne renvoie la liste des paires.
--   * Les codes (groupe + personnels) sont stockés hachés (bcrypt).
--   * Les fonctions internes et d'administration vivent dans le schéma
--     "private", qui n'est pas exposé par l'API.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists unaccent with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;


-- ---------------------------------------------------------------------
--  Tables
-- ---------------------------------------------------------------------

-- Paramètres de l'événement (une seule ligne, id = 1)
create table if not exists public.settings (
  id                    int primary key default 1 check (id = 1),
  event_name            text not null default 'Secret Santa',
  group_code_hash       text,
  registration_deadline timestamptz not null default (now() + interval '7 days'),
  draw_at               timestamptz not null default (now() + interval '8 days'),
  budget                text,
  exchange_date         text,
  draw_done_at          timestamptz,
  draw_error            text,
  constraint deadline_before_draw check (registration_deadline <= draw_at)
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- Compte organisateur du site (identifiant + hash bcrypt du mot de passe)
alter table public.settings add column if not exists admin_login         text;
alter table public.settings add column if not exists admin_password_hash text;
alter table public.settings add column if not exists admin_failed        int not null default 0;
alter table public.settings add column if not exists admin_locked_until  timestamptz;

create table if not exists public.participants (
  id              bigint generated always as identity primary key,
  first_name      text not null check (char_length(first_name) between 1 and 40),
  name_key        text not null unique,          -- prénom normalisé (minuscules, sans accents) : empêche les doublons
  wishlist        text check (wishlist is null or char_length(wishlist) <= 2000),
  code_hash       text not null,                 -- hash bcrypt du code personnel, jamais le code en clair
  failed_attempts int not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists public.assignments (
  giver_id    bigint primary key references public.participants(id) on delete cascade,
  receiver_id bigint not null unique references public.participants(id) on delete cascade,
  check (giver_id <> receiver_id)
);

-- Paires qui ne doivent pas se tirer entre elles (dans un sens comme dans l'autre)
create table if not exists public.exclusions (
  name_a text not null,
  name_b text not null,
  primary key (name_a, name_b)
);

alter table public.settings     enable row level security;
alter table public.participants enable row level security;
alter table public.assignments  enable row level security;
alter table public.exclusions   enable row level security;

revoke all on table public.settings, public.participants, public.assignments, public.exclusions
  from anon, authenticated;
revoke all on sequence public.participants_id_seq from anon, authenticated;


-- ---------------------------------------------------------------------
--  Fonctions internes (schéma private, non exposé)
-- ---------------------------------------------------------------------

create or replace function private.clean_name(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')
$$;

create or replace function private.name_key(p text) returns text
language sql stable set search_path = '' as $$
  select lower(extensions.unaccent(private.clean_name(p)))
$$;

create or replace function private.normalize_code(p text) returns text
language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Code personnel : 6 caractères parmi 32 (sans 0/O/1/I), aléatoire cryptographique.
-- 256 est un multiple de 32 : pas de biais de modulo.
create or replace function private.gen_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  b   bytea := extensions.gen_random_bytes(6);
  res text  := '';
begin
  for i in 0..5 loop
    res := res || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return res;
end $$;

create or replace function private.group_ok(p_code text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((
    select s.group_code_hash is not null
       and s.group_code_hash = extensions.crypt(upper(btrim(coalesce(p_code, ''))), s.group_code_hash)
    from public.settings s where s.id = 1
  ), false)
$$;

-- Vérifie prénom + code personnel. 10 échecs => blocage 15 minutes.
-- Ne lève pas d'exception pour que le compteur d'échecs soit bien enregistré.
create or replace function private.auth_participant(p_first_name text, p_code text,
                                                    out pid bigint, out err text)
language plpgsql volatile set search_path = '' as $$
declare
  r public.participants;
begin
  select * into r from public.participants
   where name_key = private.name_key(p_first_name)
   for update;
  if not found then
    err := 'bad_credentials';
    return;
  end if;
  if r.locked_until is not null and r.locked_until > now() then
    err := 'locked';
    return;
  end if;
  if r.code_hash = extensions.crypt(private.normalize_code(p_code), r.code_hash) then
    update public.participants set failed_attempts = 0, locked_until = null where id = r.id;
    pid := r.id;
  else
    update public.participants
       set failed_attempts = case when r.failed_attempts + 1 >= 10 then 0 else r.failed_attempts + 1 end,
           locked_until    = case when r.failed_attempts + 1 >= 10 then now() + interval '15 minutes' else null end
     where id = r.id;
    err := 'bad_credentials';
  end if;
end $$;

-- Tirage idempotent : ne fait rien si la date n'est pas passée ou si le tirage
-- a déjà eu lieu. Le verrou FOR UPDATE garantit un seul tirage même si
-- plusieurs visiteurs arrivent à la même seconde.
create or replace function private.run_draw_if_due() returns text
language plpgsql volatile set search_path = '' as $$
declare
  s         public.settings;
  givers    bigint[];
  ring      bigint[];
  excl      text[];
  n         int;
  ok        boolean;
begin
  -- chemin rapide, sans verrou
  select * into s from public.settings where id = 1;
  if s.draw_done_at is not null then return 'done'; end if;
  if now() < s.draw_at then return 'not_yet'; end if;

  -- verrou puis re-vérification
  select * into s from public.settings where id = 1 for update;
  if s.draw_done_at is not null then return 'done'; end if;

  select array_agg(id order by id) into givers from public.participants;
  n := coalesce(array_length(givers, 1), 0);
  if n < 2 then
    update public.settings set draw_error = 'not_enough_participants' where id = 1;
    return 'error';
  end if;

  -- exclusions converties en paires d'id "petit:grand"
  select coalesce(array_agg(least(pa.id, pb.id) || ':' || greatest(pa.id, pb.id)), '{}')
    into excl
    from public.exclusions e
    join public.participants pa on pa.name_key = private.name_key(e.name_a)
    join public.participants pb on pb.name_key = private.name_key(e.name_b);

  -- Cycle unique : on mélange les participants, chacun offre au suivant et le
  -- dernier au premier (A -> B -> C -> ... -> A). Personne ne se tire lui-même,
  -- pas de paire réciproque A <-> B (sauf s'il n'y a que 2 inscrits), et tout le
  -- monde est dans la même boucle. Mélange rejeté si une exclusion est violée.
  for attempt in 1..5000 loop
    select array_agg(x order by random()) into ring from unnest(givers) as x;
    ok := true;
    for i in 1..n loop
      if (least(ring[i], ring[(i % n) + 1]) || ':' || greatest(ring[i], ring[(i % n) + 1])) = any(excl) then
        ok := false;
        exit;
      end if;
    end loop;

    if ok then
      delete from public.assignments where true;
      insert into public.assignments (giver_id, receiver_id)
        select ring[k], ring[(k % n) + 1] from generate_subscripts(ring, 1) as k;
      update public.settings set draw_done_at = now(), draw_error = null where id = 1;
      return 'done';
    end if;
  end loop;

  update public.settings set draw_error = 'impossible_constraints' where id = 1;
  return 'error';
end $$;


-- ---------------------------------------------------------------------
--  Fonctions RPC publiques (seules fonctions appelables par le site)
-- ---------------------------------------------------------------------

-- 1. Vérifie le code d'accès du groupe
create or replace function public.check_group_code(p_group_code text) returns boolean
language sql volatile security definer set search_path = '' as $$
  select private.group_ok(p_group_code)
$$;

-- 2. Infos publiques de l'événement (et déclenche le tirage si l'heure est passée)
create or replace function public.get_event_info(p_group_code text) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  s     public.settings;
  names json;
begin
  if not private.group_ok(p_group_code) then
    return json_build_object('ok', false, 'error', 'bad_group_code');
  end if;

  perform private.run_draw_if_due();

  select * into s from public.settings where id = 1;
  select coalesce(json_agg(first_name order by name_key), '[]'::json) into names
    from public.participants;

  return json_build_object(
    'ok', true,
    'event_name', s.event_name,
    -- dates en millisecondes depuis 1970 (lisibles par tous les navigateurs)
    'registration_deadline', floor(extract(epoch from s.registration_deadline) * 1000),
    'draw_at', floor(extract(epoch from s.draw_at) * 1000),
    'budget', s.budget,
    'exchange_date', s.exchange_date,
    'draw_done', s.draw_done_at is not null,
    'draw_error', s.draw_error,
    'server_now', floor(extract(epoch from clock_timestamp()) * 1000),
    'participants', names
  );
end $$;

-- 3. Inscription : renvoie le code personnel en clair UNE SEULE FOIS
create or replace function public.register_participant(p_group_code text, p_first_name text, p_wishlist text)
returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  s      public.settings;
  v_name text := private.clean_name(p_first_name);
  v_wish text := nullif(btrim(coalesce(p_wishlist, '')), '');
  v_code text;
begin
  if not private.group_ok(p_group_code) then
    return json_build_object('ok', false, 'error', 'bad_group_code');
  end if;

  select * into s from public.settings where id = 1;
  if s.draw_done_at is not null or now() > s.registration_deadline then
    return json_build_object('ok', false, 'error', 'registration_closed');
  end if;

  if v_name = '' or char_length(v_name) > 40 or v_name !~ '[[:alpha:]]' then
    return json_build_object('ok', false, 'error', 'invalid_name');
  end if;
  if v_wish is not null and char_length(v_wish) > 2000 then
    return json_build_object('ok', false, 'error', 'wishlist_too_long');
  end if;

  v_code := private.gen_code();
  begin
    insert into public.participants (first_name, name_key, wishlist, code_hash)
    values (v_name, private.name_key(v_name), v_wish,
            extensions.crypt(v_code, extensions.gen_salt('bf', 8)));
  exception when unique_violation then
    return json_build_object('ok', false, 'error', 'name_taken');
  end;

  return json_build_object('ok', true, 'first_name', v_name, 'personal_code', v_code);
end $$;

-- 4. Modifier sa liste d'envies (avant ou après le tirage)
create or replace function public.update_wishlist(p_group_code text, p_first_name text, p_code text, p_wishlist text)
returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_pid  bigint;
  v_err  text;
  v_wish text := nullif(btrim(coalesce(p_wishlist, '')), '');
begin
  if not private.group_ok(p_group_code) then
    return json_build_object('ok', false, 'error', 'bad_group_code');
  end if;
  if v_wish is not null and char_length(v_wish) > 2000 then
    return json_build_object('ok', false, 'error', 'wishlist_too_long');
  end if;

  select a.pid, a.err into v_pid, v_err from private.auth_participant(p_first_name, p_code) a;
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;

  update public.participants set wishlist = v_wish where id = v_pid;
  return json_build_object('ok', true);
end $$;

-- 5. Après le tirage : la personne à qui j'offre (et rien d'autre)
create or replace function public.get_my_match(p_group_code text, p_first_name text, p_code text)
returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  s       public.settings;
  v_pid   bigint;
  v_err   text;
  v_giver text;
  v_name  text;
  v_wish  text;
begin
  if not private.group_ok(p_group_code) then
    return json_build_object('ok', false, 'error', 'bad_group_code');
  end if;

  perform private.run_draw_if_due();
  select * into s from public.settings where id = 1;
  if s.draw_done_at is null then
    return json_build_object('ok', false, 'error', 'draw_not_done');
  end if;

  select a.pid, a.err into v_pid, v_err from private.auth_participant(p_first_name, p_code) a;
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;

  select g.first_name, r.first_name, r.wishlist
    into v_giver, v_name, v_wish
    from public.assignments a
    join public.participants g on g.id = a.giver_id
    join public.participants r on r.id = a.receiver_id
   where a.giver_id = v_pid;

  if v_name is null then
    -- inscrit après le tirage (ne devrait pas arriver)
    return json_build_object('ok', false, 'error', 'no_match');
  end if;

  return json_build_object('ok', true, 'giver_name', v_giver,
                           'receiver_name', v_name, 'receiver_wishlist', v_wish);
end $$;


-- ---------------------------------------------------------------------
--  Espace organisateur du site
--  Identifiant + mot de passe vérifiés côté serveur (bcrypt).
--  5 échecs => espace bloqué 15 minutes. Aucune fonction ne renvoie les paires.
-- ---------------------------------------------------------------------

create or replace function private.admin_auth(p_login text, p_password text) returns text
language plpgsql volatile set search_path = '' as $$
declare
  s        public.settings;
  v_pwd_ok boolean;
begin
  select * into s from public.settings where id = 1 for update;
  if s.admin_login is null or s.admin_password_hash is null then
    return 'admin_disabled';
  end if;
  if s.admin_locked_until is not null and s.admin_locked_until > now() then
    return 'admin_locked';
  end if;

  v_pwd_ok := s.admin_password_hash = extensions.crypt(coalesce(p_password, ''), s.admin_password_hash);
  if v_pwd_ok and lower(btrim(coalesce(p_login, ''))) = s.admin_login then
    update public.settings set admin_failed = 0, admin_locked_until = null where id = 1;
    return null;
  end if;

  update public.settings
     set admin_failed       = case when s.admin_failed + 1 >= 5 then 0 else s.admin_failed + 1 end,
         admin_locked_until = case when s.admin_failed + 1 >= 5 then now() + interval '15 minutes' else null end
   where id = 1;
  return 'bad_admin_credentials';
end $$;

create or replace function private.admin_status() returns json
language sql stable set search_path = '' as $$
  select json_build_object(
    'ok', true,
    'participants', coalesce((select json_agg(p.first_name order by p.name_key) from public.participants p), '[]'::json),
    'registration_deadline', floor(extract(epoch from s.registration_deadline) * 1000),
    'draw_at', floor(extract(epoch from s.draw_at) * 1000),
    'draw_done', s.draw_done_at is not null,
    'draw_error', s.draw_error,
    'assignments', (select count(*) from public.assignments),
    'server_now', floor(extract(epoch from clock_timestamp()) * 1000)
  )
  from public.settings s where s.id = 1
$$;

-- Connexion : renvoie l'état (inscrits, dates, statut du tirage), jamais les paires
create or replace function public.admin_login(p_login text, p_password text) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_err text := private.admin_auth(p_login, p_password);
begin
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;
  perform private.run_draw_if_due();
  return private.admin_status();
end $$;

-- Rincer : supprime tous les inscrits et le tirage
create or replace function public.admin_reset_participants(p_login text, p_password text) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_err text := private.admin_auth(p_login, p_password);
begin
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;
  delete from public.assignments where true;
  delete from public.participants where true;
  update public.settings set draw_done_at = null, draw_error = null where id = 1;
  return private.admin_status();
end $$;

-- Fixe le tirage dans N minutes (0 ou moins => 1 minute). Annule un tirage déjà fait.
-- Fin des inscriptions : conservée si elle est encore à venir et avant le tirage,
-- sinon alignée sur l'heure du tirage (les inscriptions rouvrent jusqu'au tirage).
create or replace function public.admin_set_draw_in(p_login text, p_password text, p_minutes int) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_err  text := private.admin_auth(p_login, p_password);
  v_draw timestamptz;
begin
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;
  if p_minutes is not null and p_minutes > 525600 then
    return json_build_object('ok', false, 'error', 'invalid_duration');
  end if;

  v_draw := now() + make_interval(mins => greatest(coalesce(p_minutes, 0), 1));
  delete from public.assignments where true;
  update public.settings
     set draw_at = v_draw,
         draw_done_at = null,
         draw_error = null,
         registration_deadline = case
           when registration_deadline > v_draw or registration_deadline <= now() then v_draw
           else registration_deadline end
   where id = 1;
  return private.admin_status();
end $$;

create or replace function public.admin_change_password(p_login text, p_password text, p_new_password text) returns json
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_err text := private.admin_auth(p_login, p_password);
begin
  if v_err is not null then
    return json_build_object('ok', false, 'error', v_err);
  end if;
  if char_length(coalesce(p_new_password, '')) < 8 then
    return json_build_object('ok', false, 'error', 'weak_password');
  end if;
  update public.settings
     set admin_password_hash = extensions.crypt(p_new_password, extensions.gen_salt('bf', 10))
   where id = 1;
  return json_build_object('ok', true);
end $$;


-- ---------------------------------------------------------------------
--  Fonctions d'administration (SQL Editor uniquement, jamais via le site)
-- ---------------------------------------------------------------------

-- Crée ou remplace le compte organisateur du site.
create or replace function private.set_admin(p_login text, p_password text) returns text
language plpgsql volatile set search_path = '' as $$
begin
  if char_length(btrim(coalesce(p_login, ''))) < 3 or char_length(coalesce(p_password, '')) < 6 then
    raise exception 'Identifiant : 3 caractères minimum. Mot de passe : 6 caractères minimum.';
  end if;
  update public.settings
     set admin_login = lower(btrim(p_login)),
         admin_password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
         admin_failed = 0,
         admin_locked_until = null
   where id = 1;
  return 'Compte organisateur enregistré (mot de passe haché).';
end $$;

-- Débloque l'espace organisateur après trop d'essais.
create or replace function private.admin_unlock() returns text
language plpgsql volatile set search_path = '' as $$
begin
  update public.settings set admin_failed = 0, admin_locked_until = null where id = 1;
  return 'Espace organisateur débloqué.';
end $$;

-- Définit (ou change) le code d'accès du groupe. Stocké haché.
create or replace function private.set_group_code(p_code text) returns text
language plpgsql volatile set search_path = '' as $$
begin
  if char_length(btrim(coalesce(p_code, ''))) < 6 then
    raise exception 'Le code du groupe doit faire au moins 6 caractères.';
  end if;
  update public.settings
     set group_code_hash = extensions.crypt(upper(btrim(p_code)), extensions.gen_salt('bf', 10))
   where id = 1;
  return 'Code du groupe enregistré (haché).';
end $$;

-- Contrôle du tirage SANS afficher les paires.
create or replace function private.check_draw()
returns table (verification text, resultat text)
language sql stable set search_path = '' as $$
  select 'Participants', count(*)::text from public.participants
  union all
  select 'Tirage effectué le',
         coalesce(to_char(draw_done_at at time zone 'Europe/Paris', 'DD/MM/YYYY HH24:MI:SS'), 'pas encore')
    from public.settings where id = 1
  union all
  select 'Erreur de tirage', coalesce(draw_error, 'aucune') from public.settings where id = 1
  union all
  select 'Attributions', count(*)::text from public.assignments
  union all
  select 'Participants sans personne à qui offrir',
         count(*)::text from public.participants p
          where not exists (select 1 from public.assignments a where a.giver_id = p.id)
  union all
  select 'Participants qui ne reçoivent rien',
         count(*)::text from public.participants p
          where not exists (select 1 from public.assignments a where a.receiver_id = p.id)
  union all
  select 'Personnes tombées sur elles-mêmes',
         count(*)::text from public.assignments where giver_id = receiver_id
  union all
  select 'Paires réciproques (A <-> B)',
         count(*)::text from public.assignments a
          join public.assignments b on b.giver_id = a.receiver_id and b.receiver_id = a.giver_id
         where a.giver_id < a.receiver_id
  union all
  -- longueur de la boucle qui part du premier inscrit : doit être égale au nombre d'attributions
  select 'Longueur du cycle', coalesce((
    with recursive c(id, len) as (
      select a.receiver_id, 1 from public.assignments a
       where a.giver_id = (select min(giver_id) from public.assignments)
      union all
      select a.receiver_id, c.len + 1 from c
        join public.assignments a on a.giver_id = c.id
       where c.id <> (select min(giver_id) from public.assignments) and c.len < 10000
    )
    select max(len)::text from c), '–')
  union all
  select 'Exclusions non respectées', count(*)::text
    from public.assignments a
    join public.participants g on g.id = a.giver_id
    join public.participants r on r.id = a.receiver_id
    join public.exclusions e
      on (private.name_key(e.name_a) = g.name_key and private.name_key(e.name_b) = r.name_key)
      or (private.name_key(e.name_b) = g.name_key and private.name_key(e.name_a) = r.name_key)
  union all
  select 'Exclusions avec un prénom non inscrit',
         coalesce(string_agg(e.name_a || ' / ' || e.name_b, ', '), 'aucune')
    from public.exclusions e
   where not exists (select 1 from public.participants p where p.name_key = private.name_key(e.name_a))
      or not exists (select 1 from public.participants p where p.name_key = private.name_key(e.name_b))
$$;

-- Annule le tirage (garde les inscrits).
create or replace function private.reset_draw() returns text
language plpgsql volatile set search_path = '' as $$
begin
  delete from public.assignments where true;
  update public.settings set draw_done_at = null, draw_error = null where id = 1;
  return 'Tirage annulé, inscriptions conservées.';
end $$;

-- Remet tout à zéro : supprime inscrits et tirage (garde code du groupe, dates, exclusions).
create or replace function private.reset_all() returns text
language plpgsql volatile set search_path = '' as $$
begin
  delete from public.assignments where true;
  delete from public.participants where true;
  update public.settings set draw_done_at = null, draw_error = null where id = 1;
  return 'Tout est remis à zéro (inscrits et tirage supprimés).';
end $$;

-- Mode test : fin des inscriptions et tirage dans N minutes (annule le tirage existant).
create or replace function private.test_mode(p_minutes_deadline int default 3, p_minutes_draw int default 5)
returns text
language plpgsql volatile set search_path = '' as $$
begin
  if p_minutes_draw < p_minutes_deadline then
    raise exception 'Le tirage doit avoir lieu après la fin des inscriptions.';
  end if;
  perform private.reset_draw();
  update public.settings
     set registration_deadline = now() + make_interval(mins => p_minutes_deadline),
         draw_at               = now() + make_interval(mins => p_minutes_draw)
   where id = 1;
  return format('Mode test : inscriptions jusqu''à %s, tirage à %s (heure de Paris).',
                to_char((now() + make_interval(mins => p_minutes_deadline)) at time zone 'Europe/Paris', 'HH24:MI'),
                to_char((now() + make_interval(mins => p_minutes_draw)) at time zone 'Europe/Paris', 'HH24:MI'));
end $$;

-- Code perdu : génère un nouveau code personnel pour un participant.
create or replace function private.new_personal_code(p_first_name text) returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_code text := private.gen_code();
begin
  update public.participants
     set code_hash = extensions.crypt(v_code, extensions.gen_salt('bf', 8)),
         failed_attempts = 0, locked_until = null
   where name_key = private.name_key(p_first_name);
  if not found then
    raise exception 'Aucun participant nommé %', p_first_name;
  end if;
  return v_code;
end $$;

-- Supprimer une inscription (à faire AVANT le tirage).
create or replace function private.delete_participant(p_first_name text) returns text
language plpgsql volatile set search_path = '' as $$
begin
  if exists (select 1 from public.settings where id = 1 and draw_done_at is not null) then
    raise exception 'Le tirage a déjà eu lieu : lancez d''abord select private.reset_draw();';
  end if;
  delete from public.participants where name_key = private.name_key(p_first_name);
  if not found then
    raise exception 'Aucun participant nommé %', p_first_name;
  end if;
  return 'Participant supprimé.';
end $$;


-- ---------------------------------------------------------------------
--  Droits d'exécution
-- ---------------------------------------------------------------------

-- Rien dans "private" n'est accessible depuis l'API
revoke all on all functions in schema private from public, anon, authenticated;

-- Les 5 RPC publiques : retirer le droit par défaut (PUBLIC) puis l'accorder à anon
revoke all on function public.check_group_code(text)                         from public, anon, authenticated;
revoke all on function public.get_event_info(text)                           from public, anon, authenticated;
revoke all on function public.register_participant(text, text, text)         from public, anon, authenticated;
revoke all on function public.update_wishlist(text, text, text, text)        from public, anon, authenticated;
revoke all on function public.get_my_match(text, text, text)                 from public, anon, authenticated;

grant execute on function public.check_group_code(text)                      to anon, authenticated;
grant execute on function public.get_event_info(text)                        to anon, authenticated;
grant execute on function public.register_participant(text, text, text)      to anon, authenticated;
grant execute on function public.update_wishlist(text, text, text, text)     to anon, authenticated;
grant execute on function public.get_my_match(text, text, text)              to anon, authenticated;

-- Espace organisateur (protégé par identifiant + mot de passe)
revoke all on function public.admin_login(text, text)                        from public, anon, authenticated;
revoke all on function public.admin_reset_participants(text, text)           from public, anon, authenticated;
revoke all on function public.admin_set_draw_in(text, text, int)             from public, anon, authenticated;
revoke all on function public.admin_change_password(text, text, text)        from public, anon, authenticated;

grant execute on function public.admin_login(text, text)                     to anon, authenticated;
grant execute on function public.admin_reset_participants(text, text)        to anon, authenticated;
grant execute on function public.admin_set_draw_in(text, text, int)          to anon, authenticated;
grant execute on function public.admin_change_password(text, text, text)     to anon, authenticated;

-- Fin. Étape suivante : config.example.sql (à exécuter dans le SQL Editor, sans le committer rempli).
