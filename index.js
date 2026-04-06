const { Client, GatewayIntentBits, EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

// Per‑guild data store
const guildData = new Map(); // key: guildId, value: { scrimTime, scrimTeam, attendance, attendanceMessageId, reminder3minJob, reminderStartJob }

function getGuildData(guildId) {
  if (!guildData.has(guildId)) {
    guildData.set(guildId, {
      scrimTime: null,
      scrimTeam: null,
      attendance: {},
      attendanceMessageId: null,
      reminder3minJob: null,
      reminderStartJob: null
    });
  }
  return guildData.get(guildId);
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

async function sendAttendanceButtons(channel, data) {
  const available = Object.values(data.attendance).filter(p => p.status === 'available');
  const unavailable = Object.values(data.attendance).filter(p => p.status === 'unavailable');

  const embed = new EmbedBuilder()
    .setColor('#2b2d31')
    .setTitle(`📋 Scrim Attendance${data.scrimTime ? ` — ${data.scrimTime}` : ''}`)
    .addFields(
      {
        name: '🏷️ Team',
        value: data.scrimTeam ? data.scrimTeam : 'Not set'
      },
      {
        name: `✅ Available (${available.length}/${TEAM_SIZE})`,
        value: available.length > 0 ? available.map(p => `• ${p.name}`).join('\n') : 'None yet'
      },
      {
        name: `❌ Unavailable (${unavailable.length}/${TEAM_SIZE})`,
        value: unavailable.length > 0 ? unavailable.map(p => `• ${p.name}`).join('\n') : 'None'
      }
    )
    .setFooter({ text: `Scrim at ${data.scrimTime}${data.scrimTeam ? ` | ${data.scrimTeam}` : ''}` })
    .setTimestamp();

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('available')
        .setLabel('✅ Available')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('unavailable')
        .setLabel('❌ Unavailable')
        .setStyle(ButtonStyle.Danger)
    );

  return await channel.send({ embeds: [embed], components: [row] });
}

async function updateAttendanceMessage(channel, data) {
  if (!data.attendanceMessageId) return;

  try {
    const msg = await channel.messages.fetch(data.attendanceMessageId);
    const available = Object.values(data.attendance).filter(p => p.status === 'available');
    const unavailable = Object.values(data.attendance).filter(p => p.status === 'unavailable');

    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle(`📋 Scrim Attendance${data.scrimTime ? ` — ${data.scrimTime}` : ''}`)
      .addFields(
        {
          name: '🏷️ Team',
          value: data.scrimTeam ? data.scrimTeam : 'Not set'
        },
        {
          name: `✅ Available (${available.length}/${TEAM_SIZE})`,
          value: available.length > 0 ? available.map(p => `• ${p.name}`).join('\n') : 'None yet'
        },
        {
          name: `❌ Unavailable (${unavailable.length}/${TEAM_SIZE})`,
          value: unavailable.length > 0 ? unavailable.map(p => `• ${p.name}`).join('\n') : 'None'
        }
      )
      .setFooter({ text: `Scrim at ${data.scrimTime}${data.scrimTeam ? ` | ${data.scrimTeam}` : ''}` })
      .setTimestamp();

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('available')
          .setLabel('✅ Available')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('unavailable')
          .setLabel('❌ Unavailable')
          .setStyle(ButtonStyle.Danger)
      );

    await msg.edit({ embeds: [embed], components: [row] });
  } catch (e) {
    console.log('Could not update attendance message:', e);
  }
}

function cancelReminders(guildId) {
  const data = getGuildData(guildId);
  if (data.reminder3minJob) {
    data.reminder3minJob.stop();
    data.reminder3minJob = null;
  }
  if (data.reminderStartJob) {
    data.reminderStartJob.stop();
    data.reminderStartJob = null;
  }
}

function scheduleReminders(guild, time, team) {
  const guildId = guild.id;
  const data = getGuildData(guildId);

  // Cancel any existing reminders first
  cancelReminders(guildId);

  const parsed = parseHour(time);
  if (!parsed) return false;

  const { hour, minute } = parsed;

  let reminderMin = minute - 3;
  let reminderHour = hour;
  if (reminderMin < 0) {
    reminderMin += 60;
    reminderHour -= 1;
  }

  // Schedule the 3‑minute reminder
  data.reminder3minJob = cron.schedule(`${reminderMin} ${reminderHour} * * *`, async () => {
    const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
    if (channel) {
      channel.send(`⏰ @everyone **3 minutes until scrim!**${team ? ` **${team}** get ready!` : ' Get ready!'} 🎮`);
    }
  });

  // Schedule the “scrim starting now” reminder
  data.reminderStartJob = cron.schedule(`${minute} ${hour} * * *`, async () => {
    const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
    if (channel) {
      channel.send(`🎮 @everyone${team ? ` **${team}** scrim is starting NOW!` : ' Scrim is starting NOW!'} GL! 🔥`);
    }
  });

  return true;
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

client.on('ready', () => {
  console.log('AttendanceBot is online!');

  // Daily reset at midnight
  cron.schedule('0 0 * * *', () => {
    for (const [guildId, data] of guildData.entries()) {
      // Cancel any pending reminders for this guild
      cancelReminders(guildId);
      // Reset data
      data.scrimTime = null;
      data.scrimTeam = null;
      data.attendance = {};
      data.attendanceMessageId = null;
      // Optionally notify the attendance channel
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
        if (channel) {
          channel.send('🔄 Attendance has been reset for today. See you at the next scrim!');
        }
      }
    }
    console.log('Attendance reset for all guilds');
  });
});

client.on('guildCreate', async (guild) => {
  const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
  const defaultChannel = guild.channels.cache.find(c =>
    c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has('SendMessages')
  );

  if (!channel) {
    if (defaultChannel) {
      defaultChannel.send(
        `👋 Hey! Thanks for adding **AttendanceBot**!\n\n` +
        `⚠️ To get started please create a text channel called exactly \`attendance\` (all lowercase).\n` +
        `That's where all scrim attendance updates and reminders will be posted.\n\n` +
        `Once that's done type \`!help\` in any channel to see all available commands!`
      );
    }
  } else {
    channel.send(
      `👋 Hey! **AttendanceBot** is now online and ready to go!\n` +
      `Type \`!help\` to see all available commands!`
    );
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const userId = interaction.user.id;
  const username = interaction.user.username;
  const guildId = interaction.guild.id;
  const data = getGuildData(guildId);

  if (interaction.customId === 'available') {
    data.attendance[userId] = { name: username, status: 'available' };
    await interaction.reply({ content: `✅ **${username}** is available for tonight's scrim!`, ephemeral: true });

    const channel = interaction.guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
    if (channel) {
      await updateAttendanceMessage(channel, data);
      const available = Object.values(data.attendance).filter(p => p.status === 'available');
      if (available.length >= TEAM_SIZE) {
        channel.send(`🎮 All ${TEAM_SIZE} players are available! **Scrim is on${data.scrimTime ? ` at ${data.scrimTime}` : ' tonight'}**${data.scrimTeam ? ` for **${data.scrimTeam}**` : ''}! Let's go! 🔥`);
      }
    }
  }
  else if (interaction.customId === 'unavailable') {
    data.attendance[userId] = { name: username, status: 'unavailable' };
    await interaction.reply({ content: `❌ **${username}** is unavailable for tonight's scrim!`, ephemeral: true });

    const channel = interaction.guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
    if (channel) await updateAttendanceMessage(channel, data);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const guildId = message.guild.id;
  let data = getGuildData(guildId);

  // !help
  if (message.content === '!help') {
    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('📋 AttendanceBot Commands')
      .addFields(
        {
          name: '👤 Everyone',
          value: '`!attendance` — show today\'s attendance list\n`!scrim <time> <team>` — set scrim time. Example: `!scrim 9:30PM Heiwa`\n`!remind` — ping everyone to mark attendance\n`!ping` — ping players who haven\'t responded yet\n`!help` — show this message'
        },
        {
          name: '🔒 Admin & Moderator & Staff Only',
          value: '`!clear` — clear attendance list\n`!cancel` — cancel tonight\'s scrim\n`!remove @user` — remove a player from the attendance list'
        },
        {
          name: '👑 Bot Owner Only',
          value: '`!broadcast <message>` — send a message to all servers the bot is in'
        },
        {
          name: '⚙️ Auto Features',
          value: '• Players mark attendance via buttons when scrim is set\n• Bot announces when all 5 players are available\n• Bot pings @everyone 3 mins before scrim\n• Bot pings @everyone when scrim starts\n• Attendance resets automatically at midnight'
        },
        {
          name: '⚠️ Setup Required',
          value: 'Make sure your server has a text channel named exactly `attendance` for the bot to work properly!'
        }
      )
      .setFooter({ text: 'AttendanceBot' })
      .setTimestamp();

    await message.reply({ embeds: [embed] });
  }

  // !attendance
  else if (message.content === '!attendance') {
    const available = Object.values(data.attendance).filter(p => p.status === 'available');
    const unavailable = Object.values(data.attendance).filter(p => p.status === 'unavailable');

    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle(`📋 Scrim Attendance${data.scrimTime ? ` — ${data.scrimTime}` : ''}`)
      .addFields(
        {
          name: '🏷️ Team',
          value: data.scrimTeam ? data.scrimTeam : 'Not set'
        },
        {
          name: `✅ Available (${available.length}/${TEAM_SIZE})`,
          value: available.length > 0 ? available.map(p => `• ${p.name}`).join('\n') : 'None yet'
        },
        {
          name: `❌ Unavailable (${unavailable.length}/${TEAM_SIZE})`,
          value: unavailable.length > 0 ? unavailable.map(p => `• ${p.name}`).join('\n') : 'None'
        }
      )
      .setTimestamp();

    if (data.scrimTime) embed.setFooter({ text: `Scrim at ${data.scrimTime}${data.scrimTeam ? ` | ${data.scrimTeam}` : ''}` });

    await message.reply({ embeds: [embed] });
  }

  // !scrim <time> <team>
  else if (message.content.startsWith('!scrim')) {
    const args = message.content.slice(7).trim().split(' ');
    const time = args[0] ? args[0].toUpperCase() : null;
    const team = args.slice(1).join(' ') || null;

    if (!time) return message.reply('Usage: `!scrim <time> <team>` — example: `!scrim 9:30PM Heiwa`');

    if (!time.includes('AM') && !time.includes('PM')) {
      return message.reply('❌ Invalid time format! Use AM/PM like `!scrim 8PM Heiwa` or `!scrim 9:30PM Lumiere`');
    }

    // Cancel any previous reminders and reset data for this guild
    cancelReminders(guildId);
    data.scrimTime = time;
    data.scrimTeam = team;
    data.attendance = {};
    data.attendanceMessageId = null;

    await message.reply(`✅ Scrim set for **${time} tonight**${team ? ` for **${team}**` : ''}!`);

    const channel = message.guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
    if (channel) {
      const msg = await sendAttendanceButtons(channel, data);
      data.attendanceMessageId = msg.id;
    }

    scheduleReminders(message.guild, time, team);
  }

  // !cancel — admin & mod & staff only
  else if (message.content === '!cancel') {
    if (!isAdminOrMod(message.member)) {
      return message.reply('You need to be an admin, moderator or staff to use this command!');
    }
    // Cancel reminders and reset data
    cancelReminders(guildId);
    data.scrimTime = null;
    data.scrimTeam = null;
    data.attendance = {};
    data.attendanceMessageId = null;

    await message.reply('❌ Tonight\'s scrim has been cancelled. Attendance has been cleared.');
    await message.channel.send('@everyone Tonight\'s scrim has been cancelled!');
  }

  // !clear — admin & mod & staff only
  else if (message.content === '!clear') {
    if (!isAdminOrMod(message.member)) {
      return message.reply('You need to be an admin, moderator or staff to use this command!');
    }
    cancelReminders(guildId);
    data.scrimTime = null;
    data.scrimTeam = null;
    data.attendance = {};
    data.attendanceMessageId = null;

    await message.reply('✅ Attendance has been cleared!');
  }

  // !remove @user — admin & mod & staff only
  else if (message.content.startsWith('!remove')) {
    if (!isAdminOrMod(message.member)) {
      return message.reply('You need to be an admin, moderator or staff to use this command!');
    }

    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!remove @user` — example: `!remove @Hanz`');

    if (!data.attendance[target.id]) {
      return message.reply(`**${target.user.username}** is not in the attendance list!`);
    }

    delete data.attendance[target.id];
    await message.reply(`✅ **${target.user.username}** has been removed from the attendance list!`);

    const channel = message.guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
    if (channel) await updateAttendanceMessage(channel, data);
  }

  // !remind
  else if (message.content === '!remind') {
    await message.channel.send(`@everyone Please mark your attendance for tonight's scrim${data.scrimTime ? ` at **${data.scrimTime}**` : ''}${data.scrimTeam ? ` for **${data.scrimTeam}**` : ''}! Check the attendance message above and tap a button!`);
  }

  // !ping
  else if (message.content === '!ping') {
    const responded = Object.keys(data.attendance);
    const members = await message.guild.members.fetch();
    const notResponded = members.filter(m => !m.user.bot && !responded.includes(m.user.id));

    if (notResponded.size === 0) return message.reply('Everyone has already responded!');

    const mentions = notResponded.map(m => `<@${m.user.id}>`).join(' ');
    await message.channel.send(`⚠️ ${mentions} please mark your attendance! Tap the buttons in the attendance message!`);
  }

  // !broadcast — bot owner only
  else if (message.content.startsWith('!broadcast')) {
    if (message.author.id !== BOT_OWNER_ID) {
      return message.reply('Only the bot owner can use this command!');
    }

    const announcement = message.content.slice(11).trim();
    if (!announcement) return message.reply('Usage: `!broadcast <message>` — example: `!broadcast Scrims moving to 9PM!`');

    let successCount = 0;
    let failCount = 0;

    for (const guild of client.guilds.cache.values()) {
      const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
      if (channel) {
        try {
          await channel.send(`📢 **Announcement**\n${announcement}`);
          successCount++;
        } catch (e) {
          failCount++;
        }
      }
    }

    await message.reply(`✅ Broadcast sent to **${successCount}** servers!${failCount > 0 ? ` Failed in ${failCount} servers.` : ''}`);
  }
});

client.login(process.env.TOKEN);
