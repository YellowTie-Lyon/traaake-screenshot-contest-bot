import { supabase } from './supabase.js';

if (!process.env.ENVIRONMENT_ID) {
  throw new Error('Missing ENVIRONMENT_ID env variable');
}

export const ENVIRONMENT_ID = process.env.ENVIRONMENT_ID;

/**
 * Fetches the full environment row from Supabase.
 * Must contain: id, name, is_active, discord_bot_token, discord_app_id
 */
export async function fetchEnvironment() {
  const { data, error } = await supabase
    .from('environments')
    .select('id, name, is_active, discord_bot_token, discord_app_id')
    .eq('id', ENVIRONMENT_ID)
    .single();

  if (error || !data) {
    throw new Error(`Environment ${ENVIRONMENT_ID} not found in Supabase: ${error?.message}`);
  }

  if (!data.discord_bot_token) {
    throw new Error(`No discord_bot_token set for environment ${data.name}`);
  }

  return data;
}

/**
 * Subscribes to Realtime changes on the environments row for this process.
 * Calls onActivate() when is_active flips to true, onDeactivate() when it flips to false.
 */
export function watchEnvironment(onActivate, onDeactivate) {
  const channel = supabase
    .channel(`env-${ENVIRONMENT_ID}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'environments',
        filter: `id=eq.${ENVIRONMENT_ID}`,
      },
      async payload => {
        const updated = payload.new;
        console.log(`[ENV] environment "${updated.name}" is_active → ${updated.is_active}`);

        if (updated.is_active) {
          await onActivate(updated);
        } else {
          await onDeactivate(updated);
        }
      }
    )
    .subscribe(status => {
      console.log(`[ENV] Realtime subscription status: ${status}`);
    });

  return channel;
}
