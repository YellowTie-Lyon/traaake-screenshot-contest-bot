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
    )
    .addSubcommand(sub =>
      sub.setName('check').setDescription('Forcer la vérification des votes maintenant (admin)')
    ),

  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Afficher le classement de la saison'),

  new SlashCommandBuilder()
    .setName('syncconfig')
    .setDescription('Recharger la configuration depuis Supabase'),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Remettre le classement à zéro (admin uniquement)')
    .addStringOption(opt =>
      opt.setName('confirmation')
        .setDescription('Tapez "CONFIRMER" pour valider le reset')
        .setRequired(true)
    ),
].map(cmd => cmd.toJSON());

export async function registerCommands(client, token) {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    // Register on each guild directly (instant, no propagation delay)
    for (const guild of client.guilds.cache.values()) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands }
      );
      console.log(`Slash commands registered on guild ${guild.name}.`);
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}
