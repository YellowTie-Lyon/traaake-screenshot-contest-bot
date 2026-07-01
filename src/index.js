import 'dotenv/config';
import { fetchEnvironment, watchEnvironment } from './environment.js';
import { connectBot, disconnectBot } from './bot.js';
import { log } from './logger.js';

let activeClient = null;

async function onActivate(env) {
  if (activeClient) {
    console.log('[MAIN] Already connected, ignoring duplicate activate signal.');
    return;
  }
  try {
    activeClient = await connectBot(env);
  } catch (err) {
    await log(null, 'bot_connect_failed', { error: err.message, environment: env.name }, 'error');
    console.error('[MAIN] Failed to connect bot:', err.message);
  }
}

async function onDeactivate(env) {
  if (!activeClient) return;
  const client = activeClient;
  activeClient = null;
  await disconnectBot(client, env.name);
}

async function main() {
  console.log('[MAIN] Starting TraaaKe bot process...');

  // Fetch this process's environment row from Supabase
  const env = await fetchEnvironment();
  console.log(`[MAIN] Environment: "${env.name}" | is_active: ${env.is_active}`);

  // Subscribe to Realtime changes — this keeps the process alive
  watchEnvironment(onActivate, onDeactivate);

  // If already active at startup, connect immediately
  if (env.is_active) {
    await onActivate(env);
  } else {
    console.log(`[MAIN] Environment "${env.name}" is inactive. Waiting for activation via dashboard...`);
    await log(null, 'bot_standing_by', { environment: env.name });
  }

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`[MAIN] Received ${signal}, shutting down...`);
      if (activeClient) await disconnectBot(activeClient, env.name);
      process.exit(0);
    });
  }
}

main().catch(err => {
  console.error('[MAIN] Fatal error:', err.message);
  process.exit(1);
});
