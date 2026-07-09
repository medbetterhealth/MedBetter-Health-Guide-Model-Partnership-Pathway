/*
 * supabase-client.js
 * ------------------------------------------------------------------
 * Creates the single shared Supabase client used by partner-api.js for
 * ALL partner authentication (signUp / signInWithPassword /
 * resetPasswordForEmail / updateUser). Requires the Supabase JS SDK
 * loaded first via CDN, before this file:
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *
 * FILL IN YOUR OWN PROJECT'S VALUES BELOW.
 * Find them in your Supabase project at Project Settings -> API:
 *   SUPABASE_URL       -> "Project URL"
 *   SUPABASE_ANON_KEY   -> "anon" "public" key
 *
 * Both of these are PUBLIC values, safe to ship in frontend JS (that's
 * what they're designed for). Do NOT ever put the "service_role" key
 * here or in any frontend file -- that one is secret and bypasses all
 * security rules if leaked.
 * ------------------------------------------------------------------
 */
const SUPABASE_URL = 'https://yjfubzjkqygimfboapgk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_F0nKeadU_X6Id07pDSM_mg_8pOw0BXJ';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


