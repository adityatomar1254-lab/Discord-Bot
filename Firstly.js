// bot.js
// Single-file Discord bot with many commands, unique interactive features, and runtime command registration.
// Requirements:
// - Node.js 22+
// - npm i discord.js
// - Environment: DISCORD_TOKEN, DISCORD_CLIENT_ID, optional DISCORD_GUILD_ID for fast guild-scoped registration
// Load environment variables from .env when present
require('dotenv').config();

const {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  InteractionType,
  ModalBuilder,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID || null;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID env.');
  process.exit(1);
}

// In-memory stores (resets on restart)
const store = {
  quotes: new Map(), // guildId -> [strings]
  karma: new Map(),  // guildId -> Map(userId -> number)
  todos: new Map(),  // userId -> [{text, done}]
  polls: new Map(),  // id -> {question, options: [{label, count}], voters: Map(userId -> index), messageId, channelId}
  ttt: new Map(),    // gameId -> {players: [P1,P2], turn: 0/1, board: Array(9).fill(null), messageId, channelId}
  giveaways: new Map(), // id -> {prize, endsAt, entrants: Set, messageId, channelId}
  snipes: new Map(), // channelId -> {content, authorTag, createdAt}
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,     // for role tools/metadata
    GatewayIntentBits.GuildMessages,    // for moderation utilities
    GatewayIntentBits.MessageContent,   // for /snipe feature
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Utilities
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseDuration(str) {
  // supports 1h30m, 10m, 2d, 45s
  if (!str) return null;
  const regex = /(\d+)\s*(d|h|m|s)/gi;
  let ms = 0, match;
  while ((match = regex.exec(str)) !== null) {
    const val = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    if (unit === 'd') ms += val * 24 * 60 * 60 * 1000;
    if (unit === 'h') ms += val * 60 * 60 * 1000;
    if (unit === 'm') ms += val * 60 * 1000;
    if (unit === 's') ms += val * 1000;
  }
  return ms > 0 ? ms : null;
}

function humanize(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec && parts.length === 0) parts.push(`${sec}s`);
  return parts.join(' ') || '0s';
}

function ensureMap(map, key, init) {
  if (!map.has(key)) map.set(key, init instanceof Function ? init() : init);
  return map.get(key);
}

function choice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeId(prefix='id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

// Command definitions (raw JSON to avoid extra dependencies)
const commands = [
  {
    name: 'ping',
    description: 'Check latency',
  },
  {
    name: 'help',
    description: 'Show command list',
  },
  {
    name: 'avatar',
    description: 'Show user avatar',
    options: [
      { name: 'user', description: 'Target user', type: ApplicationCommandOptionType.User, required: false }
    ],
  },
  {
    name: 'userinfo',
    description: 'Show user info',
    options: [
      { name: 'user', description: 'Target user', type: ApplicationCommandOptionType.User, required: false }
    ],
  },
  {
    name: 'server',
    description: 'Show server info',
  },
  {
    name: 'emojify',
    description: 'Convert text to regional-indicator emoji',
    options: [
      { name: 'text', description: 'Text to emojify', type: ApplicationCommandOptionType.String, required: true }
    ],
  },
  {
    name: 'emoji',
    description: 'Find an emoji by name (with autocomplete)',
    options: [
      { name: 'name', description: 'Emoji name', type: ApplicationCommandOptionType.String, required: true, autocomplete: true }
    ],
  },
  {
    name: 'poll',
    description: 'Start a button poll',
    options: [
      { name: 'question', description: 'Poll question', type: ApplicationCommandOptionType.String, required: true },
      { name: 'options', description: 'Choices separated by ; (max 5)', type: ApplicationCommandOptionType.String, required: true },
      { name: 'multiple', description: 'Allow multiple votes', type: ApplicationCommandOptionType.Boolean, required: false },
    ],
  },
  {
    name: 'remind',
    description: 'Set a reminder',
    options: [
      { name: 'in', description: 'Duration (e.g., 10m, 1h30m, 2d)', type: ApplicationCommandOptionType.String, required: true },
      { name: 'message', description: 'Reminder text', type: ApplicationCommandOptionType.String, required: true },
    ],
  },
  {
    name: 'clean',
    description: 'Bulk delete messages',
    default_member_permissions: String(PermissionFlagsBits.ManageMessages),
    options: [
      { name: 'amount', description: 'Number of messages (1-100)', type: ApplicationCommandOptionType.Integer, required: true, min_value: 1, max_value: 100 },
      { name: 'user', description: 'Only this user', type: ApplicationCommandOptionType.User, required: false },
    ],
  },
  {
    name: 'ttt',
    description: 'Play Tic-Tac-Toe',
    options: [
      { name: 'opponent', description: 'Opponent user', type: ApplicationCommandOptionType.User, required: true }
    ],
  },
  {
    name: 'rps',
    description: 'Play Rock Paper Scissors',
    options: [
      { name: 'opponent', description: 'Opponent user', type: ApplicationCommandOptionType.User, required: true }
    ],
  },
  {
    name: 'giveaway',
    description: 'Start a giveaway',
    options: [
      { name: 'duration', description: 'e.g., 1h, 30m', type: ApplicationCommandOptionType.String, required: true },
      { name: 'prize', description: 'Prize description', type: ApplicationCommandOptionType.String, required: true },
    ],
  },
  {
    name: 'quote',
    description: 'Manage server quotes',
    options: [
      {
        name: 'add', description: 'Add a quote', type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'text', description: 'Quote text', type: ApplicationCommandOptionType.String, required: true }]
      },
      { name: 'random', description: 'Show a random quote', type: ApplicationCommandOptionType.Subcommand },
      { name: 'list', description: 'List quotes', type: ApplicationCommandOptionType.Subcommand },
    ],
  },
  {
    name: 'todo',
    description: 'Personal TODOs',
    options: [
      {
        name: 'add', description: 'Add item', type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'text', description: 'Task text', type: ApplicationCommandOptionType.String, required: true }]
      },
      { name: 'list', description: 'List items', type: ApplicationCommandOptionType.Subcommand },
      {
        name: 'done', description: 'Mark done by number', type: ApplicationCommandOptionType.Subcommand,
        options: [{ name: 'index', description: 'Number from /todo list', type: ApplicationCommandOptionType.Integer, required: true, min_value: 1 }]
      },
    ],
  },
  {
    name: 'karma',
    description: 'Give and view karma',
    options: [
      {
        name: 'give', description: 'Give karma', type: ApplicationCommandOptionType.Subcommand,
        options: [
          { name: 'user', description: 'Recipient', type: ApplicationCommandOptionType.User, required: true },
          { name: 'amount', description: 'Points (default 1)', type: ApplicationCommandOptionType.Integer, required: false, min_value: 1, max_value: 100 }
        ]
      },
      { name: 'leaderboard', description: 'Show top users', type: ApplicationCommandOptionType.Subcommand },
    ],
  },
  {
    name: 'suggest',
    description: 'Open a suggestion modal and send it to a channel',
    options: [
      { name: 'channel', description: 'Target text channel', type: ApplicationCommandOptionType.Channel, required: true, channel_types: [ChannelType.GuildText] }
    ],
  },
  {
    name: 'snipe',
    description: 'Show the last deleted message in this channel',
  },
  // User context command
  {
    name: 'Big Avatar',
    type: 2, // USER
  },
  // Message context command
  {
    name: 'Quote to thread',
    type: 3, // MESSAGE
  },
];

// Register commands
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`Registered ${commands.length} guild commands to ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`Registered ${commands.length} global commands`);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

function regionalize(text) {
  const base = text.toLowerCase();
  const map = {
    'a':'🇦','b':'🇧','c':'🇨','d':'🇩','e':'🇪','f':'🇫','g':'🇬','h':'🇭','i':'🇮','j':'🇯','k':'🇰','l':'🇱','m':'🇲',
    'n':'🇳','o':'🇴','p':'🇵','q':'🇶','r':'🇷','s':'🇸','t':'🇹','u':'🇺','v':'🇻','w':'🇼','x':'🇽','y':'🇾','z':'🇿',' ':'   '
  };
  return [...base].map(ch => map[ch] || ch).join(' ');
}

function renderTTT(board) {
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 3; c++) {
      const i = r*3 + c;
      const val = board[i];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ttt:${i}`)
          .setLabel(val ? val : ' ')
          .setStyle(val ? (val === 'X' ? ButtonStyle.Danger : ButtonStyle.Primary) : ButtonStyle.Secondary)
          .setDisabled(Boolean(val))
      );
    }
    rows.push(row);
  }
  return rows;
}

function tttWinner(board) {
  const lines = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6]
  ];
  for (const [a,b,c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every(Boolean)) return 'TIE';
  return null;
}

// Interaction handlers
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Autocomplete
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'emoji') {
        const focused = interaction.options.getFocused().toLowerCase();
        const suggestions = interaction.guild?.emojis?.cache ?? new Map();
        const matches = [...suggestions.values()]
          .filter(e => e.name && e.name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map(e => ({ name: `${e.toString()} ${e.name}`, value: e.name }));
        await interaction.respond(matches);
      }
      return;
    }

    // Buttons & Selects & Modals
    if (interaction.isButton()) {
      const [kind, ...rest] = interaction.customId.split(':');

      // Poll
      if (kind === 'poll') {
        const [pollId, idxStr] = rest;
        const poll = store.polls.get(pollId);
        if (!poll) return interaction.reply({ content: 'Poll expired.', ephemeral: true });
        const idx = parseInt(idxStr, 10);

        if (!poll.multiple) {
          if (poll.voters.has(interaction.user.id)) {
            const prev = poll.voters.get(interaction.user.id);
            if (prev === idx) {
              return interaction.reply({ content: 'You already voted for this option.', ephemeral: true });
            }
            poll.options[prev].count--;
          }
          poll.voters.set(interaction.user.id, idx);
          poll.options[idx].count++;
        } else {
          // Multiple votes toggle
          const key = `${interaction.user.id}:${idx}`;
          if (!poll.multiVoters) poll.multiVoters = new Set();
          if (poll.multiVoters.has(key)) {
            poll.multiVoters.delete(key);
            poll.options[idx].count--;
          } else {
            poll.multiVoters.add(key);
            poll.options[idx].count++;
          }
        }

        const rows = new ActionRowBuilder().addComponents(
          ...poll.options.map((opt, i) =>
            new ButtonBuilder()
              .setCustomId(`poll:${pollId}:${i}`)
              .setLabel(`${opt.label} (${opt.count})`)
              .setStyle(ButtonStyle.Primary)
          )
        );
        const embed = new EmbedBuilder()
          .setTitle('📊 ' + poll.question)
          .setDescription(poll.multiple ? 'Multiple votes allowed' : 'Single vote')
          .setColor(0x5865F2)
          .setFooter({ text: `Total votes: ${poll.options.reduce((a,b)=>a+b.count,0)}` });

        const msg = await interaction.message.fetch();
        await interaction.update({ embeds: [embed], components: [rows] });
        return;
      }

      // RPS
      if (kind === 'rps') {
        const [challengerId, opponentId, choice] = rest;
        if (![challengerId, opponentId].includes(interaction.user.id)) {
          return interaction.reply({ content: 'Not your game.', ephemeral: true });
        }
        const userChoice = choice;
        const other = interaction.user.id === challengerId ? opponentId : challengerId;
        const otherChoice = ['rock','paper','scissors'][Math.floor(Math.random()*3)];
        const result = (a, b) => {
          if (a === b) return 'Tie!';
          if ((a==='rock'&&b==='scissors')||(a==='paper'&&b==='rock')||(a==='scissors'&&b==='paper')) return 'You win!';
          return 'You lose!';
        };
        const embed = new EmbedBuilder()
          .setTitle('🪨📄✂️ Rock, Paper, Scissors')
          .setDescription(`<@${interaction.user.id}> chose ${userChoice}; <@${other}> chose ${otherChoice}. ${result(userChoice, otherChoice)}`)
          .setColor(0x00AE86);
        await interaction.reply({ embeds: [embed] });
        return;
      }

      // TTT moves handled below in message component collector section (we’ll route via message-specific customIds)
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId.startsWith('suggest:')) {
        const channelId = interaction.customId.split(':')[1];
        const title = interaction.fields.getTextInputValue('suggest_title');
        const details = interaction.fields.getTextInputValue('suggest_details');
        const channel = interaction.guild.channels.cache.get(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'Target channel not found.', ephemeral: true });
        }
        const embed = new EmbedBuilder()
          .setTitle('💡 New Suggestion')
          .addFields(
            { name: 'Title', value: title },
            { name: 'Details', value: details }
          )
          .setFooter({ text: `From ${interaction.user.tag}` })
          .setTimestamp()
          .setColor(0xFFD166);
        await channel.send({ embeds: [embed] });
        return interaction.reply({ content: 'Suggestion submitted!', ephemeral: true });
      }
    }

    // Slash and context commands
    if (!interaction.isChatInputCommand() && !interaction.isUserContextMenuCommand() && !interaction.isMessageContextMenuCommand()) return;

    // USER context: Big Avatar
    if (interaction.isUserContextMenuCommand() && interaction.commandName === 'Big Avatar') {
      const user = interaction.targetUser;
      const url = user.displayAvatarURL({ size: 1024, extension: 'png' });
      const embed = new EmbedBuilder().setTitle(`${user.tag}'s Avatar`).setImage(url);
      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    // MESSAGE context: Quote to thread
    if (interaction.isMessageContextMenuCommand() && interaction.commandName === 'Quote to thread') {
      const message = interaction.targetMessage;
      const threadName = `Quote by ${message.author?.username || 'Unknown'}`;
      const thread = await interaction.channel.threads.create({
        name: threadName,
        autoArchiveDuration: 60,
      });
      await thread.send({ content: `> ${message.content || '(no content)'}\n— <@${message.author?.id || 'unknown'}>` });
      return interaction.reply({ content: `Quoted to thread: ${thread.toString()}`, ephemeral: true });
    }

    // Slash commands
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'ping') {
        const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        return interaction.editReply(`Pong! 🏓 ${latency}ms`);
      }

      if (commandName === 'help') {
        const embed = new EmbedBuilder()
          .setTitle('Command Help')
          .setColor(0x5865F2)
          .setDescription([
            'General: /ping, /help, /avatar, /userinfo, /server, /emojify, /emoji',
            'Utility: /remind, /clean, /snipe, /suggest',
            'Fun: /poll, /ttt, /rps, /giveaway',
            'Social: /quote, /todo, /karma',
            'Context: user "Big Avatar", message "Quote to thread"',
          ].join('\n'));
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      if (commandName === 'avatar') {
        const user = interaction.options.getUser('user') || interaction.user;
        const url = user.displayAvatarURL({ size: 1024, extension: 'png' });
        const embed = new EmbedBuilder().setTitle(`${user.tag}'s Avatar`).setImage(url);
        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === 'userinfo') {
        const user = interaction.options.getUser('user') || interaction.user;
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        const embed = new EmbedBuilder()
          .setTitle('User Info')
          .setThumbnail(user.displayAvatarURL())
          .addFields(
            { name: 'User', value: `${user.tag} (${user.id})` },
            { name: 'Created', value: `<t:${Math.floor(user.createdTimestamp/1000)}:R>` },
            { name: 'Joined', value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : 'N/A' }
          )
          .setColor(0x00AE86);
        return interaction.reply({ embeds: [embed], ephemeral: false });
      }

      if (commandName === 'server') {
        const g = interaction.guild;
        const embed = new EmbedBuilder()
          .setTitle('Server Info')
          .setThumbnail(g.iconURL())
          .addFields(
            { name: 'Name', value: g.name, inline: true },
            { name: 'ID', value: g.id, inline: true },
            { name: 'Members', value: `${g.memberCount}`, inline: true }
          )
          .setColor(0x2F3136);
        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === 'emojify') {
        const text = interaction.options.getString('text', true);
        const out = regionalize(text);
        return interaction.reply({ content: out });
      }

      if (commandName === 'emoji') {
        const name = interaction.options.getString('name', true).toLowerCase();
        const e = interaction.guild?.emojis?.cache.find(e => e.name?.toLowerCase() === name);
        if (!e) return interaction.reply({ content: 'Emoji not found.', ephemeral: true });
        return interaction.reply({ content: `${e}  :${e.name}:  (${e.id})` });
      }

      if (commandName === 'poll') {
        const question = interaction.options.getString('question', true);
        const raw = interaction.options.getString('options', true);
        const multiple = interaction.options.getBoolean('multiple') || false;
        const opts = raw.split(';').map(s => s.trim()).filter(Boolean).slice(0, 5);
        if (opts.length < 2) return interaction.reply({ content: 'Provide at least 2 options.', ephemeral: true });

        const pollId = makeId('poll');
        const data = {
          question,
          multiple,
          options: opts.map(o => ({ label: o, count: 0 })),
          voters: new Map(),
          multiVoters: new Set(),
        };
        store.polls.set(pollId, data);

        const rows = new ActionRowBuilder().addComponents(
          ...data.options.map((opt, i) =>
            new ButtonBuilder()
              .setCustomId(`poll:${pollId}:${i}`)
              .setLabel(`${opt.label} (0)`)
              .setStyle(ButtonStyle.Primary)
          )
        );
        const embed = new EmbedBuilder()
          .setTitle('📊 ' + question)
          .setDescription(multiple ? 'Multiple votes allowed' : 'Single vote')
          .setColor(0x5865F2);

        const msg = await interaction.reply({ embeds: [embed], components: [rows], fetchReply: true });
        data.messageId = msg.id;
        data.channelId = msg.channelId;
        return;
      }

      if (commandName === 'remind') {
        const d = interaction.options.getString('in', true);
        const text = interaction.options.getString('message', true);
        const ms = parseDuration(d);
        if (!ms) return interaction.reply({ content: 'Invalid duration. Try 10m, 1h30m, 2d.', ephemeral: true });
        await interaction.reply({ content: `Reminder set for ${humanize(ms)}.`, ephemeral: true });
        setTimeout(async () => {
          try {
            await interaction.followUp({ content: `⏰ <@${interaction.user.id}> Reminder: ${text}` });
          } catch {}
        }, ms);
        return;
      }

      if (commandName === 'clean') {
        const amount = interaction.options.getInteger('amount', true);
        const user = interaction.options.getUser('user');
        if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
          return interaction.reply({ content: 'Missing Manage Messages permission.', ephemeral: true });
        }
        const channel = interaction.channel;
        if (user) {
          const messages = await channel.messages.fetch({ limit: 100 });
          const filtered = messages.filter(m => m.author.id === user.id).first(amount);
          await channel.bulkDelete(filtered, true);
          return interaction.reply({ content: `Deleted ${filtered.length} messages from ${user.tag}.`, ephemeral: true });
        } else {
          await channel.bulkDelete(amount, true);
          return interaction.reply({ content: `Deleted up to ${amount} messages.`, ephemeral: true });
        }
      }

      if (commandName === 'ttt') {
        const opponent = interaction.options.getUser('opponent', true);
        if (opponent.bot || opponent.id === interaction.user.id) {
          return interaction.reply({ content: 'Pick a different human opponent.', ephemeral: true });
        }
        const gameId = makeId('ttt');
        const data = { players: [interaction.user.id, opponent.id], turn: 0, board: Array(9).fill(null) };
        const embed = new EmbedBuilder().setTitle('Tic-Tac-Toe').setDescription(`<@${data.players[0]}> (X) vs <@${data.players[1]}> (O)\nTurn: <@${data.players[data.turn]}>`);
        const msg = await interaction.reply({ embeds: [embed], components: renderTTT(data.board), fetchReply: true });
        data.messageId = msg.id;
        data.channelId = msg.channelId;
        store.ttt.set(gameId, data);

        // Collector for this message
        const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 10 * 60 * 1000 });
        collector.on('collect', async (btn) => {
          if (!btn.customId.startsWith('ttt:')) return;
          const idx = parseInt(btn.customId.split(':')[1], 10);
          if (![...data.players].includes(btn.user.id)) return btn.reply({ content: 'Not your game.', ephemeral: true });
          if (btn.user.id !== data.players[data.turn]) return btn.reply({ content: 'Wait your turn.', ephemeral: true });
          if (data.board[idx]) return btn.reply({ content: 'Spot taken.', ephemeral: true });

          data.board[idx] = data.turn === 0 ? 'X' : 'O';
          const win = tttWinner(data.board);
          let desc = `<@${data.players[0]}> (X) vs <@${data.players[1]}> (O)\n`;
          if (win === 'TIE') desc += 'Result: Tie!';
          else if (win) desc += `Winner: ${win === 'X' ? `<@${data.players[0]}>` : `<@${data.players[1]}>`}`;
          else {
            data.turn = 1 - data.turn;
            desc += `Turn: <@${data.players[data.turn]}>`;
          }
          const embedU = new EmbedBuilder().setTitle('Tic-Tac-Toe').setDescription(desc);
          const components = win ? renderTTT(data.board).map(row => {
            row.components.forEach(b => b.setDisabled(true));
            return row;
          }) : renderTTT(data.board);
          await btn.update({ embeds: [embedU], components });
          if (win) collector.stop('game_end');
        });
        collector.on('end', async () => {
          try {
            const message = await interaction.fetchReply();
            const rows = renderTTT(data.board);
            rows.forEach(row => row.components.forEach(b => b.setDisabled(true)));
            await message.edit({ components: rows });
          } catch {}
          store.ttt.delete(gameId);
        });
        return;
      }

      if (commandName === 'rps') {
        const opponent = interaction.options.getUser('opponent', true);
        if (opponent.bot || opponent.id === interaction.user.id) {
          return interaction.reply({ content: 'Pick a different human opponent.', ephemeral: true });
        }
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`rps:${interaction.user.id}:${opponent.id}:rock`).setLabel('🪨 Rock').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rps:${interaction.user.id}:${opponent.id}:paper`).setLabel('📄 Paper').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`rps:${interaction.user.id}:${opponent.id}:scissors`).setLabel('✂️ Scissors').setStyle(ButtonStyle.Secondary),
        );
        return interaction.reply({ content: `<@${opponent.id}> choose your move against <@${interaction.user.id}>!`, components: [row] });
      }

      if (commandName === 'giveaway') {
        const duration = interaction.options.getString('duration', true);
        const prize = interaction.options.getString('prize', true);
        const ms = parseDuration(duration);
        if (!ms) return interaction.reply({ content: 'Invalid duration. Try 10m, 1h.', ephemeral: true });
        const endsAt = Date.now() + ms;
        const gwId = makeId('gaw');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`gaw_join:${gwId}`).setLabel('Enter 🎉').setStyle(ButtonStyle.Success)
        );
        const embed = new EmbedBuilder()
          .setTitle('🎉 Giveaway')
          .setDescription(`Prize: ${prize}\nEnds: <t:${Math.floor(endsAt/1000)}:R>\nClick Enter to join!`)
          .setColor(0xFEE75C);
        const msg = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
        const data = { prize, endsAt, entrants: new Set(), messageId: msg.id, channelId: msg.channelId };
        store.giveaways.set(gwId, data);

        // Collector for entries
        const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: ms });
        collector.on('collect', async (btn) => {
          if (btn.customId !== `gaw_join:${gwId}`) return;
          data.entrants.add(btn.user.id);
          await btn.reply({ content: 'You are entered! 🎟️', ephemeral: true });
        });
        collector.on('end', async () => {
          const entrants = [...data.entrants];
          const winner = entrants.length ? choice(entrants) : null;
          const result = new EmbedBuilder()
            .setTitle('🎉 Giveaway Ended')
            .setDescription(winner ? `Winner: <@${winner}> — Prize: ${prize}` : `No entries. Prize: ${prize}`)
            .setColor(0xFEE75C);
          try {
            const m = await interaction.fetchReply();
            await m.edit({ embeds: [result], components: [] });
          } catch {}
          store.giveaways.delete(gwId);
        });
        return;
      }

      if (commandName === 'quote') {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const list = ensureMap(store.quotes, guildId, []);
        if (sub === 'add') {
          const text = interaction.options.getString('text', true);
          list.push(text);
          return interaction.reply({ content: `Added quote #${list.length}.`, ephemeral: true });
        }
        if (sub === 'random') {
          if (list.length === 0) return interaction.reply({ content: 'No quotes yet.', ephemeral: true });
          const q = choice(list);
          return interaction.reply({ content: `“${q}”` });
        }
        if (sub === 'list') {
          if (list.length === 0) return interaction.reply({ content: 'No quotes yet.', ephemeral: true });
          const chunks = [];
          let cur = '';
          list.forEach((q, i) => {
            const line = `${i+1}. ${q}\n`;
            if (cur.length + line.length > 1900) {
              chunks.push(cur);
              cur = '';
            }
            cur += line;
          });
          if (cur) chunks.push(cur);
          for (const ch of chunks) {
            await interaction.channel.send('``````');
          }
          return interaction.reply({ content: `Listed ${list.length} quotes.`, ephemeral: true });
        }
      }

      if (commandName === 'todo') {
        const sub = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        const todos = ensureMap(store.todos, userId, []);
        if (sub === 'add') {
          const text = interaction.options.getString('text', true);
          todos.push({ text, done: false });
          return interaction.reply({ content: `Added TODO #${todos.length}.`, ephemeral: true });
        }
        if (sub === 'list') {
          if (todos.length === 0) return interaction.reply({ content: 'Your list is empty.', ephemeral: true });
          const lines = todos.map((t, i) => `${i+1}. [${t.done ? 'x':' '}] ${t.text}`).join('\n');
          return interaction.reply({ content: '``````', ephemeral: true });
        }
        if (sub === 'done') {
          const idx = interaction.options.getInteger('index', true) - 1;
          if (!todos[idx]) return interaction.reply({ content: 'Invalid index.', ephemeral: true });
          todos[idx].done = true;
          return interaction.reply({ content: `Marked #${idx+1} done.`, ephemeral: true });
        }
      }

      if (commandName === 'karma') {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const map = ensureMap(store.karma, guildId, () => new Map());
        if (sub === 'give') {
          const user = interaction.options.getUser('user', true);
          const amount = interaction.options.getInteger('amount') ?? 1;
          map.set(user.id, (map.get(user.id) || 0) + amount);
          return interaction.reply({ content: `Gave ${amount} karma to ${user.tag}. Total: ${map.get(user.id)}.` });
        }
        if (sub === 'leaderboard') {
          const arr = [...map.entries()].sort((a,b) => (b[1]||0)-(a[1]||0)).slice(0, 10);
          if (!arr.length) return interaction.reply({ content: 'No karma yet.', ephemeral: true });
          const lines = await Promise.all(arr.map(async ([uid, score], i) => {
            const u = await client.users.fetch(uid).catch(()=>null);
            return `${i+1}. ${u?.tag || uid} — ${score}`;
          }));
          return interaction.reply({ content: '``````' });
        }
      }

      if (commandName === 'suggest') {
        const channel = interaction.options.getChannel('channel', true);
        const modal = new ModalBuilder()
          .setCustomId(`suggest:${channel.id}`)
          .setTitle('Submit a Suggestion');
        const title = new TextInputBuilder().setCustomId('suggest_title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
        const details = new TextInputBuilder().setCustomId('suggest_details').setLabel('Details').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
        modal.addComponents(new ActionRowBuilder().addComponents(title), new ActionRowBuilder().addComponents(details));
        return interaction.showModal(modal);
      }

      if (commandName === 'snipe') {
        const data = store.snipes.get(interaction.channelId);
        if (!data) return interaction.reply({ content: 'Nothing to snipe.', ephemeral: true });
        const embed = new EmbedBuilder()
          .setTitle('🕵️ Last Deleted Message')
          .addFields(
            { name: 'Author', value: data.authorTag },
            { name: 'Content', value: data.content || '(no content)' },
          )
          .setFooter({ text: `Deleted ${Math.floor((Date.now()-data.createdAt)/1000)}s ago` })
          .setColor(0x99AAB5);
        return interaction.reply({ embeds: [embed] });
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.deferred || interaction.replied) {
      try { await interaction.followUp({ content: 'An error occurred.', ephemeral: true }); } catch {}
    } else {
      try { await interaction.reply({ content: 'An error occurred.', ephemeral: true }); } catch {}
    }
  }
});

// Giveaway button joins (global listener)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const id = interaction.customId;
  if (id.startsWith('gaw_join:')) {
    const gwId = id.split(':')[1];
    const data = store.giveaways.get(gwId);
    if (!data) return interaction.reply({ content: 'Giveaway ended.', ephemeral: true });
    data.entrants.add(interaction.user.id);
    return interaction.reply({ content: 'You are entered! 🎟️', ephemeral: true });
  }
});

// Text prefix commands (! prefix)
const PREFIX = '!';
client.on(Events.MessageCreate, async (message) => {
  if (!message.content.startsWith(PREFIX) || message.author.bot || !message.guild) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  try {
    if (cmd === 'ping') {
      const sent = await message.reply({ content: 'Pinging...', fetchReply: true });
      const latency = sent.createdTimestamp - message.createdTimestamp;
      return message.reply(`Pong! 🏓 ${latency}ms`);
    }

    if (cmd === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('Command Help (! prefix)')
        .setColor(0x5865F2)
        .setDescription([
          '!ping — latency check',
          '!avatar [@user] — show avatar',
          '!userinfo [@user] — user details',
          '!server — server info',
          '!emojify <text> — convert to regional emoji',
          '!snipe — last deleted message',
          '!kick @user [reason] — kick a user (requires permission)',
          '!ban @user [reason] — ban a user (requires permission)',
          'Also available as slash commands: /ping, /help, /avatar, /userinfo, /server, /emojify, /emoji, /poll, /ttt, /rps, /giveaway, /remind, /clean, /quote, /todo, /karma, /suggest',
        ].join('\n'));
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'avatar') {
      const user = message.mentions.has(client.user) ? null : (message.mentions.users.first() || message.author);
      const url = user.displayAvatarURL({ size: 1024, extension: 'png' });
      const embed = new EmbedBuilder().setTitle(`${user.tag}'s Avatar`).setImage(url);
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'userinfo') {
      const user = message.mentions.users.first() || message.author;
      const member = await message.guild.members.fetch(user.id).catch(() => null);
      const embed = new EmbedBuilder()
        .setTitle('User Info')
        .setThumbnail(user.displayAvatarURL())
        .addFields(
          { name: 'User', value: `${user.tag} (${user.id})` },
          { name: 'Created', value: `<t:${Math.floor(user.createdTimestamp/1000)}:R>` },
          { name: 'Joined', value: member?.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : 'N/A' }
        )
        .setColor(0x00AE86);
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'server') {
      const g = message.guild;
      const embed = new EmbedBuilder()
        .setTitle('Server Info')
        .setThumbnail(g.iconURL())
        .addFields(
          { name: 'Name', value: g.name, inline: true },
          { name: 'ID', value: g.id, inline: true },
          { name: 'Members', value: `${g.memberCount}`, inline: true }
        )
        .setColor(0x2F3136);
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'emojify') {
      if (args.length === 0) return message.reply('Provide text to emojify.');
      const text = args.join(' ');
      const out = regionalize(text);
      return message.reply({ content: out });
    }

    if (cmd === 'snipe') {
      const data = store.snipes.get(message.channel.id);
      if (!data) return message.reply('Nothing to snipe.');
      const embed = new EmbedBuilder()
        .setTitle('🕵️ Last Deleted Message')
        .addFields(
          { name: 'Author', value: data.authorTag },
          { name: 'Content', value: data.content || '(no content)' },
        )
        .setFooter({ text: `Deleted ${Math.floor((Date.now()-data.createdAt)/1000)}s ago` })
        .setColor(0x99AAB5);
      return message.reply({ embeds: [embed] });
    }

    if (cmd === 'kick') {
      if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) {
        return message.reply('You need the Kick Members permission.');
      }
      const user = message.mentions.users.first();
      if (!user) return message.reply('Mention a user to kick.');
      const member = await message.guild.members.fetch(user.id).catch(() => null);
      if (!member) return message.reply('User not found in this server.');
      const reason = args.slice(1).join(' ') || 'No reason provided';
      try {
        await member.kick(reason);
        return message.reply(`✅ Kicked ${user.tag} — Reason: ${reason}`);
      } catch (err) {
        return message.reply(`❌ Could not kick ${user.tag}: ${err.message}`);
      }
    }

    if (cmd === 'ban') {
      if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
        return message.reply('You need the Ban Members permission.');
      }
      const user = message.mentions.users.first();
      if (!user) return message.reply('Mention a user to ban.');
      const reason = args.slice(1).join(' ') || 'No reason provided';
      try {
        await message.guild.members.ban(user, { reason });
        return message.reply(`✅ Banned ${user.tag} — Reason: ${reason}`);
      } catch (err) {
        return message.reply(`❌ Could not ban ${user.tag}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`Error in prefix command ${cmd}:`, err);
    message.reply('An error occurred.').catch(() => {});
  }
});

// Snipe storage
client.on(Events.MessageDelete, async (message) => {
  try {
    if (!message.guild || !message.channel) return;
    store.snipes.set(message.channel.id, {
      content: message.content || '',
      authorTag: message.author ? message.author.tag : (message.member?.user?.tag || 'Unknown'),
      createdAt: Date.now(),
    });
  } catch {}
});

// HTTP server with health and status endpoints (useful for Render, Railway, Heroku, etc.)
const http = require('http');
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('OK');
    }

    if (req.method === 'GET' && req.url === '/status') {
      const payload = {
        status: 'ok',
        uptime_seconds: Math.floor(process.uptime()),
        node_version: process.version,
        mem_rss: process.memoryUsage().rss,
        bot_ready: typeof client.isReady === 'function' ? client.isReady() : Boolean(client.user),
        guilds_cached: client.guilds?.cache?.size ?? 0,
        timestamp: Date.now(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(payload));
    }

    if (req.method === 'GET' && req.url === '/metrics') {
      // Simple Prometheus-like metrics
      const mem = process.memoryUsage();
      const lines = [];
      lines.push(`# HELP process_uptime_seconds Process uptime in seconds`);
      lines.push(`# TYPE process_uptime_seconds gauge`);
      lines.push(`process_uptime_seconds ${process.uptime()}`);
      lines.push(`# HELP process_memory_rss_bytes RSS memory in bytes`);
      lines.push(`# TYPE process_memory_rss_bytes gauge`);
      lines.push(`process_memory_rss_bytes ${mem.rss}`);
      lines.push(`# HELP discord_guilds_cached Number of guilds cached by the bot`);
      lines.push(`# TYPE discord_guilds_cached gauge`);
      lines.push(`discord_guilds_cached ${client.guilds?.cache?.size ?? 0}`);
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      return res.end(lines.join('\n'));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
    console.error('HTTP server error:', err);
  }
});

server.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// Boot
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
