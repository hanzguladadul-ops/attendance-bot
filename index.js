const { Client, GatewayIntentBits, EmbedBuilder, ChannelType } = require('discord.js');
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

let scrimTime = null;
let scrimTeam = null;
let scrimGuild = null;
let attendance = {};
let scrimScheduled = false;

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

client.on('ready', () => {
  console.log('AttendanceBot is online!');

  cron.schedule('0 0 * * *', () => {
    attendance = {};
    scrimTime = null;
    scrimTeam = null;
    scrimGuild = null;
    scrimScheduled = false;
    console.log('Attendance reset for the day');

    client.guilds.cache.forEach(async guild => {
      const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
      if (channel) {
        channel.send('🔄 Attendance has been reset for today. See you at the next scrim!');
      }
    });
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

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // !help
  if (message.content === '!help') {
    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle('📋 AttendanceBot Commands')
      .addFields(
        {
          name: '👤 Everyone',
          value: '`!available` — mark yourself as available\n`!unavailable` — mark yourself as unavailable\n`!attendance` — show today\'s attendance list\n`!scrim <time> <team>` — set scrim time. Example: `!scrim 9:30PM Heiwa`\n`!remind` — ping everyone to mark attendance\n`!ping` — ping players who haven\'t responded yet\n`!help` — show this message'
        },
        {
          name: '🔒 Admin & Moderator & Staff Only',
          value: '`!clear` — clear attendance list\n`!cancel` — cancel tonight\'s scrim\n`!remove @user` — remove a player from the attendance list'
        },
        {
          name: '⚙️ Auto Features',
          value: '• Bot announces when all 5 players are available\n• Bot pings @everyone 3 mins before scrim\n• Bot pings @everyone when scrim starts\n• Attendance resets automatically at midnight'
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

  // !available
  else if (message.content === '!available') {
    attendance[message.author.id] = { name: message.author.username, status: 'available' };
    await message.reply(`✅ **${message.author.username}** is available for tonight's scrim!`);
    await checkFullAttendance(message);
  }

  // !unavailable
  else if (message.content === '!unavailable') {
    attendance[message.author.id] = { name: message.author.username, status: 'unavailable' };
    await message.reply(`❌ **${message.author.username}** is unavailable for tonight's scrim!`);
  }

  // !attendance
  else if (message.content === '!attendance') {
    const available = Object.values(attendance).filter(p => p.status === 'available');
    const unavailable = Object.values(attendance).filter(p => p.status === 'unavailable');

    const embed = new EmbedBuilder()
      .setColor('#2b2d31')
      .setTitle(`📋 Scrim Attendance${scrimTime ? ` — ${scrimTime}` : ''}`)
      .addFields(
        {
          name: '🏷️ Team',
          value: scrimTeam ? scrimTeam : 'Not set'
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

    if (scrimTime) embed.setFooter({ text: `Scrim at ${scrimTime}${scrimTeam ? ` | ${scrimTeam}` : ''}` });

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

    scrimTime = time;
    scrimTeam = team;
    scrimGuild = message.guild;
    scrimScheduled = false;

    await message.reply(`✅ Scrim set for **${time} tonight**${team ? ` for **${team}**` : ''}! Use \`!remind\` to notify players to mark attendance.`);

    scheduleReminder(message.guild, time, team);
  }

  // !cancel — admin & mod & staff only
  else if (message.content === '!cancel') {
    if (!isAdminOrMod(message.member)) {
      return message.reply('You need to be an admin, moderator or staff to use this command!');
    }
    scrimTime = null;
    scrimTeam = null;
    scrimGuild = null;
    scrimScheduled = false;
    attendance = {};
    await message.reply('❌ Tonight\'s scrim has been cancelled. Attendance has been cleared.');
    await message.channel.send('@everyone Tonight\'s scrim has been cancelled!');
  }

  // !clear — admin & mod & staff only
  else if (message.content === '!clear') {
    if (!isAdminOrMod(message.member)) {
      return message.reply('You need to be an admin, moderator or staff to use this command!');
    }
    attendance = {};
    scrimTime = null;
    scrimTeam = null;
    scrimGuild = null;
    scrimScheduled = false;
    await message.reply('✅ Attendance has been cleared!');
  }

  // !remove @user — admin & mod & staff only
  else if (message.content.startsWith('!remove')) {
    if (!isAdminOrMod(message.member)) {
      return message.reply('You need to be an admin, moderator or staff to use this command!');
    }

    const target = message.mentions.members.first();
    if (!target) return message.reply('Usage: `!remove @user` — example: `!remove @Hanz`');

    if (!attendance[target.id]) {
      return message.reply(`**${target.user.username}** is not in the attendance list!`);
    }

    delete attendance[target.id];
    await message.reply(`✅ **${target.user.username}** has been removed from the attendance list!`);
      }

  // !remind
  else if (message.content === '!remind') {
    await message.channel.send(`@everyone Please mark your attendance for tonight's scrim${scrimTime ? ` at **${scrimTime}**` : ''}${scrimTeam ? ` for **${scrimTeam}**` : ''}! Type \`!available\` or \`!unavailable\``);
  }

  // !ping
  else if (message.content === '!ping') {
    const responded = Object.keys(attendance);
    const members = await message.guild.members.fetch();
    const notResponded = members.filter(m => !m.user.bot && !responded.includes(m.user.id));

    if (notResponded.size === 0) return message.reply('Everyone has already responded!');

    const mentions = notResponded.map(m => `<@${m.user.id}>`).join(' ');
    await message.channel.send(`⚠️ ${mentions} please mark your attendance! Type \`!available\` or \`!unavailable\``);
  }
});

async function checkFullAttendance(message) {
  const available = Object.values(attendance).filter(p => p.status === 'available');
  if (available.length >= TEAM_SIZE) {
    await message.channel.send(`🎮 All ${TEAM_SIZE} players are available! **Scrim is on${scrimTime ? ` at ${scrimTime}` : ' tonight'}**${scrimTeam ? ` for **${scrimTeam}**` : ''}! Let's go! 🔥`);
  }
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

function scheduleReminder(guild, time, team) {
  try {
    const parsed = parseHour(time);
    if (!parsed || scrimScheduled) return;

    const { hour, minute } = parsed;

    let reminderMin = minute - 3;
    let reminderHour = hour;
    if (reminderMin < 0) {
      reminderMin += 60;
      reminderHour -= 1;
    }

    cron.schedule(`${reminderMin} ${reminderHour} * * *`, async () => {
      const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
      if (channel) {
        channel.send(`⏰ @everyone **3 minutes until scrim!**${team ? ` **${team}** get ready!` : ' Get ready!'} 🎮`);
      }
    });

    cron.schedule(`${minute} ${hour} * * *`, async () => {
      const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
      if (channel) {
        channel.send(`🎮 @everyone${team ? ` **${team}** scrim is starting NOW!` : ' Scrim is starting NOW!'} GL! 🔥`);
      }
    });

    scrimScheduled = true;
    console.log(`Scrim reminders scheduled for ${time}${team ? ` - ${team}` : ''}`);
  } catch (e) {
    console.log('Could not schedule reminder:', e);
  }
}

client.login(process.env.TOKEN)
