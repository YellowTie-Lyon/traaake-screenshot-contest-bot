import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { log } from '../logger.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('contest')
    .setDescription('Gérer le concours screenshot')
    .addSubcommand(sub =>
      sub.setName('open').setDescription('Ouvrir un nouveau concours')
    )
    .addSubcommand(sub =>
      sub.setName('close').setDescription('Fermer le concours actuel et annoncer les gagnants')
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Voir le statut du concours actuel')
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Afficher le classement de la saison'),

  new SlashCommandBuilder()
    .setName('syncconfig')
    .setDescription('Recharger la configuration depuis Supabase'),
].map(cmd => cmd.toJSON());

export async function registerCommands(client) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash commands registered globally.');
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}
