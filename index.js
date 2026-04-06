const { Client, GatewayIntentBits, EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const cron = require('node-cron');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages  // <-- NEW: needed for DM reminders
  ]
});

const TEAM_SIZE = 5;
const ATTENDANCE_CHANNEL = 'attendance';
const BOT_OWNER_ID = '1292033694869225473';

const guildData = new Map();

class Scrim {
  constructor(id, time, team, channelId, reminder3minJob, reminderStartJob, dmReminderJob, attendanceMsgId) {
    this.id = id;
    this.time = time;
    this.team = team;
    this.channelId = channelId;
    this.reminder3minJob = reminder3minJob;
    this.reminderStartJob = reminderStartJob;
    this.dmReminderJob = dmReminderJob;   // <-- NEW: store DM cron job
    this.attendanceMsgId = attendanceMsgId;
    this.attendance = {};
  }
}

function getGuildScrims(guildId) {
  if (!guildData.has(guildId)) {
    guildData.set(guildId, { scrims: new Map(), lastButtonMsgId: null });
  }
  return guildData.get(guildId).scrims;
}

function isAdminOrMod(member) {
  return member.permissions.has('Administrator') ||
    member.permissions.has('ManageGuild') ||
    member.roles.cache.some(role =>
      role.name.toLowerCase() === 'moderator' ||
      role.name.toLowerCase() === 'mod' ||
      role.name.toLowerCase() === 'manager' ||
      role.name.toLowerCase() === 'staff'
    );
}

function generateScrimId(time, team) {
  return `${time}_${team}_${Date.now()}`;
}

function parseHour(time) {
  try {
    const clean = time.toUpperCase().trim();
    let hour, minute = 0;
    if (clean.includes(':')) {
      const [h, m] = clean.replace('AM', '').replace('PM', '').split(':');
      hour = parseInt(h);
      minute = parseInt(m);
    } else {
      hour = parseInt(clean.replace('AM', '').replace('PM', ''));
    }
    if (clean.includes('PM') && hour !== 12) hour += 12;
    if (clean.includes('AM') && hour === 12) hour = 0;
    return { hour, minute };
  } catch (e) {
    return null;
  }
}

async function sendAttendanceMessage(channel, scrim) {
  const available = Object.values(scrim.attendance).filter(p => p.status === 'available');
  const unavailable = Object.values(scrim.attendance).filter(p => p.status === 'unavailable');

  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle(`📋 Scrim Attendance — ${scrim.time}`)
    .addFields(
      { name: '🏷️ Team', value: scrim.team, inline: true },
      { name: '🆔 Scrim ID', value: scrim.id, inline: true },
      { name: '\u200B', value: '\u200B' },
      { name: `✅ Available (${available.length}/${TEAM_SIZE})`, value: available.length ? available.map(p => `• ${p.name}`).join('\n') : 'None yet' },
      { name: `❌ Unavailable (${unavailable.length}/${TEAM_SIZE})`, value: unavailable.length ? unavailable.map(p => `• ${p.name}`).join('\n') : 'None' }
    )
    .setFooter({ text: `Scrim at ${scrim.time} | ${scrim.team}` })
    .setTimestamp();

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('mark_attendance')
        .setLabel('✅ Mark Attendance')
        .setStyle(ButtonStyle.Primary)
    );

  const msg = await channel.send({ embeds: [embed], components: [row] });
  scrim.attendanceMsgId = msg.id;
  return msg;
}

async function updateAttendanceMessage(channel, scrim) {
  if (!scrim.attendanceMsgId) return;
  try {
    const msg = await channel.messages.fetch(scrim.attendanceMsgId);
    const available = Object.values(scrim.attendance).filter(p => p.status === 'available');
    const unavailable = Object.values(scrim.attendance).filter(p => p.status === 'unavailable');

    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle(`📋 Scrim Attendance — ${scrim.time}`)
      .addFields(
        { name: '🏷️ Team', value: scrim.team, inline: true },
        { name: '🆔 Scrim ID', value: scrim.id, inline: true },
        { name: '\u200B', value: '\u200B' },
        { name: `✅ Available (${available.length}/${TEAM_SIZE})`, value: available.length ? available.map(p => `• ${p.name}`).join('\n') : 'None yet' },
        { name: `❌ Unavailable (${unavailable.length}/${TEAM_SIZE})`, value: unavailable.length ? unavailable.map(p => `• ${p.name}`).join('\n') : 'None' }
      )
      .setFooter({ text: `Scrim at ${scrim.time} | ${scrim.team}` })
      .setTimestamp();

    await msg.edit({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mark_attendance').setLabel('✅ Mark Attendance').setStyle(ButtonStyle.Primary))] });
  } catch (e) { console.log('Update error:', e); }
}

function cancelScrimReminders(scrim) {
  if (scrim.reminder3minJob) { scrim.reminder3minJob.stop(); scrim.reminder3minJob = null; }
  if (scrim.reminderStartJob) { scrim.reminderStartJob.stop(); scrim.reminderStartJob = null; }
  if (scrim.dmReminderJob) { scrim.dmReminderJob.stop(); scrim.dmReminderJob = null; } // <-- NEW
}

function scheduleScrimReminders(guild, scrim) {
  cancelScrimReminders(scrim);
  const parsed = parseHour(scrim.time);
  if (!parsed) return false;
  const { hour, minute } = parsed;
  let reminderMin = minute - 3;
  let reminderHour = hour;
  if (reminderMin < 0) { reminderMin += 60; reminderHour -= 1; }

  // Channel reminder 3 minutes before
  scrim.reminder3minJob = cron.schedule(`${reminderMin} ${reminderHour} * * *`, async () => {
    const channel = guild.channels.cache.get(scrim.channelId);
    if (channel) channel.send(`⏰ @everyone **3 minutes until scrim (${scrim.team} at ${scrim.time})!** Get ready! 🎮`);
  });

  // DM reminder 5 minutes before (new)
  let dmMin = minute - 5;
  let dmHour = hour;
  if (dmMin < 0) { dmMin += 60; dmHour -= 1; }
  scrim.dmReminderJob = cron.schedule(`${dmMin} ${dmHour} * * *`, async () => {
    const channel = guild.channels.cache.get(scrim.channelId);
    if (!channel) return;
    // Get all users who marked available
    const availableUsers = Object.entries(scrim.attendance).filter(([_, p]) => p.status === 'available');
    for (const [userId, player] of availableUsers) {
      try {
        const user = await client.users.fetch(userId);
        await user.send(`🔔 **Reminder:** Your scrim for **${scrim.team}** at **${scrim.time}** starts in 5 minutes! Get ready! 🎮`);
      } catch (e) {
        console.log(`Could not DM ${player.name} (DMs closed)`);
      }
    }
    // Also send a note in channel that DMs were sent
    channel.send(`📨 Sent DM reminders to ${availableUsers.length} player(s) for **${scrim.team}** scrim.`);
  });

  // Starting now reminder
  scrim.reminderStartJob = cron.schedule(`${minute} ${hour} * * *`, async () => {
    const channel = guild.channels.cache.get(scrim.channelId);
    if (channel) channel.send(`🎮 @everyone **${scrim.team} scrim at ${scrim.time} is starting NOW!** GL! 🔥`);
  });
  return true;
}

async function deleteScrimAttendanceMessage(guild, scrim) {
  if (scrim.attendanceMsgId) {
    try {
      const channel = guild.channels.cache.get(scrim.channelId);
      if (channel) {
        const msg = await channel.messages.fetch(scrim.attendanceMsgId);
        await msg.delete();
      }
    } catch (e) { /* ignore */ }
  }
}

client.on('ready', () => {
  console.log('✅ Multi‑Scrim AttendanceBot online (with DM reminders)!');

  cron.schedule('0 0 * * *', () => {
    for (const [guildId, data] of guildData.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      for (const scrim of data.scrims.values()) {
        cancelScrimReminders(scrim);
        deleteScrimAttendanceMessage(guild, scrim);
      }
      data.scrims.clear();
      data.lastButtonMsgId = null;
      const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
      if (channel) channel.send('🔄 All scrims have been reset for today.');
    }
  });
});

client.on('guildCreate', async (guild) => {
  const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
  const defaultChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has('SendMessages'));
  if (!channel && defaultChannel) {
    defaultChannel.send(`⚠️ Please create a text channel named \`${ATTENDANCE_CHANNEL}\` for me to work.`);
  } else if (channel) {
    channel.send('👋 AttendanceBot is ready! Use `!help` to get started. I will also DM reminders 5 mins before scrim.');
  }
});

// Button: mark_attendance → show select menu
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== 'mark_attendance') return;
  const guildId = interaction.guild.id;
  const scrimsMap = getGuildScrims(guildId);
  if (scrimsMap.size === 0) {
    return interaction.reply({ content: '❌ No active scrims. Use `!scrim` to create one.', ephemeral: true });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_scrim')
    .setPlaceholder('Choose a scrim')
    .addOptions(
      Array.from(scrimsMap.values()).map(scrim => {
        const availCount = Object.values(scrim.attendance).filter(p => p.status === 'available').length;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${scrim.team} @ ${scrim.time}`)
          .setDescription(`${availCount}/${TEAM_SIZE} available`)
          .setValue(scrim.id);
      })
    );

  const row = new ActionRowBuilder().addComponents(selectMenu);
  await interaction.reply({ content: 'Select the scrim you want to respond to:', components: [row], ephemeral: true });
});

// Select menu → ask available/unavailable
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu() || interaction.customId !== 'select_scrim') return;
  const scrimId = interaction.values[0];
  const guildId = interaction.guild.id;
  const scrimsMap = getGuildScrims(guildId);
  const scrim = scrimsMap.get(scrimId);
  if (!scrim) {
    return interaction.update({ content: '❌ This scrim no longer exists.', components: [], ephemeral: true });
  }

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId(`avail_${scrimId}`).setLabel('✅ Available').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`unavail_${scrimId}`).setLabel('❌ Unavailable').setStyle(ButtonStyle.Danger)
    );
  await interaction.update({ content: `Mark attendance for **${scrim.team} at ${scrim.time}**:`, components: [row], ephemeral: true });
});

// Handle available/unavailable buttons
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('avail_') && !interaction.customId.startsWith('unavail_')) return;

  const scrimId = interaction.customId.slice(interaction.customId.indexOf('_') + 1);
  const isAvailable = interaction.customId.startsWith('avail_');
  const userId = interaction.user.id;
  const username = interaction.user.username;
  const guildId = interaction.guild.id;
  const scrimsMap = getGuildScrims(guildId);
  const scrim = scrimsMap.get(scrimId);
  if (!scrim) {
    return interaction.reply({ content: '❌ This scrim no longer exists.', ephemeral: true });
  }

  scrim.attendance[userId] = { name: username, status: isAvailable ? 'available' : 'unavailable' };
  await interaction.reply({ content: `${isAvailable ? '✅' : '❌'} **${username}** marked as ${isAvailable ? 'available' : 'unavailable'} for **${scrim.team} at ${scrim.time}**.`, ephemeral: true });

  const channel = interaction.guild.channels.cache.get(scrim.channelId);
  if (channel) {
    await updateAttendanceMessage(channel, scrim);
    const available = Object.values(scrim.attendance).filter(p => p.status === 'available');
    if (available.length >= TEAM_SIZE) {
      channel.send(`🎮 **${scrim.team}** has ${TEAM_SIZE} players available! Scrim at ${scrim.time} is ON! 🔥`);
    }
  }
});

// ---------- Message commands ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const guildId = message.guild.id;
  const scrimsMap = getGuildScrims(guildId);

  // !help (updated with DM reminder info)
  if (cmd === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('📋 Multi‑Scrim Attendance Bot')
      .addFields(
        { name: '👤 Everyone', value: '`!scrim <time> <team>` – create a scrim\n`!scrims` – list all scrims\n`!attendance [scrimId]` – show attendance\n`!remind [scrimId]` – ping @everyone\n`!ping [scrimId]` – ping non‑responders' },
        { name: '🔒 Admin/Mod/Staff', value: '`!scrim cancel <scrimId>` – cancel scrim\n`!scrim clear <scrimId>` – clear attendance\n`!scrim remove <scrimId> @user` – remove player' },
        { name: '👑 Bot Owner', value: '`!broadcast <msg>` – send to all servers' },
        { name: '📌 New: DM Reminders', value: '5 minutes before scrim, I will DM every player who marked **available**. Make sure your DMs are open!' },
        { name: '📌 How to mark attendance', value: 'Click **✅ Mark Attendance** on any scrim message, choose the scrim, then click Available/Unavailable.' }
      )
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // !scrim <time> <team>
  if (cmd === 'scrim' && args[1] && !['cancel', 'clear', 'remove'].includes(args[1])) {
    const time = args[1].toUpperCase();
    const team = args.slice(2).join(' ');
    if (!team) return message.reply('Usage: `!scrim 9PM TeamName`');
    if (!time.includes('AM') && !time.includes('PM')) return message.reply('Invalid time format. Use like `9PM` or `9:30PM`');

    const channel = message.guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
    if (!channel) return message.reply(`❌ No #${ATTENDANCE_CHANNEL} channel found.`);

    const scrimId = generateScrimId(time, team);
    const newScrim = new Scrim(scrimId, time, team, channel.id, null, null, null, null);
    scrimsMap.set(scrimId, newScrim);
    await sendAttendanceMessage(channel, newScrim);
    scheduleScrimReminders(message.guild, newScrim);
    return message.reply(`✅ Scrim created: **${team}** at **${time}** (ID: \`${scrimId}\`)\n📨 I will DM available players 5 minutes before.`);
  }

  // !scrims
  if (cmd === 'scrims') {
    if (scrimsMap.size === 0) return message.reply('No active scrims.');
    const list = Array.from(scrimsMap.values()).map(s => {
      const avail = Object.values(s.attendance).filter(p => p.status === 'available').length;
      return `• **${s.team}** at ${s.time} – ${avail}/${TEAM_SIZE} available (ID: \`${s.id}\`)`;
    }).join('\n');
    return message.reply(`**Active scrims:**\n${list}`);
  }

  // !scrim cancel <scrimId>
  if (cmd === 'scrim' && args[1] === 'cancel') {
    if (!isAdminOrMod(message.member)) return message.reply('❌ Admin/mod/staff only.');
    const scrimId = args[2];
    if (!scrimId) return message.reply('Usage: `!scrim cancel <scrimId>`');
    const scrim = scrimsMap.get(scrimId);
    if (!scrim) return message.reply('Scrim not found.');
    cancelScrimReminders(scrim);
    await deleteScrimAttendanceMessage(message.guild, scrim);
    scrimsMap.delete(scrimId);
    return message.reply(`❌ Scrim \`${scrimId}\` cancelled.`);
  }

  // !scrim clear <scrimId>
  if (cmd === 'scrim' && args[1] === 'clear') {
    if (!isAdminOrMod(message.member)) return message.reply('❌ Admin/mod/staff only.');
    const scrimId = args[2];
    if (!scrimId) return message.reply('Usage: `!scrim clear <scrimId>`');
    const scrim = scrimsMap.get(scrimId);
    if (!scrim) return message.reply('Scrim not found.');
    scrim.attendance = {};
    const channel = message.guild.channels.cache.get(scrim.channelId);
    if (channel) await updateAttendanceMessage(channel, scrim);
    return message.reply(`✅ Attendance cleared for \`${scrimId}\`.`);
  }

  // !scrim remove <scrimId> @user
  if (cmd === 'scrim' && args[1] === 'remove') {
    if (!isAdminOrMod(message.member)) return message.reply('❌ Admin/mod/staff only.');
    const scrimId = args[2];
    const target = message.mentions.members.first();
    if (!scrimId || !target) return message.reply('Usage: `!scrim remove <scrimId> @user`');
    const scrim = scrimsMap.get(scrimId);
    if (!scrim) return message.reply('Scrim not found.');
    if (!scrim.attendance[target.id]) return message.reply('User not in attendance list.');
    delete scrim.attendance[target.id];
    const channel = message.guild.channels.cache.get(scrim.channelId);
    if (channel) await updateAttendanceMessage(channel, scrim);
    return message.reply(`✅ Removed ${target.user.username} from \`${scrimId}\`.`);
  }

  // !attendance [scrimId]
  if (cmd === 'attendance') {
    const scrimId = args[1];
    if (scrimId) {
      const scrim = scrimsMap.get(scrimId);
      if (!scrim) return message.reply('Scrim not found.');
      const available = Object.values(scrim.attendance).filter(p => p.status === 'available');
      const unavailable = Object.values(scrim.attendance).filter(p => p.status === 'unavailable');
      const embed = new EmbedBuilder()
        .setTitle(`📋 ${scrim.team} @ ${scrim.time}`)
        .addFields(
          { name: '✅ Available', value: available.length ? available.map(p => p.name).join('\n') : 'None', inline: true },
          { name: '❌ Unavailable', value: unavailable.length ? unavailable.map(p => p.name).join('\n') : 'None', inline: true }
        );
      return message.reply({ embeds: [embed] });
    } else {
      if (scrimsMap.size === 0) return message.reply('No active scrims.');
      let summary = '';
      for (const scrim of scrimsMap.values()) {
        const avail = Object.values(scrim.attendance).filter(p => p.status === 'available').length;
        summary += `**${scrim.team}** at ${scrim.time}: ${avail}/${TEAM_SIZE} available\n`;
      }
      return message.reply(summary);
    }
  }

  // !remind [scrimId]
  if (cmd === 'remind') {
    let targets = [];
    if (args[1]) {
      const scrim = scrimsMap.get(args[1]);
      if (!scrim) return message.reply('Scrim not found.');
      targets = [scrim];
    } else {
      targets = Array.from(scrimsMap.values());
    }
    if (targets.length === 0) return message.reply('No active scrims.');
    for (const scrim of targets) {
      await message.channel.send(`@everyone Please mark attendance for **${scrim.team} at ${scrim.time}** (ID: \`${scrim.id}\`) using the buttons!`);
    }
    return;
  }

  // !ping [scrimId]
  if (cmd === 'ping') {
    let targets = [];
    if (args[1]) {
      const scrim = scrimsMap.get(args[1]);
      if (!scrim) return message.reply('Scrim not found.');
      targets = [scrim];
    } else {
      targets = Array.from(scrimsMap.values());
    }
    if (targets.length === 0) return message.reply('No active scrims.');
    const members = await message.guild.members.fetch();
    for (const scrim of targets) {
      const responded = Object.keys(scrim.attendance);
      const notResponded = members.filter(m => !m.user.bot && !responded.includes(m.user.id));
      if (notResponded.size === 0) continue;
      const mentions = notResponded.map(m => `<@${m.user.id}>`).join(' ');
      await message.channel.send(`⚠️ **${scrim.team} @ ${scrim.time}** – ${mentions} please mark attendance!`);
    }
    return;
  }

  // !broadcast (owner only)
  if (cmd === 'broadcast') {
    if (message.author.id !== BOT_OWNER_ID) return message.reply('Only bot owner can broadcast.');
    const announcement = message.content.slice(11).trim();
    if (!announcement) return message.reply('Usage: `!broadcast <message>`');
    let success = 0, fail = 0;
    for (const gui
