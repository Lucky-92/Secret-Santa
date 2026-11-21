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
    bad_admin_credentials: "Identifiant ou mot de passe incorrect.",
    admin_locked: "Trop d'essais incorrects : l'espace organisateur est bloqué 15 minutes.",
    admin_disabled: "Le compte organisateur n'est pas encore activé (voir le README).",
    weak_password: "Le nouveau mot de passe doit faire au moins 8 caractères.",
    invalid_duration: "Durée trop longue (365 jours maximum).",
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
  let adminOpen = false;

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
    if (adminOpen) return;
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
    if (!info || adminOpen) return;
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
    if (adminOpen) { adminTick(); return; }
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

  // ---------- Espace organisateur ----------
  // Identifiants gardés en mémoire seulement le temps de la session (jamais stockés).
  let admin = null;          // { login, password }
  let adminStatus = null;
  let adminRefreshAt = 0;

  function humanDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d) return `${d} j ${h} h ${pad(m)} min`;
    if (h) return `${h} h ${pad(m)} min`;
    if (m) return `${m} min ${pad(s % 60)} s`;
    return `${s % 60} s`;
  }

  function openAdmin() {
    adminOpen = true;
    for (const id of ['screen-gate', 'screen-event', 'screen-config']) $(id).hidden = true;
    $('screen-admin').hidden = false;
    $('admin-link').hidden = true;
    $('admin-login-card').hidden = !!admin;
    $('admin-panel').hidden = !admin;
    if (!admin) $('adm-login').focus();
    window.scrollTo(0, 0);
  }

  function closeAdmin() {
    admin = null;
    adminStatus = null;
    adminOpen = false;
    $('adm-pass').value = '';
    $('screen-admin').hidden = true;
    $('admin-link').hidden = false;
    if (location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search);
    if (groupCode) { lastPhase = null; info ? render() : showGate(''); loadInfo(); }
    else showGate('');
  }

  function adminLoggedOut(message) {
    admin = null;
    adminStatus = null;
    $('admin-panel').hidden = true;
    $('admin-login-card').hidden = false;
    $('adm-login-error').textContent = message || '';
  }

  async function adminCall(fn, extra) {
    const res = await rpc(fn, { p_login: admin.login, p_password: admin.password, ...extra });
    if (res && !res.ok && ['bad_admin_credentials', 'admin_locked', 'admin_disabled'].includes(res.error)) {
      adminLoggedOut(errorText(res.error));
      return null;
    }
    return res;
  }

  function setAdminStatus(st) {
    adminStatus = st;
    clockOffset = st.server_now - Date.now();
    renderAdmin();
  }

  function renderAdmin() {
    const st = adminStatus;
    if (!st) return;
    const names = st.participants || [];
    $('adm-count').textContent = names.length;
    $('adm-deadline').textContent = fmtDate(st.registration_deadline);
    $('adm-draw').textContent = fmtDate(st.draw_at);
    const ul = $('adm-names');
    ul.textContent = '';
    for (const n of names) {
      const li = document.createElement('li');
      li.textContent = n;
      ul.append(li);
    }
    adminTick();
    updateTimePreview();
  }

  function adminTick() {
    const st = adminStatus;
    if (!st || !admin) return;
    let state;
    if (st.draw_done) state = `Effectué ✓ (${st.assignments} attributions)`;
    else if (st.draw_error) state = DRAW_ERRORS[st.draw_error] || 'Erreur';
    else {
      const left = st.draw_at - serverNow();
      state = left > 0 ? `Dans ${humanDuration(left)}` : 'En cours…';
      // heure passée : on rafraîchit, ce qui déclenche le tirage côté serveur
      if (left <= 0 && Date.now() >= adminRefreshAt) {
        adminRefreshAt = Date.now() + 4000;
        adminCall('admin_login', {}).then((res) => { if (res && res.ok) setAdminStatus(res); });
      }
    }
    $('adm-state').textContent = state;
  }

  function durationMinutes() {
    const val = (id) => Math.max(0, parseInt($(id).value, 10) || 0);
    return val('adm-days') * 1440 + val('adm-hours') * 60 + val('adm-mins');
  }

  function updateTimePreview() {
    const mins = Math.max(1, durationMinutes());
    $('adm-time-preview').textContent = `→ Tirage le ${fmtDate(serverNow() + mins * 60000).toLowerCase()}` +
      (durationMinutes() === 0 ? ' (dans 1 minute)' : '');
  }
  for (const id of ['adm-days', 'adm-hours', 'adm-mins']) $(id).addEventListener('input', updateTimePreview);

  $('admin-link').addEventListener('click', openAdmin);
  $('adm-exit').addEventListener('click', closeAdmin);

  $('admin-login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const login = $('adm-login').value.trim();
    const password = $('adm-pass').value;
    if (!login || !password) { $('adm-login-error').textContent = 'Entre l’identifiant et le mot de passe.'; return; }
    withBusy(e.target, async () => {
      $('adm-login-error').textContent = '';
      const res = await rpc('admin_login', { p_login: login, p_password: password });
      if (!res || !res.ok) {
        $('adm-login-error').textContent = errorText(res && res.error);
        return;
      }
      admin = { login, password };
      $('adm-pass').value = '';
      $('admin-login-card').hidden = true;
      $('admin-panel').hidden = false;
      setAdminStatus(res);
    });
  });

  $('adm-time-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const mins = durationMinutes();
    $('adm-time-error').textContent = '';
    $('adm-time-ok').textContent = '';
    if (mins > 525600) { $('adm-time-error').textContent = errorText('invalid_duration'); return; }
    if (adminStatus && adminStatus.draw_done &&
        !confirm('Le tirage a déjà eu lieu. Le refaire à la nouvelle heure ? Les attributions actuelles seront perdues.')) return;
    withBusy(e.target, async () => {
      const res = await adminCall('admin_set_draw_in', { p_minutes: mins });
      if (!res) return;
      if (!res.ok) { $('adm-time-error').textContent = errorText(res.error); return; }
      setAdminStatus(res);
      $('adm-time-ok').textContent = `Tirage fixé au ${fmtDate(res.draw_at).toLowerCase()} ✓`;
    });
  });

  $('adm-reset').addEventListener('click', async () => {
    const n = adminStatus ? (adminStatus.participants || []).length : 0;
    $('adm-reset-error').textContent = '';
    $('adm-reset-ok').textContent = '';
    if (!confirm(`Supprimer les ${n} inscrit(s) et le tirage ? C'est irréversible.`)) return;
    const btn = $('adm-reset');
    btn.disabled = true;
    try {
      const res = await adminCall('admin_reset_participants', {});
      if (!res) return;
      if (!res.ok) { $('adm-reset-error').textContent = errorText(res.error); return; }
      setAdminStatus(res);
      $('adm-reset-ok').textContent = 'Tous les participants ont été supprimés ✓';
    } finally {
      btn.disabled = false;
    }
  });

  $('adm-pass-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p1 = $('adm-new').value;
    const p2 = $('adm-new2').value;
    $('adm-pass-error').textContent = '';
    $('adm-pass-ok').textContent = '';
    if (p1.length < 8) { $('adm-pass-error').textContent = errorText('weak_password'); return; }
    if (p1 !== p2) { $('adm-pass-error').textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
    withBusy(e.target, async () => {
      const res = await adminCall('admin_change_password', { p_new_password: p1 });
      if (!res) return;
      if (!res.ok) { $('adm-pass-error').textContent = errorText(res.error); return; }
      admin.password = p1;
      $('adm-new').value = '';
      $('adm-new2').value = '';
      $('adm-pass-ok').textContent = 'Mot de passe changé ✓';
    });
  });

  // ---------- Démarrage ----------
  const saved = store.get(K_GROUP);
  if (saved) groupCode = saved;
  if (location.hash === '#admin') {
    openAdmin();
  } else if (saved) {
    groupCode = saved;
    loadInfo();
  } else {
    showGate('');
  }
})();
