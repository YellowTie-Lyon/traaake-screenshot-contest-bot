// One-shot script to import historical winners from a Discord channel.
// Usage: node src/import-winners.js
// The bot must be a member of the server that owns the channel.

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const CHANNEL_ID = '1085909421374312458';
const ENVIRONMENT_ID = '22222222-2222-2222-2222-222222222222';
const VOTE_EMOJI = '❤️';

const SEASONS = {
  '2023': '5e6a74b7-6587-431b-a112-6ce26fa74a00',
  '2024': '98f36f99-30a3-4353-92ea-8cf10e427484',
  '2025': '1715a133-9137-48b1-a3fa-b9a2c6999665',
  '2026': '33333333-3333-3333-3333-333333333333',
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false }, realtime: { transport: ws } }
);

function getSeasonId(date) {
  const year = date.getFullYear().toString();
  return SEASONS[year] ?? null;
}

// Returns the Wednesday 17:58 before or on the message date (week start)
function weekStart(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 3=Wed
  const daysBack = (day - 3 + 7) % 7 || 7;
  d.setDate(d.getDate() - daysBack);
  d.setHours(18, 0, 0, 0);
  return d;
}

// Returns the Wednesday 17:58 after week start (week end)
function weekEnd(start) {
  const d = new Date(start);
  d.setDate(d.getDate() + 7);
  return d;
}

async function fetchAllMessages(channel) {
  const messages = [];
  let before = null;

  console.log('Fetching messages...');
  while (true) {
    const options = { limit: 100 };
    if (before) options.before = before;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    for (const msg of batch.values()) messages.push(msg);
    before = batch.last().id;

    console.log(`  Fetched ${messages.length} messages so far...`);
    await new Promise(r => setTimeout(r, 500)); // avoid rate limit
  }

  return messages;
}

async function importWinners() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  const { data: env } = await supabase
    .from('environments')
    .select('discord_bot_token')
    .eq('id', ENVIRONMENT_ID)
    .single();
  if (!env?.discord_bot_token) throw new Error('No discord_bot_token found in environments table');

  await client.login(env.discord_bot_token);
  console.log(`Logged in as ${client.user.tag}`);

  const channel = await client.channels.fetch(CHANNEL_ID);
  if (!channel) throw new Error(`Channel ${CHANNEL_ID} not found`);
  console.log(`Channel: #${channel.name}`);

  const messages = await fetchAllMessages(channel);

  // Keep only messages with an image and at least 1 ❤️
  const winners = messages.filter(msg => {
    const hasImage = msg.attachments.some(a => a.contentType?.startsWith('image/'))
      || msg.embeds.some(e => e.image || e.thumbnail);
    const votes = msg.reactions.cache.get(VOTE_EMOJI)?.count ?? 0;
    return hasImage && votes > 0;
  });

  // Sort oldest first
  winners.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  console.log(`\nFound ${winners.length} winner messages to import.\n`);

  let imported = 0;
  let skipped = 0;

  for (const msg of winners) {
    const author = msg.author;
    const createdAt = msg.createdAt;
    const votes = msg.reactions.cache.get(VOTE_EMOJI)?.count ?? 0;
    const imageUrl = msg.attachments.first()?.url
      ?? msg.embeds.find(e => e.image || e.thumbnail)?.image?.url
      ?? msg.embeds.find(e => e.image || e.thumbnail)?.thumbnail?.url
      ?? null;

    const seasonId = getSeasonId(createdAt);
    if (!seasonId) {
      console.log(`  SKIP ${author.username} (${createdAt.toISOString()}) — no season for year ${createdAt.getFullYear()}`);
      skipped++;
      continue;
    }

    const start = weekStart(createdAt);
    const end = weekEnd(start);

    console.log(`Importing: ${author.username} | ${createdAt.toDateString()} | ${votes} ❤️`);

    // Upsert participant
    const { data: participant, error: pErr } = await supabase
      .from('participants')
      .upsert({
        discord_user_id: author.id,
        discord_username: author.username,
        discord_display_name: author.username,
        avatar_url: author.displayAvatarURL({ extension: 'png', size: 256 }),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'discord_user_id', ignoreDuplicates: false })
      .select()
      .single();

    if (pErr) {
      console.error(`  ERROR upserting participant: ${pErr.message}`);
      skipped++;
      continue;
    }

    // Create historical contest
    const { data: contest, error: cErr } = await supabase
      .from('contests')
      .insert({
        environment_id: ENVIRONMENT_ID,
        season_id: seasonId,
        status: 'closed',
        title: 'Concours Screenshot',
        started_at: start.toISOString(),
        ends_at: end.toISOString(),
        original_ends_at: end.toISOString(),
        closed_at: end.toISOString(),
        winner_discord_user_id: author.id,
      })
      .select()
      .single();

    if (cErr) {
      console.error(`  ERROR inserting contest: ${cErr.message}`);
      skipped++;
      continue;
    }

    // Insert participation
    const { data: participation, error: partErr } = await supabase
      .from('participations')
      .insert({
        contest_id: contest.id,
        participant_id: participant.id,
        image_url: imageUrl,
        message_id: msg.id,
        vote_count: votes,
        submitted_at: createdAt.toISOString(),
        is_winner: true,
        final_rank: 1,
        is_valid: true,
      })
      .select()
      .single();

    if (partErr) {
      console.error(`  ERROR inserting participation: ${partErr.message}`);
      skipped++;
      continue;
    }

    // Link winner_participation_id on contest
    await supabase.from('contests')
      .update({ winner_participation_id: participation.id })
      .eq('id', contest.id);

    // Increment win_count on participant
    await supabase.from('participants')
      .update({ win_count: (participant.win_count ?? 0) + 1 })
      .eq('id', participant.id);

    console.log(`  ✓ Imported`);
    imported++;
  }

  console.log(`\nDone. ${imported} imported, ${skipped} skipped.`);
  await client.destroy();
  process.exit(0);
}

importWinners().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
