// One-shot script: re-upload all winner images to Supabase Storage
// Run: node src/upload-winners-images.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import ws from 'ws';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } },
);

const ENVIRONMENT_ID = process.env.ENVIRONMENT_ID ?? process.env.ENVIRONMENT_ID_PROD;
const CONTEST_CHANNEL_ID = '1085909421374312458';

async function uploadImage(imageUrl, participationId) {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'image/png';
    const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
    const buffer = Buffer.from(await res.arrayBuffer());
    const path = `${participationId}.${ext}`;
    const { error } = await supabase.storage.from('winners').upload(path, buffer, {
      contentType,
      upsert: true,
    });
    if (error) { console.error(`  Storage error: ${error.message}`); return null; }
    const { data } = supabase.storage.from('winners').getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error(`  Fetch error: ${err.message}`);
    return null;
  }
}

async function main() {
  // Fetch bot token from Supabase
  const { data: env } = await supabase
    .from('environments')
    .select('discord_bot_token')
    .eq('id', ENVIRONMENT_ID)
    .single();

  if (!env?.discord_bot_token) throw new Error('No bot token found');

  // Login Discord client
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel],
  });

  await client.login(env.discord_bot_token);
  await new Promise(resolve => client.once('ready', resolve));
  console.log(`[BOT] Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(CONTEST_CHANNEL_ID).catch(() => null);
  if (!channel) throw new Error(`Channel ${CONTEST_CHANNEL_ID} not found`);
  console.log(`[BOT] Channel: #${channel.name}`);

  // Get all winner participations
  const { data: winners } = await supabase
    .from('participations')
    .select('id, message_id, image_url, participants(discord_username)')
    .eq('is_winner', true)
    .not('message_id', 'is', null);

  console.log(`\n[INFO] ${winners.length} gagnants à traiter\n`);

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const w of winners) {
    const username = w.participants?.discord_username ?? 'inconnu';

    // Already hosted on Supabase Storage
    if (w.image_url?.includes('supabase')) {
      console.log(`[SKIP] ${username} — déjà hébergé`);
      skipped++;
      continue;
    }

    // Fetch fresh Discord message to get valid attachment URL
    const message = await channel.messages.fetch(w.message_id).catch(() => null);
    const freshUrl = message?.attachments?.first()?.url ?? null;

    if (!freshUrl) {
      console.log(`[FAIL] ${username} — message introuvable (${w.message_id})`);
      failed++;
      continue;
    }

    const permanentUrl = await uploadImage(freshUrl, w.id);
    if (!permanentUrl) {
      console.log(`[FAIL] ${username} — upload échoué`);
      failed++;
      continue;
    }

    await supabase.from('participations').update({ image_url: permanentUrl }).eq('id', w.id);
    console.log(`[OK]   ${username} → ${permanentUrl}`);
    success++;

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n✅ Terminé — ${success} uploadés, ${skipped} ignorés, ${failed} échoués`);
  await client.destroy();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
