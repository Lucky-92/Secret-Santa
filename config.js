// Connexion à Supabase.
// Ces deux valeurs sont PUBLIQUES par conception : elles peuvent aller dans le dépôt.
// Supabase > Project Settings > API Keys :
//   - SUPABASE_URL : "Project URL", ex. https://abcdefghijkl.supabase.co
//   - SUPABASE_ANON_KEY : la clé "anon" (eyJ...) ou "publishable" (sb_publishable_...)
// ⚠️ Ne mettez JAMAIS ici la clé "service_role" ni une clé "secret" (sb_secret_...).
window.SANTA_CONFIG = {
  SUPABASE_URL: 'https://bwbudwpicmmmsyyekkgk.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_Z02Wck-VEYDtFA2FgwNqgw_7rFtc1-Z'
};
