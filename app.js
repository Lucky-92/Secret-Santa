(() => {
  'use strict';

  const TZ = 'Europe/Paris';
  const cfg = window.SANTA_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  const ERRORS = {
    bad_group_code: "Code du groupe incorrect.",
    registration_closed: "Les inscriptions sont closes.",
    invalid_name: "Merci d'indiquer un prénom (40 caractères maximum).",
    name_taken: "Ce prénom est déjà inscrit. Si ce n'est pas toi, ajoute l'initiale de ton nom (ex. « Marie L. »).",
    wishlist_too_long: "La liste d'envies est trop longue (2000 caractères maximum).",
    bad_credentials: "Prénom ou code personnel incorrect.",
    locked: "Trop d'essais incorrects. Réessaie dans 15 minutes.",
    draw_not_done: "Le tirage n'a pas encore eu lieu.",
    no_match: "Aucune attribution trouvée pour toi. Contacte l'organisateur.",
    network: "Impossible de joindre le serveur. Vérifie ta connexion et réessaie.",
  };
  const DRAW_ERRORS = {
    not_enough_participants: "Le tirage n'a pas pu avoir lieu : il faut au moins 2 participants. Contacte l'organisateur.",
    impossible_constraints: "Le tirage n'a pas pu avoir lieu à cause des exclusions. Contacte l'organisateur.",
  };
  const errorText = (code) => ERRORS[code] || "Une erreur est survenue. Réessaie.";

  // ---------- Stockage local (confort uniquement, peut être indisponible) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const K_GROUP = 'santa.group';
  const K_NAME = 'santa.name';

  // ---------- Vérification de la configuration ----------
  function configProblem() {
    const url = cfg.SUPABASE_URL || '';
    const key = cfg.SUPABASE_ANON_KEY || '';
    if (!url || url.includes('COLLEZ') || !key || key.includes('COLLEZ')) {
      return "Renseignez SUPABASE_URL et SUPABASE_ANON_KEY dans config.js (voir le README).";
    }
    if (key.startsWith('sb_secret_')) return secretKeyMsg();
    const parts = key.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.role === 'service_role') return secretKeyMsg();
      } catch { /* clé non JWT : on laisse passer */ }
    }
    if (!window.supabase || !window.supabase.createClient) {
      return "La bibliothèque Supabase n'a pas pu être chargée. Vérifiez votre connexion.";
    }
    return null;
  }
  function secretKeyMsg() {
    return "⚠️ config.js contient une clé SECRÈTE (service_role / sb_secret). Retirez-la immédiatement, " +
      "régénérez-la dans Supabase, et utilisez la clé « anon » / « publishable ».";
  }

  const problem = configProblem();
  if (problem) {
    $('config-msg').textContent = problem;
    $('screen-config').hidden = false;
    return;
  }

  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function rpc(fn, args) {
    try {
      const { data, error } = await client.rpc(fn, args);
      if (error) {
        console.error(fn, error);
        return { ok: false, error: 'network' };
      }
      return data;
    } catch (e) {
      console.error(fn, e);
      return { ok: false, error: 'network' };
    }
  }

  // ---------- Formatage ----------
  const dateFmt = new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const fmtDate = (iso) => capitalize(dateFmt.format(new Date(iso)));
  const pad = (n) => String(n).padStart(2, '0');
  const normCode = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prettyCode = (c) => c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;

  // Texte avec liens cliquables, sans jamais injecter de HTML
  function renderRichText(el, text) {
    el.textContent = '';
    const re = /https?:\/\/[^\s<>"']+/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      let url = m[0];
      const trail = url.match(/[.,;:!?)\]]+$/);
      if (trail) url = url.slice(0, -trail[0].length);
      el.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
      el.append(a);
      last = m.index + url.length;
      re.lastIndex = last;
    }
    el.append(text.slice(last));
  }

  // ---------- État ----------
  let groupCode = null;
  let info = null;
  let clockOffset = 0;   // heure serveur - heure locale (ms)
  let lastPhase = null;
  let refreshing = false;
  let dueRetryAt = 0;

  const serverNow = () => Date.now() + clockOffset;

  function phase() {
    if (!info) return null;
    if (info.draw_done) return 'drawn';
    const now = serverNow();
    if (now >= new Date(info.draw_at).getTime()) return info.draw_error ? 'error' : 'due';
    if (now >= new Date(info.registration_deadline).getTime()) return 'closed';
    return 'open';
  }

  // ---------- Écrans ----------
  function showGate(message) {
    $('screen-event').hidden = true;
    $('screen-gate').hidden = false;
    $('gate-error').textContent = message || '';
    $('gate-code').focus();
  }

  async function loadInfo() {
    if (refreshing) return;
    refreshing = true;
    const t0 = Date.now();
    const res = await rpc('get_event_info', { p_group_code: groupCode });
    refreshing = false;
    if (!res || !res.ok) {
      if (res && res.error === 'bad_group_code') {
        store.del(K_GROUP);
        groupCode = null;
        info = null;
        showGate(errorText('bad_group_code'));
      } else if (!info) {
        showGate(errorText(res && res.error));
      }
      return;
    }
    const t1 = Date.now();
    clockOffset = new Date(res.server_now).getTime() - (t0 + t1) / 2;
    info = res;
    lastPhase = null;
    render();
  }

  function render() {
    if (!info) return;
    $('screen-gate').hidden = true;
    $('screen-event').hidden = false;

    const title = info.event_name || 'Secret Santa';
    $('event-name').textContent = title;
    document.title = title;

    $('fact-budget').textContent = info.budget || '–';
    $('fact-exchange').textContent = info.exchange_date || '–';
    $('fact-deadline').textContent = fmtDate(info.registration_deadline);
    $('fact-draw').textContent = fmtDate(info.draw_at);

    const names = info.participants || [];
    $('participants-count').textContent = names.length;
    const ul = $('participants-list');
    ul.textContent = '';
    if (names.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'Personne pour l’instant… lance-toi !';
      li.className = 'muted';
      ul.append(li);
    }
    for (const n of names) {
      const li = document.createElement('li');
      li.textContent = n;
      ul.append(li);
    }

    const p = phase();
    lastPhase = p;

    $('countdown-card').hidden = !(p === 'open' || p === 'closed' || p === 'due');
    $('register-card').hidden = p !== 'open';
    $('reveal-card').hidden = p !== 'drawn';
    $('wish-card').hidden = !(p === 'open' || p === 'closed' || p === 'drawn');
    $('register-hint').textContent = p === 'open'
      ? `Inscriptions ouvertes jusqu'au ${fmtDate(info.registration_deadline).toLowerCase()}.`
      : '';

    const status = $('status-msg');
    status.classList.remove('notice-error');
    let msg = '';
    if (p === 'closed') msg = "Les inscriptions sont closes. Rendez-vous au tirage !";
    if (p === 'due') msg = "Le tirage est en cours… ⏳";
    if (p === 'drawn') msg = "🎉 Le tirage a eu lieu ! Entre ton prénom et ton code personnel pour découvrir à qui tu offres un cadeau.";
    if (p === 'error') {
      msg = DRAW_ERRORS[info.draw_error] || "Le tirage n'a pas pu avoir lieu. Contacte l'organisateur.";
      status.classList.add('notice-error');
    }
    status.textContent = msg;
    status.hidden = !msg;

    const savedName = store.get(K_NAME);
    if (savedName) {
      for (const id of ['rev-name', 'wish-name']) if (!$(id).value) $(id).value = savedName;
    }
    tick();
  }

  // ---------- Compte à rebours ----------
  function tick() {
    if (!info) return;
    const p = phase();
    if (p !== lastPhase) { render(); return; }

    const remaining = Math.max(0, new Date(info.draw_at).getTime() - serverNow());
    const s = Math.floor(remaining / 1000);
    $('cd-days').textContent = Math.floor(s / 86400);
    $('cd-hours').textContent = pad(Math.floor((s % 86400) / 3600));
    $('cd-mins').textContent = pad(Math.floor((s % 3600) / 60));
    $('cd-secs').textContent = pad(s % 60);

    // L'heure du tirage est passée : le premier visiteur le déclenche côté serveur
    if (p === 'due' && !refreshing && Date.now() >= dueRetryAt) {
      dueRetryAt = Date.now() + 4000;
      loadInfo();
    }
  }
  setInterval(tick, 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && groupCode) loadInfo();
  });

  // ---------- Formulaires ----------
  async function withBusy(form, fn) {
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  }

  $('gate-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('gate-code').value.trim();
    if (!code) { $('gate-error').textContent = 'Entre le code du groupe.'; return; }
    withBusy(e.target, async () => {
      $('gate-error').textContent = '';
      const ok = await rpc('check_group_code', { p_group_code: code });
      if (ok === true) {
        groupCode = code;
        store.set(K_GROUP, code);
        await loadInfo();
      } else {
        $('gate-error').textContent = ok && ok.error === 'network' ? errorText('network') : errorText('bad_group_code');
      }
    });
  });

  $('register-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('reg-name').value.trim();
    const wish = $('reg-wish').value;
    if (!name) { $('register-error').textContent = errorText('invalid_name'); return; }
    withBusy(e.target, async () => {
      $('register-error').textContent = '';
      const res = await rpc('register_participant', {
        p_group_code: groupCode, p_first_name: name, p_wishlist: wish,
      });
      if (!res || !res.ok) {
        $('register-error').textContent = errorText(res && res.error);
        if (res && res.error === 'registration_closed') loadInfo();
        return;
      }
      store.set(K_NAME, res.first_name);
      $('reg-name').value = '';
      $('reg-wish').value = '';
      $('code-name').textContent = res.first_name;
      $('code-value').textContent = prettyCode(res.personal_code);
      $('code-card').hidden = false;
      $('code-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
      loadInfo();
    });
  });

  $('code-copy').addEventListener('click', async () => {
    const code = normCode($('code-value').textContent);
    try {
      await navigator.clipboard.writeText(code);
      $('code-copy').textContent = 'Copié ✓';
    } catch {
      $('code-copy').textContent = 'Copie impossible : note-le';
    }
    setTimeout(() => { $('code-copy').textContent = 'Copier le code'; }, 2500);
  });

  $('code-done').addEventListener('click', () => {
    if (!confirm("Tu as bien noté ton code ? Il ne sera plus affiché.")) return;
    $('code-card').hidden = true;
    $('code-value').textContent = '';
  });

  $('reveal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('rev-name').value.trim();
    const code = normCode($('rev-code').value);
    if (!name || !code) { $('reveal-error').textContent = 'Entre ton prénom et ton code personnel.'; return; }
    withBusy(e.target, async () => {
      $('reveal-error').textContent = '';
      $('reveal-result').hidden = true;
      const res = await rpc('get_my_match', { p_group_code: groupCode, p_first_name: name, p_code: code });
      if (!res || !res.ok) {
        $('reveal-error').textContent = errorText(res && res.error);
        return;
      }
      store.set(K_NAME, res.giver_name);
      $('rev-code').value = '';
      $('res-giver').textContent = res.giver_name;
      $('res-name').textContent = res.receiver_name;
      const wish = $('res-wish');
      if (res.receiver_wishlist) {
        renderRichText(wish, res.receiver_wishlist);
        wish.classList.remove('muted');
      } else {
        wish.textContent = "Pas encore de liste d'envies… à toi de jouer les détectives !";
        wish.classList.add('muted');
      }
      $('res-budget').textContent = [
        info && info.budget ? `Budget : ${info.budget}` : '',
        info && info.exchange_date ? `Échange : ${info.exchange_date}` : '',
      ].filter(Boolean).join(' · ');
      $('reveal-form').hidden = true;
      $('reveal-result').hidden = false;
    });
  });

  $('res-hide').addEventListener('click', () => {
    $('reveal-result').hidden = true;
    $('res-name').textContent = '';
    $('res-wish').textContent = '';
    $('reveal-form').hidden = false;
  });

  $('wish-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('wish-name').value.trim();
    const code = normCode($('wish-code').value);
    $('wish-ok').textContent = '';
    if (!name || !code) { $('wish-error').textContent = 'Entre ton prénom et ton code personnel.'; return; }
    withBusy(e.target, async () => {
      $('wish-error').textContent = '';
      const res = await rpc('update_wishlist', {
        p_group_code: groupCode, p_first_name: name, p_code: code, p_wishlist: $('wish-text').value,
      });
      if (!res || !res.ok) {
        $('wish-error').textContent = errorText(res && res.error);
        return;
      }
      $('wish-code').value = '';
      $('wish-ok').textContent = "Liste d'envies enregistrée ✓";
    });
  });

  $('logout').addEventListener('click', () => {
    store.del(K_GROUP);
    groupCode = null;
    info = null;
    $('gate-code').value = '';
    showGate('');
  });

  // ---------- Démarrage ----------
  const saved = store.get(K_GROUP);
  if (saved) {
    groupCode = saved;
    loadInfo();
  } else {
    showGate('');
  }
})();
