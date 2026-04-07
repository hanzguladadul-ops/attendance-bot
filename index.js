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
    member.roles.cache.some(function(r) {
      return ['moderator', 'mod', 'manager', 'staff'].includes(r.name.toLowerCase());
    })
  );
}

function generateScrimId(time, team) {
  return time + '_' + team.replace(/\s+/g, '_') + '_' + Date.now();
}

function parseHour(time) {
  try {
    var clean = time.toUpperCase().trim();
    var hour = 0;
    var minute = 0;
    if (clean.includes(':')) {
      var parts = clean.replace(/AM|PM/g, '').split(':');
      hour = parseInt(parts[0]);
      minute = parseInt(parts[1]);
    } else {
      hour = parseInt(clean.replace(/AM|PM/g, ''));
    }
    if (clean.includes('PM') && hour !== 12) hour += 12;
    if (clean.includes('AM') && hour === 12) hour = 0;
    return { hour: hour, minute: minute };
  } catch (e) {
    return null;
  }
}

function getAvailable(scrim) {
  return Object.values(scrim.attendance).filter(function(p) {
    return p.status === 'available';
  });
}

function getUnavailable(scrim) {
  return Object.values(scrim.attendance).filter(function(p) {
    return p.status === 'unavailable';
  });
}

// ─── Attendance Embed ─────────────────────────────────────────
function buildAttendanceEmbed(scrim) {
  var available = getAvailable(scrim);
  var unavailable = getUnavailable(scrim);

  return new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle('📋 Scrim Attendance — ' + scrim.time)
    .addFields(
      { name: '🏷️ Team', value: scrim.team, inline: true },
      { name: '🆔 Scrim ID', value: '`' + scrim.id + '`', inline: true },
      { name: '\u200B', value: '\u200B' },
      {
        name: '✅ Available (' + available.length + '/' + TEAM_SIZE + ')',
        value: available.length ? available.map(function(p) { return '• ' + p.name; }).join('\n') : 'None yet'
      },
      {
        name: '❌ Unavailable (' + unavailable.length + '/' + TEAM_SIZE + ')',
        value: unavailable.length ? unavailable.map(function(p) { return '• ' + p.name; }).join('\n') : 'None'
      }
    )
    .setFooter({ text: 'Scrim at ' + scrim.time + ' | ' + scrim.team })
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
  var msg = await channel.send({
    embeds: [buildAttendanceEmbed(scrim)],
    components: [buildAttendanceRow()]
  });
  scrim.attendanceMsgId = msg.id;
  return msg;
}

async function updateAttendanceMessage(channel, scrim) {
  if (!scrim.attendanceMsgId) return;
  try {
    var msg = await channel.messages.fetch(scrim.attendanceMsgId);
    await msg.edit({
      embeds: [buildAttendanceEmbed(scrim)],
      components: [buildAttendanceRow()]
    });
  } catch (e) {
    console.log('Update error: ' + e.message);
  }
}

async function deleteAttendanceMessage(guild, scrim) {
  if (!scrim.attendanceMsgId) return;
  try {
    var channel = guild.channels.cache.get(scrim.channelId);
    if (!channel) return;
    var msg = await channel.messages.fetch(scrim.attendanceMsgId);
    await msg.delete();
  } catch (e) {
    // ignore
  }
}

// ─── Reminders ────────────────────────────────────────────────
function cancelScrimReminders(scrim) {
  if (scrim.reminder3minJob) { scrim.reminder3minJob.stop(); scrim.reminder3minJob = null; }
  if (scrim.reminderStartJob) { scrim.reminderStartJob.stop(); scrim.reminderStartJob = null; }
  if (scrim.dmReminderJob) { scrim.dmReminderJob.stop(); scrim.dmReminderJob = null; }
}

function scheduleScrimReminders(guild, scrim) {
  cancelScrimReminders(scrim);
  var parsed = parseHour(scrim.time);
  if (!parsed) return false;

  var hour = parsed.hour;
  var minute = parsed.minute;

  // 3 min channel reminder
  var min3 = minute - 3;
  var hr3 = hour;
  if (min3 < 0) { min3 += 60; hr3--; }
  scrim.reminder3minJob = cron.schedule(min3 + ' ' + hr3 + ' * * *', async function() {
    var ch = guild.channels.cache.get(scrim.channelId);
    if (ch) ch.send('⏰ @everyone **3 minutes until scrim — ' + scrim.team + ' at ' + scrim.time + '!** Get ready! 🎮');
  });

  // 5 min DM reminder
  var min5 = minute - 5;
  var hr5 = hour;
  if (min5 < 0) { min5 += 60; hr5--; }
  scrim.dmReminderJob = cron.schedule(min5 + ' ' + hr5 + ' * * *', async function() {
    var ch = guild.channels.cache.get(scrim.channelId);
    if (!ch) return;
    var availableUsers = Object.entries(scrim.attendance).filter(function(entry) {
      return entry[1].status === 'available';
    });
    for (var i = 0; i < availableUsers.length; i++) {
      var userId = availableUsers[i][0];
      var player = availableUsers[i][1];
      try {
        var user = await client.users.fetch(userId);
        await user.send('🔔 **Reminder:** Your scrim for **' + scrim.team + '** at **' + scrim.time + '** starts in 5 minutes! Get ready! 🎮');
      } catch (e) {
        console.log('Could not DM ' + player.name + ' — DMs likely closed');
      }
    }
    ch.send('📨 Sent DM reminders to **' + availableUsers.length + '** player(s) for **' + scrim.team + '** scrim.');
  });

  // Scrim start reminder
  scrim.reminderStartJob = cron.schedule(minute + ' ' + hour + ' * * *', async function() {
    var ch = guild.channels.cache.get(scrim.channelId);
    if (ch) ch.send('🎮 @everyone **' + scrim.team + ' scrim at ' + scrim.time + ' is starting NOW!** GL! 🔥');
  });

  return true;
}

// ─── Bot Ready ────────────────────────────────────────────────
client.on('ready', function() {
  console.log('✅ AttendanceBot is online!');

  cron.schedule('0 0 * * *', async function() {
    for (var entry of guildData.entries()) {
      var guildId = entry[0];
      var data = entry[1];
      var guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      for (var scrim of data.scrims.values()) {
        cancelScrimReminders(scrim);
        await deleteAttendanceMessage(guild, scrim);
      }
      data.scrims.clear();
      var ch = guild.channels.cache.find(function(c) { return c.name === ATTENDANCE_CHANNEL; });
      if (ch) ch.send('🔄 All scrims have been reset for today. See you next scrim!');
    }
  });
});

// ─── Guild Join ───────────────────────────────────────────────
client.on('guildCreate', async function(guild) {
  var attendanceCh = guild.channels.cache.find(function(c) { return c.name === ATTENDANCE_CHANNEL; });
  var defaultCh = guild.channels.cache.find(function(c) {
    return c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has('SendMessages');
  });
  if (!attendanceCh && defaultCh) {
    defaultCh.send('👋 Thanks for adding **AttendanceBot**!\n\n⚠️ Please create a text channel named exactly `attendance` (all lowercase) for me to work properly.\n\nOnce done type `!help` to see all commands!');
  } else if (attendanceCh) {
    attendanceCh.send('👋 **AttendanceBot** is ready! Type `!help` to get started.');
  }
});

// ─── Interactions ─────────────────────────────────────────────

// mark_attendance button → show scrim select menu
client.on('interactionCreate', async function(interaction) {
  if (!interaction.isButton() || interaction.customId !== 'mark_attendance') return;

  var scrimsMap = getGuildScrims(interaction.guild.id);
  if (scrimsMap.size === 0) {
    return interaction.reply({ content: '❌ No active scrims right now.', ephemeral: true });
  }

  var options = Array.from(scrimsMap.values()).map(function(scrim) {
    var avail = getAvailable(scrim).length;
    return new StringSelectMenuOptionBuilder()
      .setLabel(scrim.team + ' @ ' + scrim.time)
      .setDescription(avail + '/' + TEAM_SIZE + ' available')
      .setValue(scrim.id);
  });

  var selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_scrim')
    .setPlaceholder('Choose a scrim')
    .addOptions(options);

  await interaction.reply({
    content: 'Select the scrim you want to respond to:',
    components: [new ActionRowBuilder().addComponents(selectMenu)],
    ephemeral: true
  });
});

// select_scrim → show available/unavailable buttons
client.on('interactionCreate', async function(interaction) {
  if (!interaction.isStringSelectMenu() || interaction.customId !== 'select_scrim') return;

  var scrimId = interaction.values[0];
  var scrim = getGuildScrims(interaction.guild.id).get(scrimId);
  if (!scrim) {
    return interaction.update({ content: '❌ This scrim no longer exists.', components: [], ephemeral: true });
  }

  var row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('avail_' + scrimId).setLabel('✅ Available').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('unavail_' + scrimId).setLabel('❌ Unavailable').setStyle(ButtonStyle.Danger)
  );

  await interaction.update({
    content: 'Mark your attendance for **' + scrim.team + ' at ' + scrim.time + '**:',
    components: [row],
    ephemeral: true
  });
});

// avail_ / unavail_ buttons → record attendance
client.on('interactionCreate', async function(interaction) {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('avail_') && !interaction.customId.startsWith('unavail_')) return;

  var isAvailable = interaction.customId.startsWith('avail_');
  var scrimId = interaction.customId.slice(interaction.customId.indexOf('_') + 1);
  var scrimsMap = getGuildScrims(interaction.guild.id);
  var scrim = scrimsMap.get(scrimId);

  if (!scrim) {
    return interaction.reply({ content: '❌ This scrim no longer exists.', ephemeral: true });
  }

  var userId = interaction.user.id;
  var username = interaction.user.username;
  scrim.attendance[userId] = { name: username, status: isAvailable ? 'available' : 'unavailable' };

  var status = isAvailable ? 'available' : 'unavailable';
  var emoji = isAvailable ? '✅' : '❌';

  await interaction.reply({
    content: emoji + ' **' + username + '** marked as **' + status + '** for **' + scrim.team + ' at ' + scrim.time + '**.',
    ephemeral: true
  });

  var channel = interaction.guild.channels.cache.get(scrim.channelId);
  if (channel) {
    await updateAttendanceMessage(channel, scrim);
    if (getAvailable(scrim).length >= TEAM_SIZE) {
      channel.send('🎮 **' + scrim.team + '** has all ' + TEAM_SIZE + ' players available! Scrim at **' + scrim.time + '** is ON! 🔥');
    }
  }
});

// ─── Message Commands ─────────────────────────────────────────
client.on('messageCreate', async function(message) {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content.startsWith('!')) return;

  var args = message.content.slice(1).trim().split(/\s+/);
  var cmd = args[0].toLowerCase();
  var scrimsMap = getGuildScrims(message.guild.id);

  // ── !help ──
  if (cmd === 'help') {
    var embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('📋 AttendanceBot — Commands')
      .addFields(
        {
          name: '👤 Everyone',
          value: '`!scrim <time> <team>` — create a scrim\n`!scrims` — list all active scrims\n`!attendance [scrimId]` — show attendance\n`!remind [scrimId]` — ping @everyone\n`!ping [scrimId]` — ping non-responders\n`!help` — show this message'
        },
        {
          name: '🔒 Admin / Mod / Staff',
          value: '`!scrim cancel <scrimId>` — cancel a scrim\n`!scrim clear <scrimId>` — clear attendance\n`!scrim remove <scrimId> @user` — remove player'
        },
        {
          name: '👑 Bot Owner',
          value: '`!broadcast <message>` — send to all servers'
        },
        {
          name: '⚙️ Auto Features',
          value: '• Buttons to mark attendance on each scrim embed\n• Announces when all 5 players are available\n• DMs available players 5 mins before scrim\n• Pings @everyone 3 mins before scrim\n• Pings @everyone when scrim starts\n• Resets all scrims at midnight'
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
    var time = args[1].toUpperCase();
    var team = args.slice(2).join(' ');
    if (!team) return message.reply('Usage: `!scrim 9PM TeamName`');
    if (!time.includes('AM') && !time.includes('PM')) return message.reply('❌ Invalid time format. Use like `9PM` or `9:30PM`');

    var channel = message.guild.channels.cache.find(function(c) { return c.name === ATTENDANCE_CHANNEL; });
    if (!channel) return message.reply('❌ No `#' + ATTENDANCE_CHANNEL + '` channel found.');

    var scrimId = generateScrimId(time, team);
    var scrim = new Scrim(scrimId, time, team, channel.id);
    scrimsMap.set(scrimId, scrim);
    await sendAttendanceMessage(channel, scrim);
    scheduleScrimReminders(message.guild, scrim);
    return message.reply('✅ Scrim created: **' + team + '** at **' + time + '**\n🆔 ID: `' + scrimId + '`\n📨 DM reminders will be sent 5 mins before.');
  }

  // ── !scrims ──
  if (cmd === 'scrims') {
    if (scrimsMap.size === 0) return message.reply('No active scrims.');
    var list = Array.from(scrimsMap.values()).map(function(s) {
      var avail = getAvailable(s).length;
      return '• **' + s.team + '** at ' + s.time + ' — ' + avail + '/' + TEAM_SIZE + ' available\n  ID: `' + s.id + '`';
    }).join('\n\n');
    return message.reply('**Active Scrims:**\n\n' + list);
  }

  // ── !scrim cancel <scrimId> ──
  if (cmd === 'scrim' && args[1] && args[1].toLowerCase() === 'cancel') {
    if (!isAdminOrMod(message.member)) return message.reply('❌ Admin/mod/staff only.');
    var scrimId = args[2];
    if (!scrimId) return message.reply('Usage: `!scrim cancel <scrimId>`');
    var scrim = scrimsMap.get(scrimId);
    if (!scrim) return message.reply('❌ Scrim not found.');
    cancelScrimReminders(scrim);
    await deleteAttendanceMessage(message.guild, scrim);
    scrimsMap.delete(scrimId);
    return message.reply('❌ Scrim **' + scrim.team + ' at ' + scrim.time + '** has been cancelled.');
  }

  // ── !scrim clear <scrimId> ──
  if (cmd === 'scrim' && args[1] && args[1].toLowerCase() === 'clear') {
    if (!isAdminOrMod(message.member)) return message.reply('❌ Admin/mod/staff only.');
    var scrimId = args[2];
    if (!scrimId) return message.reply('Usage: `!scrim clear <scrimId>`');
    var scrim = scrimsMap.get(scrimId);
    if (!scrim) return message.reply('❌ Scrim not found.');
    scrim.attendance = {};
    var channel = message.guild.channels.cache.get(scrim.channelId);
    if (channel) await updateAttendanceMessage(channel, scrim);
    return message.reply('✅ Attendance cleared for **' + scrim.team + ' at ' + scrim.time + '**.');
  }

  // ── !scrim remove <scrimId> @user ──
  if (cmd === 'scrim' && args[1] && args[1].toLowerCase() === 'remove') {
    if (!isAdminOrMod(message.member)) return message.reply('❌ Admin/mod/staff only.');
    var scrimId = args[2];
    var target = message.mentions.members.first();
    if (!scrimId || !target) return message.reply('Usage: `!scrim remove <scrimId> @user`');
    var scrim = scrimsMap.get(scrimId);
    if (!scrim) return message.reply('❌ Scrim not found.');
    if (!scrim.attendance[target.id]) return message.reply('❌ User not in attendance list.');
    delete scrim.attendance[target.id];
    var channel = message.guild.channels.cache.get(scrim.channelId);
    if (channel) await updateAttendanceMessage(channel, scrim);
    return message.reply('✅ Removed **' + target.user.username + '** from **' + scrim.team + ' at ' + scrim.time + '**.');
  }

  // ── !attendance [scrimId] ──
  if (cmd === 'attendance') {
    var scrimId = args[1];
    if (scrimId) {
      var scrim = scrimsMap.get(scrimId);
      if (!scrim) return message.reply('❌ Scrim not found.');
      var available = getAvailable(scrim);
      var unavailable = getUnavailable(scrim);
      var embed = new EmbedBuilder()
        .setColor('#2b2d31')
        .setTitle('📋 ' + scrim.team + ' @ ' + scrim.time)
        .addFields(
          { name: '✅ Available (' + available.length + '/' + TEAM_SIZE + ')', value: available.length ? available.map(function(p) { return '• ' + p.name; }).join('\n') : 'None', inline: true },
          { name: '❌ Unavailable (' + unavailable.length + ')', value: unavailable.length ? unavailable.map(function(p) { return '• ' + p.name; }).join('\n') : 'None', inline: true }
        )
        .setTimestamp();
      return message.reply({ embeds: [embed] });
    } else {
      if (scrimsMap.size === 0) return message.reply('No active scrims.');
      var lines = Array.from(scrimsMap.values()).map(function(s) {
        return '**' + s.team + '** at ' + s.time + ': ' + getAvailable(s).length + '/' + TEAM_SIZE + ' available';
      }).join('\n');
      return message.reply('**Attendance Summary:**\n' + lines);
    }
  }

  // ── !remind [scrimId] ──
  if (cmd === 'remind') {
    var targets = args[1]
      ? [scrimsMap.get(args[1])].filter(Boolean)
      : Array.from(scrimsMap.values());
    if (targets.length === 0) return message.reply('No active scrims.');
    for (var i = 0; i < targets.length; i++) {
      var scrim = targets[i];
      await message.channel.send('@everyone Please mark your attendance for **' + scrim.team + ' at ' + scrim.time + '** using the buttons! (ID: `' + scrim.id + '`)');
    }
    return;
  }

  // ── !ping [scrimId] ──
  if (cmd === 'ping') {
    var targets = args[1]
      ? [scrimsMap.get(args[1])].filter(Boolean)
      : Array.from(scrimsMap.values());
    if (targets.length === 0) return message.reply('No active scrims.');
    var members = await message.guild.members.fetch();
    for (var i = 0; i < targets.length; i++) {
      var scrim = targets[i];
      var responded = Object.keys(scrim.attendance);
      var notResponded = members.filter(function(m) {
        return !m.user.bot && !responded.includes(m.user.id);
      });
      if (notResponded.size === 0) {
        await message.channel.send('✅ Everyone has responded for **' + scrim.team + ' at ' + scrim.time + '**!');
        continue;
      }
      var mentions = notResponded.map(function(m) { return '<@' + m.user.id + '>'; }).join(' ');
      await message.channel.send('⚠️ **' + scrim.team + ' @ ' + scrim.time + '** — ' + mentions + ' please mark your attendance!');
    }
    return;
  }

  // ── !broadcast (owner only) ──
  if (cmd === 'broadcast') {
    if (message.author.id !== BOT_OWNER_ID) return message.reply('❌ Only the bot owner can use this.');
    var announcement = args.slice(1).join(' ');
    if (!announcement) return message.reply('Usage: `!broadcast <message>`');
    var success = 0;
    var fail = 0;
    for (var guild of client.guilds.cache.values()) {
      var ch = guild.channels.cache.find(function(c) { return c.name === ATTENDANCE_CHANNEL; });
      if (!ch) continue;
      try {
        await ch.send('📢 **Announcement**\n' + announcement);
        success++;
      } catch (e) {
        fail++;
      }
    }
    var failMsg = fail > 0 ? ' Failed in ' + fail + '.' : '';
    return message.reply('✅ Broadcast sent to **' + success + '** server(s).' + failMsg);
  }
});

// ─── Login ────────────────────────────────────────────────────
client.login(process.env.TOKEN)
