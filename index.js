const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
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
let attendance = {};
let scrimScheduled = false;

client.on('ready', () => {
  console.log('AttendanceBot is online!');

  cron.schedule('0 0 * * *', () => {
    attendance = {};
    scrimTime = null;
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
          value: '`!available` — mark yourself as available\n`!unavailable` — mark yourself as unavailable\n`!attendance` — show today\'s attendance list\n`!help` — show this message'
        },
        {
          name: '🔒 Admin Only',
          value: '`!scrim <time>` — set scrim time. Example: `!scrim 8PM`\n`!cancel` — cancel tonight\'s scrim\n`!clear` — clear attendance list\n`!remind` — ping everyone to mark attendance\n`!ping` — ping players who haven\'t responded yet'
        },
        {
          name: '⚙️ Auto Features',
          value: '• Bot announces when all 5 players are available\n• Bot pings @everyone 3 mins before scrim\n• Bot pings @everyone when scrim starts\n• Attendance resets automatically at midnight'
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
          name: `✅ Available (${available.length}/${TEAM_SIZE})`,
          value: available.length > 0 ? available.map(p => `• ${p.name}`).join('\n') : 'None yet'
        },
        {
          name: `❌ Unavailable (${unavailable.length}/${TEAM_SIZE})`,
          value: unavailable.length > 0 ? unavailable.map(p => `• ${p.name}`).join('\n') : 'None'
        }
      )
      .setTimestamp();

    if (scrimTime) embed.setFooter({ text: `Scrim at ${scrimTime}` });

    await message.reply({ embeds: [embed] });
  }

  // !scrim <time> — admin only
  else if (message.content.startsWith('!scrim')) {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('You need to be an admin to use this command!');
    }

    const time = message.content.slice(7).trim().toUpperCase();
    if (!time) return message.reply('Usage: `!scrim <time>` — example: `!scrim 8PM`');

    if (!time.includes('AM') && !time.includes('PM')) {
      return message.reply('❌ Invalid time format! Use AM/PM like `!scrim 8PM` or `!scrim 9:30PM`');
    }

    scrimTime = time;
    scrimScheduled = false;
    await message.reply(`✅ Scrim set for **${time} tonight!** Use \`!remind\` to notify players to mark attendance.`);

    scheduleReminder(message, time);
  }

  // !cancel — admin only
  else if (message.content === '!cancel') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('You need to be an admin to use this command!');
    }
    scrimTime = null;
    scrimScheduled = false;
    attendance = {};
    await message.reply('❌ Tonight\'s scrim has been cancelled. Attendance has been cleared.');
    await message.channel.send('@everyone Tonight\'s scrim has been cancelled!');
  }

  // !clear — admin only
  else if (message.content === '!clear') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('You need to be an admin to use this command!');
    }
    attendance = {};
    scrimTime = null;
    scrimScheduled = false;
    await message.reply('✅ Attendance has been cleared!');
  }

  // !remind — admin only
  else if (message.content === '!remind') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('You need to be an admin to use this command!');
    }
    await message.channel.send(`@everyone Please mark your attendance for tonight's scrim${scrimTime ? ` at **${scrimTime}**` : ''}! Type \`!available\` or \`!unavailable\``);
  }

  // !ping — admin only
  else if (message.content === '!ping') {
    if (!message.member.permissions.has('Administrator')) {
      return message.reply('You need to be an admin to use this command!');
    }

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
    await message.channel.send(`🎮 All ${TEAM_SIZE} players are available! **Scrim is on${scrimTime ? ` at ${scrimTime}` : ' tonight'}!** Let's go! 🔥`);
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

function scheduleReminder(message, time) {
  try {
    const parsed = parseHour(time);
    if (!parsed || scrimScheduled) return;

    const { hour, minute } = parsed;

    // 3 minutes before
    let reminderMin = minute - 3;
    let reminderHour = hour;
    if (reminderMin < 0) {
      reminderMin += 60;
      reminderHour -= 1;
    }

    // ping 3 mins before
    cron.schedule(`${reminderMin} ${reminderHour} * * *`, async () => {
      client.guilds.cache.forEach(async guild => {
        const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
        if (channel) {
          channel.send(`⏰ @everyone **3 minutes until scrim at ${time}!** Get ready! 🎮`);
        }
      });
    });

    // ping at scrim time
    cron.schedule(`${minute} ${hour} * * *`, async () => {
      client.guilds.cache.forEach(async guild => {
        const channel = guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
        if (channel) {
          channel.send(`🎮 @everyone **Scrim is starting NOW!** GL HF! 🔥`);
        }
      });
    });

    scrimScheduled = true;
    console.log(`Scrim reminders scheduled for ${time}`);
  } catch (e) {
    console.log('Could not schedule reminder:', e);
  }
}

client.login(process.env.TOKEN);
