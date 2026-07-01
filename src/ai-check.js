const API_USER   = process.env.SIGHTENGINE_API_USER;
const API_SECRET = process.env.SIGHTENGINE_API_SECRET;

// Minimum probability (0–1) to send a mod alert
const ALERT_THRESHOLD = 0.40;

export async function checkAiGenerated(imageUrl) {
  if (!API_USER || !API_SECRET) return null;

  try {
    const url = `https://api.sightengine.com/1.0/check.json?url=${encodeURIComponent(imageUrl)}&models=ai-generated&api_user=${API_USER}&api_secret=${API_SECRET}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success') return null;
    return data.type?.ai_generated ?? null;
  } catch {
    return null;
  }
}

export async function sendAiAlert(client, guildConfig, message, participant, score) {
  const channelId = guildConfig.ai_alert_channel_id;
  if (!channelId) return;

  const pct = Math.round(score * 100);
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const jumpUrl = message.url;
  await channel.send(
    `⚠️ **Détection IA — Vérification requise**\n` +
    `**Participant :** <@${participant.discord_user_id}> (${participant.discord_username})\n` +
    `**Probabilité IA :** ${pct}% selon Sightengine\n` +
    `**Message :** ${jumpUrl}\n\n` +
    `_Aucune sanction automatique — décision à prendre manuellement via \`/contest ban\`._`
  );
}

export { ALERT_THRESHOLD };
