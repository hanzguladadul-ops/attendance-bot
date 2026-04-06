const { Client, GatewayIntentBits, EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const cron = require('node-cron');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const TEAM_SIZE = 5;
const ATTENDANCE_CHANNEL = 'attendance';
const BOT_OWNER_ID = '1292033694869225473';

// Per‑guild data: scrims stored by unique ID (e.g., "9PM_TeamA_1734567890")
// Also store the last button message ID for cleanup
const guildData = new Map(); // guildId -> { scrims: Map<scrimId, ScrimObject>, lastButtonMsgId: string|null }

class Scrim {
  constructor(id, time, team, channelId, reminder3minJob, reminderStartJob, attendanceMsgId) {
    this.id = id;                // unique string
    this.time = time;            // e.g., "9PM"
    this.team = team;            // e.g., "TeamA"
    this.channelId = channelId;  // where attendance message lives
    this.reminder3minJob = reminder3minJob;   // cron job
    this.reminderStartJob = reminderStartJob; // cron job
    this.attendanceMsgId = attendanceMsgId;   // message ID of the embed
    this.attendance = {};        // userId -> { name, status }
  }
}

function getGuildScrims(guildId) {
  if (!guildData.has(guildId)) {
    guildData.set(guildId, { scrims: new Map(), lastButtonMsgId: null });
  }
  return guildData.get(guildId).scrims;
}

function setLastButtonMessage(guildId, msgId) {
  if (!guildData.has(guildId)) {
    guildData.set(guildId, { scrims: new Map(), lastButtonMsgId: null });
  }
  guildData.get(guildId).lastButtonMsgId = msgId;
}

function getLastButtonMessage(guildId) {
  return guildData.get(guildId)?.lastButtonMsgId || null;
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

  // Buttons that will trigger a select menu
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
}

function scheduleScrimReminders(guild, scrim) {
  cancelScrimReminders(scrim); // ensure no double
  const parsed = parseHour(scrim.time);
  if (!parsed) return false;
  const { hour, minute } = parsed;
  let reminderMin = minute - 3;
  let reminderHour = hour;
  if (reminderMin < 0) { reminderMin += 60; reminderHour -= 1; }

  scrim.reminder3minJob = cron.schedule(`${reminderMin} ${reminderHour} * * *`, async () => {
    const channel = guild.channels.cache.get(scrim.channelId);
    if (channel) channel.send(`⏰ @everyone **3 minutes until scrim (${scrim.team} at ${scrim.time})!** Get ready! 🎮`);
  });

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

// ---------- Discord events ----------
client.on('ready', () => {
  console.log('Multi‑Scrim AttendanceBot online!');

  // Daily reset: clear all scrims for all guilds at midnight
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
  const msg = !channel ? (defaultChannel ? `⚠️ Please create a text channel named \`${ATTENDANCE_CHANNEL}\`.` : '') : `👋 AttendanceBot is ready! Type \`!help\`.`;
  if (msg && defaultChannel) defaultChannel.send(msg);
  else if (msg && channel) channel.send(msg);
});

// Button interaction -> show select menu of active scrims
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  if (interaction.customId !== 'mark_attendance') return;

  const guildId = interaction.guild.id;
  const scrimsMap = getGuildScrims(guildId);
  if (scrimsMap.size === 0) {
    return interaction.reply({ content: '❌ No active scrims. Use `!scrim` to create one.', ephemeral: true });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_scrim')
    .setPlaceholder('Choose which scrim you are responding to')
    .addOptions(
      Array.from(scrimsMap.values()).map(scrim => {
        const availableCount = Object.values(scrim.attendance).filter(p => p.status === 'available').length;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${scrim.team} @ ${scrim.time}`)
          .setDescription(`${availableCount}/${TEAM_SIZE} available`)
          .setValue(scrim.id);
      })
    );

  const row = new ActionRowBuilder().addComponents(selectMenu);
  await interaction.reply({ content: 'Select a scrim:', components: [row], ephemeral: true });
});

// Handle select menu choice -> then ask available/unavailable
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== 'select_scrim') return;

  const scrimId = interaction.values[0];
  const guildId = interaction.guild.id;
  const scrimsMap = getGuildScrims(guildId);
  const scrim = scrimsMap.get(scrimId);
  if (!scrim) {
    return interaction.update({ content: '❌ This scrim no longer exists.', components: [], ephemeral: true });
  }

  // Now ask available/unavailable via buttons
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId(`avail_${scrimId}`).setLabel('✅ Available').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`unavail_${scrimId}`).setLabel('❌ Unavailable').setStyle(ButtonStyle.Danger)
    );
  await interaction.update({ content: `Mark attendance for **${scrim.team} at ${scrim.time}**:`, components: [row], ephemeral: true });
});

// Handle the available/unavailable buttons (with scrim ID)
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

// ---------- Command handling ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const guildId = message.guild.id;
  const scrimsMap = getGuildScrims(guildId);
  const prefix = '!';

  if (!message.content.startsWith(prefix)) return;
  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // !help
  if (cmd === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('📋 Multi‑Scrim Attendance Bot Commands')
      .addFields(
        { name: '👤 Everyone', value: '`!scrim <time> <team>` – create a scrim\n`!scrims` – list all active scrims\n`!attendance [scrimId]` – show attendance for a scrim (or all)\n`!remind [scrimId]` – ping @everyone for a scrim\n`!ping [scrimId]` – ping non‑responders\n`!help` – this message' },
        { name: '🔒 Admin/Mod/Staff', value: '`!scrim cancel <scrimId>` – cancel a scrim\n`!scrim clear <scrimId>` – clear its attendance\n`!scrim remove <scrimId> @user` – remove a player' },
        { name: '👑 Bot Owner', value: '`!broadcast <msg>` – send to all servers' }
      );
    return message.reply({ embeds: [embed] });
  }

  // !scrim <time> <team>
  if (cmd === 'scrim') {
    if (args.length < 3) return message.reply('Usage: `!scrim 9PM TeamName`');
    const time = args[1].toUpperCase();
    const team = args.slice(2).join(' ');
    if (!time.includes('AM') && !time.includes('PM')) return message.reply('Invalid time format. Use e.g., `9PM` or `9:30PM`');

    const channel = message.guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
    if (!channel) return message.reply(`❌ Could not find a #${ATTENDANCE_CHANNEL} channel.`);

    const scrimId = generateScrimId(time, team);
    const newScrim = new Scrim(scrimId, time, team, channel.id, null, null, null);
    scrimsMap.set(scrimId, newScrim);
    await sendAttendanceMessage(channel, newScrim);
    scheduleScrimReminders(message.guild, newScrim);
    await message.reply(`✅ Scrim created: **${team}** at **${time}** (ID: \`${scrimId}\`)`);
    return;
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
    if (!scrim.attendance[target.id]) return message.reply('User not in attendance.');
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
      let reply = '';
      for (const scrim of scrimsMap.values()) {
        const avail = Object.values(scrim.attendance).filter(p => p.status === 'available').length;
        reply += `**${scrim.team}** at ${scrim.time}: ${avail}/${TEAM_SIZE} available\n`;
      }
      return message.reply(reply);
    }
  }

  // !remind [scrimId]
  if (cmd === 'remind') {
    let scrimsToRemind = [];
    if (args[1]) {
      const scrim = scrimsMap.get(args[1]);
      if (!scrim) return message.reply('Scrim not found.');
      scrimsToRemind = [scrim];
    } else {
      scrimsToRemind = Array.from(scrimsMap.values());
    }
    if (scrimsToRemind.length === 0) return message.reply('No active scrims.');
    for (const scrim of scrimsToRemind) {
      await message.channel.send(`@everyone Please mark attendance for **${scrim.team} at ${scrim.time}** (ID: \`${scrim.id}\`) using the buttons!`);
    }
    return;
  }

  // !ping [scrimId]
  if (cmd === 'ping') {
    let scrimsToPing = [];
    if (args[1]) {
      const scrim = scrimsMap.get(args[1]);
      if (!scrim) return message.reply('Scrim not found.');
      scrimsToPing = [scrim];
    } else {
      scrimsToPing = Array.from(scrimsMap.values());
    }
    if (scrimsToPing.length === 0) return message.reply('No active scrims.');
    const members = await message.guild.members.fetch();
    for (const scrim of scrimsToPing) {
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
    if (message.author.id !== BOT_OWNER_ID) return message.reply('Only bot owner.');
    const announcement = message.content.slice(11).trim();
    if (!announcement) return message.reply('Usage: `!broadcast <msg>`');
    let success = 0, fail = 0;
    for (const guild of client.guilds.cache.values()) {
      const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
      if (channel) {
        try { await channel.send(`📢 **Announcement**\n${announcement}`); success++; }
        catch { fail++; }
      }
    }
    return message.reply(`✅ Sent to ${success} servers. Failed: ${fail}`);
  }
});

client.login(process.env.TOKEN);
