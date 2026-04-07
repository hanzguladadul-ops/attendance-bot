const {
  Client, GatewayIntentBits, EmbedBuilder, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require('discord.js');
const cron = require('node-cron');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ]
});

// ─── Constants ───────────────────────────────────────────────
const TEAM_SIZE = 5;
const ATTENDANCE_CHANNEL = 'attendance';
const BOT_OWNER_ID = '1292033694869225473';

// ─── Guild Data Store ─────────────────────────────────────────
const guildData = new Map();

function getGuildScrims(guildId) {
  if (!guildData.has(guildId)) {
    guildData.set(guildId, { scrims: new Map() });
  }
  return guildData.get(guildId).scrims;
}

// ─── Scrim Class ──────────────────────────────────────────────
class Scrim {
  constructor(id, time, team, channelId) {
    this.id = id;
    this.time = time;
    this.team = team;
    this.channelId = channelId;
    this.attendance = {};
    this.attendanceMsgId = null;
    this.reminder3minJob = null;
    this.reminderStartJob = null;
    this.dmReminderJob = null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────
function isAdminOrMod(member) {
  return (
    member.permissions.has('Administrator') ||
    member.permissions.has('ManageGuild') ||
    member.roles.cache.some(r =>
      ['moderator', 'mod', 'manager', 'staff'].includes(r.name.toLowerCase())
    )
  );
}

function generateScrimId(time, team) {
  return `${time}_${team.replace(/\s+/g, '_')}_${Date.now()}`;
}

function parseHour(time) {
  try {
    const clean = time.toUpperCase().trim();
    let hour = 0, minute = 0;
    if (clean.includes(':')) {
      const [h, m] = clean.replace(/AM|PM/g, '').split(':');
      hour = parseInt(h);
      minute = parseInt(m);
    } else {
      hour = parseInt(clean.replace(/AM|PM/g, ''));
    }
    if (clean.includes('PM') && hour !== 12) hour += 12;
    if (clean.includes('AM') && hour === 12) hour = 0;
    return { hour, minute };
  } catch {
    return null;
  }
}

function getAvailable(scrim) {
  return Object.values(scrim.attendance).filter(p => p.status === 'available');
}

function getUnavailable(scrim) {
  return Object.values(scrim.attendance).filter(p => p.status === 'unavailable');
}

// ─── Attendance Embed ─────────────────────────────────────────
function buildAttendanceEmbed(scrim) {
  const available = getAvailable(scrim);
  const unavailable = getUnavailable(scrim);

  return new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle(`📋 Scrim Attendance — ${scrim.time}`)
    .addFields(
      { name: '🏷️ Team', value: scrim.team, inline: true },
      { name: '🆔 Scrim ID', value: `\`${scrim.id}\``, inline: true },
      { name: '\u200B', value: '\u200B' },
      {
        name: `✅ Available (${available.length}/${TEAM_SIZE})`,
        value: available.length ? available.map(p => `• ${p.name}`).join('\n') : 'None yet'
      },
      {
        name: `❌ Unavailable (${unavailable.length}/${TEAM_SIZE})`,
        value: unavailable.length ? unavailable.map(p => `• ${p.name}`).join('\n') : 'None'
      }
    )
    .setFooter({ text: `Scrim at ${scrim.time} | ${scrim.team}` })
    .setTimestamp();
}

function buildAttendanceRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mark_attendance')
      .setLabel('✅ Mark Attendance')
      .setStyle(ButtonStyle.Primary)
  );
}

async function sendAttendanceMessage(channel, scrim) {
  const msg = await channel.send({
    embeds: [buildAttendanceEmbed(scrim)],
    components: [buildAttendanceRow()]
  });
  scrim.attendanceMsgId = msg.id;
  return msg;
}

async function updateAttendanceMessage(channel, scrim) {
  if (!scrim.attendanceMsgId) return;
  try {
    const msg = await channel.messages.fetch(scrim.attendanceMsgId);
    await msg.edit({
      embeds: [buildAttendanceEmbed(scrim)],
      components: [buildAttendanceRow()]
    });
  } catch (e) {
    console.log('Update error:', e.message);
  }
}

async function deleteAttendanceMessage(guild, scrim) {
  if (!scrim.attendanceMsgId) return;
  try {
    const channel = guild.channels.cache.get(scrim.channelId);
    if (!channel) return;
    const msg = await channel.messages.fetch(scrim.attendanceMsgId);
    await msg.delete();
  } catch { /* ignore */ }
}

// ─── Reminders ────────────────────────────────────────────────
function cancelScrimReminders(scrim) {
  if (scrim.reminder3minJob) { scrim.reminder3minJob.stop(); scrim.reminder3minJob = null; }
  if (scrim.reminderStartJob) { scrim.reminderStartJob.stop(); scrim.reminderStartJob = null; }
  if (scrim.dmReminderJob) { scrim.dmReminderJob.stop(); scrim.dmReminderJob = null; }
}

function scheduleScrimReminders(guild, scrim) {
  cancelScrimReminders(scrim);
  const parsed = parseHour(scrim.time);
  if (!parsed) return false;

  const { hour, minute } = parsed;

  // 3 min channel reminder
  let min3 = minute - 3, hr3 = hour;
  if (min3 < 0) { min3 += 60; hr3--; }
  scrim.reminder3minJob = cron.schedule(`${min3} ${hr3} * * *`, async () => {
    const ch = guild.channels.cache.get(scrim.channelId);
    if (ch) ch.send(`⏰ @everyone **3 minutes until scrim — ${scrim.team} at ${scrim.time}!** Get ready! 🎮`);
  });

  // 5 min DM reminder
  let min5 = minute - 5, hr5 = hour;
  if (min5 < 0) { min5 += 60; hr5--; }
  scrim.dmReminderJob = cron.schedule(`${min5} ${hr5} * * *`, async () => {
    const ch = guild.channels.cache.get(scrim.channelId);
    if (!ch) return;
    const availableUsers = Object.entries(scrim.attendance).filter(([, p]) => p.status === 'available');
    for (const [userId, player] of availableUsers) {
      try {
        const user = await client.users.fetch(userId);
        await user.send(`🔔 **Reminder:** Your scrim for **${scrim.team}** at **${scrim.time}** starts in 5 minutes! Get ready! 🎮`);
      } catch {
        console.log(`Could not DM ${player.name} — DMs likely closed`);
      }
    }
    ch.send(`📨 Sent DM reminders to **${availableUsers.length}** player(s) for **${scrim.team}** scrim.`);
  });

  // Scrim start reminder
  scrim.reminderStartJob = cron.schedule(`${minute} ${hour} * * *`, async () => {
    const ch = guild.channels.cache.get(scrim.channelId);
    if (ch) ch.send(`🎮 @everyone **${scrim.team} scrim at ${scrim.time} is starting NOW!** GL! 🔥`);
  });

  return true;
}

// ─── Bot Ready ────────────────────────────────────────────────
client.on('ready', () => {
  console.log('✅ AttendanceBot is online!');

  // Midnight reset
  cron.schedule('0 0 * * *', async () => {
    for (const [guildId, data] of guildData.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      for (const scrim of data.scrims.values()) {
        cancelScrimReminders(scrim);
        await deleteAttendanceMessage(guild, scrim);
      }
      data.scrims.clear();
      const ch = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
      if (ch) ch.send('🔄 All scrims have been reset for today. See you next scrim!');
    }
  });
});

// ─── Guild Join ───────────────────────────────────────────────
client.on('guildCreate', async (guild) => {
  const attendanceCh = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
  const defaultCh = guild.channels.cache.find(c =>
    c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has('SendMessages')
  );
  if (!attendanceCh && defaultCh) {
    defaultCh.send(`👋 Thanks for adding **AttendanceBot**!\n\n⚠️ Please create a text channel named exactly \`attendance\` (all lowercase) for me to work properly.\n\nOnce done type \`!help\` to see all commands!`);
  } else if (attendanceCh) {
    attendanceCh.send(`👋 **AttendanceBot** is ready! Type \`!help\` to get started.`);
  }
});

// ─── Interactions ─────────────────────────────────────────────

// mark_attendance button → show scrim select menu
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== 'mark_attendance') return;

  const scrimsMap = getGuildScrims(interaction.guild.id);
  if (scrimsMap.size === 0) {
    return interaction.reply({ content: '❌ No active scrims right now.', ephemeral: true });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_scrim')
    .setPlaceholder('Choose a scrim')
    .addOptions(
      Array.from(scrimsMap.values()).map(scrim => {
        const avail = getAvailable(scrim).length;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${scrim.team} @ ${scrim.time}`)
          .setDescription(`${avail}/${TEAM_SIZE} available`)
          .setValue(scrim.id);
      })
    );

  await interaction.reply({
    content: 'Select the scrim you want to respond to:',
    components: [new ActionRowBuilder().addComponents(selectMenu)],
    ephemeral: true
  });
});

// select_scrim → show available/unavailable buttons
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu() || interaction.customId !== 'select_scrim') return;

  const scrimId = interaction.values[0];
  const scrim = getGuildScrims(interaction.guild.id).get(scrimId);
  if (!scrim) {
    return interaction.update({ content: '❌ This scrim no longer exists.', components: [], ephemeral: true });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`avail_${scrimId}`).setLabel('✅ Available').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`unavail_${scrimId}`).setLabel('❌ Unavailable').setStyle(ButtonStyle.Danger)
  );

  await interaction.update({
    content: `Mark your attendance for **${scrim.team} at ${scrim.time}**:`,
    components: [row],
    ephemeral: true
  });
});

// avail_ / unavail_ buttons → record attendance
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('avail_') && !interaction.customId.startsWith('unavail_')) return;

  const isAvailable = interaction.customId.startsWith('avail_');
  const scrimId = interaction.customId.slice(interaction.customId.indexOf('_') + 1);
  const scrimsMap = getGuildScrims(interaction.guild.id);
  const scrim = scrimsMap.get(scrimId);

  if (!scrim) {
    return interaction.reply({ content: '❌ This scrim no longer exists.', ephemeral: true });
  }

  const { id: userId, username } = interaction.user;
  scrim.attendance[userId] = { name: username, status: isAvailable ? 'available' : 'unavailable' };

  await interaction.reply({
    content: `${isAvailable ? '✅' : '❌'} **${username}** marked as **${isAvailable ? 'available' : 'unavailable'}** for **${scrim.team} at ${scrim.time}**.`,
    ephemeral: true
  });

  const channel = interaction.guild.channels.cache.get(scrim.channelId);
  if (channel) {
    await updateAttendanceMessage(channel, scrim);
    if (getAvailable(scrim).length >= TEAM_SIZE) {
      channel.send(`🎮 **${scrim.team}** has all ${TEAM_SIZE} players available! Scrim at **${scrim.time}** is ON! 🔥`);
    }
  }
});

// ─── Message Commands ─────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();
  const scrimsMap = getGuildScrims(message.guild.id);

  // ── !help ──
  if (cmd === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('📋 AttendanceBot — Commands')
      .addFields(
        {
          name: '👤 Everyone',
          value: [
            '`!scrim <time> <team>` — create a scrim',
            '`!scrims` — list all active scrims',
            '`!attendance [scrimId]` — show attendance',
            '`!remind [scrimId]` — ping @everyone',
            '`!ping [scrimId]` — ping non-responders',
            '`!help` — show this message'
          ].join('\n')
        },
        {
          name: '🔒 Admin / Mod / Staff',
          value: [
            '`!scrim cancel <scrimId>` — cancel a scrim',
            '`!scrim clear <scrimId>` — clear attendance',
            '`!scrim remove <scrimId> @user` — remove player'
          ].join('\n')
        },
        {
          name: '👑 Bot Owner',
          value: '`!broadcast <message>` — send to all servers'
        },
        {
          name: '⚙️ Auto Features',
          value: [
            '• Buttons to mark attendance on each scrim embed',
            '• Announces when all 5 players are available',
            '• DMs available players 5 mins before scrim',
            '• Pings @everyone 3 mins before scrim',
            '• Pings @everyone when scrim starts',
            '• Resets all scrims at midnight'
          ].join('\n')
        },
        {
          name: '⚠️ Setup',
          value: 'Create a text channel named exactly `attendance` for the bot to work!'
        }
      )
      .setTimestamp();
    return message.reply({ embeds: [embed] });
  }

  // ── !scrim <time> <team> ──
  if (cmd === 'scrim' && args[1] && !['cancel', 'clear', 'remove'].includes(args[1].toLowerCase())) {
    const time = args[1].toUpperCase();
    const team = args.slice(2).join(' ');
    if (!team) return message.reply('Usage: `!scrim 9PM TeamName`');
    if (!time.includes('AM') && !time.includes('PM')) return message.reply('❌ Invalid time format. Use like `9PM` or `9:30PM`');

    const channel = message.guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
    if (!channel) return message.reply(`❌ No \`#${ATTENDANCE_CHANNEL}\` channel found.`);

    const scrimId = generateScrimId(time, team);
    const scrim = new Scrim(scrimId, time, team, channel.id);
    scrimsMap.set(scrimId, scrim);
    await sendAttendanceMessage(channel, scrim);
    scheduleScrimReminders(message.guild, scrim);
    return message.reply(`✅ Scrim created: **${team}** at **${time}**\n🆔 ID: \`${scrimId}\`\n📨 DM reminders will be sent 5 mins before.`);
  }

  // ── !scrims ──
  if (cmd === 'scrims') {
    if (scrimsMap.size === 0) return message.reply('No active scrims.');
    const list = Array.from(scrimsMap.values()).map(s => {
      const avail = getAvailable(s).length;
      return `• **${s.team}** at ${s.time} — ${avail}/${TEAM_SIZE} available\n  ID: \`${s.id}\``;
    }).join('\n\n');
    return message.reply(`**Active Scrims:**\n\n${list}`);
  }

  // ── !scrim cancel <scrimId> ──
  if (cmd === 'scrim' && args[1]?.toLowerCase() === 'cancel') {
    if (!isAdminOrMod(message.member)) return message.reply('❌ Admin/mod/staff only.');
    const scrimId = args[2];
    if (!scrimId) return message.reply('Usage: `!scrim cancel <scrimId>`');
    const scrim = scrimsMap.get(scrimId);
    if (!scrim) return message.reply('❌ Scrim not found.');
    cancelScrimReminders(scrim);
    await deleteAttendanceMessage(message.guild, scrim);
    scrimsMap.delete(scrimId);
    return message.reply(`❌ Scrim **${scrim.team} at ${scrim.time}** has been cancelled.`);
  }

  // ── !scrim clear <scrimId> ──
  if (cmd === 'scrim' && args[1]?.toLowerCase() === 'clear') {
    if (!isAdminOrMod(message.member)) return message.reply('❌ Admin/mod/staff only.');
    const scrimId = args[2];
    if (!scrimId) return message.reply('Usage: `!scrim clear <scrimId>`');
    const scrim = scrimsMap.get(scrimId);
    if (!scrim) return message.reply('❌ Scrim not found.');
    scrim.attendance = {};
    const channel = message.guild.channels.cache.get(scrim.channelId);
    if (channel) await updateAttendanceMessage(channel, scrim);
    return message.reply(`✅ Attendance cleared for **${scrim.team} at ${scrim.time}**.`);
  }

  // ── !scrim remove <scrimId> @user ──
  if (cmd === 'scrim' && args[1]?.toLowerCase() === 'remove') {
    if (!isAdminOrMod(message.member)) return message.reply('❌ Admin/mod/staff only.');
    const scrimId = args[2];
    const target = message.mentions.members.first();
    if (!scrimId || !target) return message.reply('Usage: `!scrim remove <scrimId> @user`');
    const scrim = scrimsMap.get(scrimId);
    if (!scrim) return message.reply('❌ Scrim not found.');
    if (!scrim.attendance[target.id]) return message.reply('❌ User not in attendance list.');
    delete scrim.attendance[target.id];
    const channel = message.guild.channels.cache.get(scrim.channelId);
    if (channel) await updateAttendanceMessage(channel, scrim);
    return message.reply(`✅ Removed **${target.user.username}** from **${scrim.team} at ${scrim.time}**.`);
  }

  // ── !attendance [scrimId] ──
  if (cmd === 'attendance') {
    const scrimId = args[1];
    if (scrimId) {
      const scrim = scrimsMap.get(scrimId);
      if (!scrim) return message.reply('❌ Scrim not found.');
      const available = getAvailable(scrim);
      const unavailable = getUnavailable(scrim);
      const embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle(`📋 ${scrim.team} @ ${scrim.time}`)
        .addFields(
          { name: `✅ Available (${available.length}/${TEAM_SIZE})`, value: available.length ? available.map(p => `• ${p.name}`).join('\n') : 'None', inline: true },
          { name: `❌ Unavailable (${unavailable.length})`, value: unavailable.length ? unavailable.map(p => `• ${p.name}`).join('\n') : 'None', inline: true }
        )
        .setTimestamp();
      return message.reply({ embeds: [embed] });
    } else {
      if (scrimsMap.size === 0) return message.reply('No active scrims.');
      const lines = Array.from(scrimsMap.values()).map(s =>
        `**${s.team}** at ${s.time}: ${getAvailable(s).length}/${TEAM_SIZE} available`
      ).join('\n');
      return message.reply(`**Attendance Summary:**\n${lines}`);
    }
  }

  // ── !remind [scrimId] ──
  if (cmd === 'remind') {
    const targets = args[1]
      ? [scrimsMap.get(args[1])].filter(Boolean)
      : Array.from(scrimsMap.values());
    if (targets.length === 0) return message.reply('No active scrims.');
    for (const scrim of targets) {
      await message.channel.send(`@everyone Please mark your attendance for **${scrim.team} at ${scrim.time}** using the buttons! (ID: \`${scrim.id}\`)`);
    }
    return;
  }

  // ── !ping [scrimId] ──
  if (cmd === 'ping') {
    const targets = args[1]
      ? [scrimsMap.get(args[1])].filter(Boolean)
      : Array.from(scrimsMap.values());
    if (targets.length === 0) return message.reply('No active scrims.');
    const members = await message.guild.members.fetch();
    for (const scrim of targets) {
      const responded = Object.keys(scrim.attendance);
      const notResponded = members.filter(m => !m.user.bot && !responded.includes(m.user.id));
      if (notResponded.size === 0) {
        await message.channel.send(`✅ Everyone has responded for **${scrim.team} at ${scrim.time}**!`);
        continue;
      }
      const mentions = notResponded.map(m => `<@${m.user.id}>`).join(' ');
      await message.channel.send(`⚠️ **${scrim.team} @ ${scrim.time}** — ${mentions} please mark your attendance!`);
    }
    return;
  }

  // ── !broadcast (owner only) ──
  if (cmd === 'broadcast') {
    if (message.author.id !== BOT_OWNER_ID) return message.reply('❌ Only the bot owner can use this.');
    const announcement = args.slice(1).join(' ');
    if (!announcement) return message.reply('Usage: `!broadcast <message>`');
    let success = 0, fail = 0;
    for (const guild of client.guilds.cache.values()) {
      const ch = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
      if (!ch) continue;
      try {
        await ch.send(`📢 **Announcement**\n${announcement}`);
        success++;
      } catch {
        fail++;
      }
    }
    return message.reply(`✅ Broadcast sent to **${success}** server(s).${fail ? ` Failed in ${f
