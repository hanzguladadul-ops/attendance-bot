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

  // auto reset at midnight
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

  // !available
  if (message.content === '!available') {
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
    const time = message.content.slice(7).trim();
    if (!time) return message.reply('Usage: `!scrim <time>` — example: `!scrim 8PM`');

    scrimTime = time;
    await message.reply(`✅ Scrim set for **${time} tonight!** Players please mark your attendance!`);
    await message.channel.send('@everyone Please mark your attendance for tonight\'s scrim!');

    // schedule reminder 30 mins before if time is parseable
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
    await message.channel.send(`@everyone Don't forget to mark your attendance for tonight's scrim${scrimTime ? ` at **${scrimTime}**` : ''}! Type \`!available\` or \`!unavailable\``);
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

function scheduleReminder(message, time) {
  try {
    const cleanTime = time.toUpperCase().replace(' ', '');
    let hour = null;

    if (cleanTime.includes('PM')) {
      hour = parseInt(cleanTime.replace('PM', '').trim());
      if (hour !== 12) hour += 12;
    } else if (cleanTime.includes('AM')) {
      hour = parseInt(cleanTime.replace('AM', '').trim());
      if (hour === 12) hour = 0;
    }

    if (hour !== null && !scrimScheduled) {
      const reminderHour = hour === 0 ? 23 : hour - 1;
      const reminderMin = hour === 0 ? 30 : 30;

      cron.schedule(`${reminderMin} ${reminderHour} * * *`, async () => {
        const channel = message.guild.channels.cache.find(c => c.name === ATTENDANCE_CHANNEL);
        if (channel) {
          channel.send(`⏰ **30 minutes until scrim at ${time}!** Make sure you're ready!`);
        }
      });

      scrimScheduled = true;
    }
  } catch (e) {
    console.log('Could not schedule reminder');
  }
}

client.login(process.env.TOKEN);
