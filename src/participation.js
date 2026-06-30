import { supabase } from './supabase.js';
import { log } from './logger.js';

const VOTE_EMOJI = '❤️';

function hasImage(message) {
  if (message.attachments.some(a => a.contentType?.startsWith('image/'))) return true;
  if (message.embeds.some(e => e.image || e.thumbnail)) return true;
  return false;
}

function hasTextContent(message) {
  return message.content && message.content.trim().length > 0;
}

function getImageUrl(message) {
  const attachment = message.attachments.find(a => a.contentType?.startsWith('image/'));
  if (attachment) return attachment.url;
  const embed = message.embeds.find(e => e.image || e.thumbnail);
  return embed?.image?.url ?? embed?.thumbnail?.url ?? null;
}

async function sendDM(user, text) {
  try {
    const dm = await user.createDM();
    await dm.send(text);
  } catch {
    // DMs may be closed
  }
}

export async function handleScreenshotMessage(message, guildConfig, contest) {
  const hasImg = hasImage(message);
  const hasText = hasTextContent(message);

  // Delete message and DM user if it's text-only or text+image
  if (!hasImg) {
    await message.delete().catch(() => null);
    await sendDM(message.author,
      `❌ **Salon concours** : seules les images sont autorisées dans ce salon. Pas de texte sans image.`
    );
    return false;
  }

  if (hasText) {
    await message.delete().catch(() => null);
    await sendDM(message.author,
      `❌ **Salon concours** : tu ne peux pas joindre du texte avec ton image. Reposte uniquement l'image, sans texte.`
    );
    return false;
  }

  const discordUserId = message.author.id;
  const guildId = message.guildId;

  // Check if user is banned from contest
  const { data: ban } = await supabase
    .from('contest_bans')
    .select('reason, expires_at')
    .eq('environment_id', guildConfig.environment_id)
    .eq('discord_user_id', discordUserId)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .limit(1)
    .single();

  if (ban) {
    await message.delete().catch(() => null);
    const expiry = ban.expires_at
      ? `jusqu'au <t:${Math.floor(new Date(ban.expires_at).getTime() / 1000)}:F>`
      : 'définitivement';
    await sendDM(message.author,
      `🚫 **Tu es exclu du concours screenshot** ${expiry}.\n` +
      (ban.reason ? `**Raison :** ${ban.reason}` : '')
    );
    await log(guildId, 'banned_user_blocked', { discordUserId, reason: ban.reason });
    return false;
  }

  // Upsert participant
  const { data: participant, error: pErr } = await supabase
    .from('participants')
    .upsert(
      {
        discord_user_id: discordUserId,
        discord_username: message.author.username,
        discord_display_name: message.member?.displayName ?? message.author.username,
        avatar_url: message.author.displayAvatarURL({ extension: 'png', size: 256 }),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'discord_user_id', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (pErr) {
    await log(guildId, 'participant_upsert_failed', { error: pErr.message, discordUserId }, 'error');
    return false;
  }

  // Check if participant already submitted for this contest
  const { data: existing } = await supabase
    .from('participations')
    .select('id, message_id')
    .eq('participant_id', participant.id)
    .eq('contest_id', contest.id)
    .single();

  if (existing) {
    await message.delete().catch(() => null);
    await sendDM(message.author,
      `❌ **Salon concours** : tu as déjà soumis une participation pour ce concours.\n\n` +
      `Pour changer ta photo, supprime d'abord ton ancienne participation dans le salon, puis reposte ta nouvelle image.`
    );
    await log(guildId, 'duplicate_submission_blocked', { discordUserId, contestId: contest.id }, 'warn');
    return false;
  }

  const imageUrl = getImageUrl(message);

  const { error: subErr } = await supabase.from('participations').insert({
    participant_id: participant.id,
    contest_id: contest.id,
    image_url: imageUrl,
    message_id: message.id,
    vote_count: 0,
    submitted_at: new Date().toISOString(),
  });

  if (subErr) {
    await log(guildId, 'participation_insert_failed', { error: subErr.message }, 'error');
    return false;
  }

  // Add ❤️ reaction as the vote emoji
  await message.react(VOTE_EMOJI);

  // Every 2 participations, send a short promo message pointing to the leaderboard
  const { count } = await supabase
    .from('participations')
    .select('id', { count: 'exact', head: true })
    .eq('contest_id', contest.id);

  if (count && count % 2 === 0) {
    await message.channel.send(
      `🏆 **${count} participants** cette semaine ! Retrouve le classement de la saison sur **[trakr.fr](https://trakr.fr)** 📊`
    );
  }

  await log(guildId, 'participation_submitted', {
    discordUserId,
    username: message.author.username,
    contestId: contest.id,
    imageUrl,
  });

  return true;
}

export async function handleVoteReaction(reaction, user, add, guildId, contest) {
  if (reaction.emoji.name !== VOTE_EMOJI) return;
  if (user.bot) return;

  const messageId = reaction.message.id;

  const { data: participation } = await supabase
    .from('participations')
    .select('id, participant_id, vote_count')
    .eq('message_id', messageId)
    .eq('contest_id', contest.id)
    .single();

  if (!participation) return;

  // Prevent self-voting
  const { data: participant } = await supabase
    .from('participants')
    .select('discord_user_id')
    .eq('id', participation.participant_id)
    .single();

  if (participant?.discord_user_id === user.id) {
    if (add) {
      await reaction.users.remove(user.id).catch(() => null);
      await sendDM(user, '❌ Tu ne peux pas voter pour ta propre participation.');
    }
    return;
  }

  const delta = add ? 1 : -1;
  const newCount = Math.max(0, participation.vote_count + delta);

  await supabase
    .from('participations')
    .update({ vote_count: newCount })
    .eq('id', participation.id);

  await log(guildId, add ? 'vote_added' : 'vote_removed', {
    voterId: user.id,
    participationId: participation.id,
    newCount,
  });
}
