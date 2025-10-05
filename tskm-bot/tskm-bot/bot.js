// 🔰 Anti-crash & redémarrage auto
process.on('uncaughtException', (err) => {
  console.error('❌ Erreur non gérée :', err);
  restartBot();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️ Promesse non gérée :', reason);
  restartBot();
});

function restartBot() {
  console.log('🔁 Redémarrage du bot dans 3 secondes...');
  setTimeout(() => {
    process.exit(1);
  }, 3000);
}
const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
require('dotenv').config();

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('Token manquant. Crée un fichier .env avec TOKEN=ton_token');
  process.exit(1);
}

// ---------- Config ----------
const PREFIX = '+';
const DATA_FILE = './data.json';
const START_COINS = 50;
const CLAN_CREATE_COST = 200;
const MINE_COOLDOWN_MS = 1000; // 1s

// Pickaxes & bags per user's requested values
const PICKAXES = [
  { id: 'wood', name: 'Pioche — Bois', cost: 50, durability: 25, multiplier: 1 },
  { id: 'stone', name: 'Pioche — Pierre', cost: 150, durability: 40, multiplier: 1.3 },
  { id: 'iron', name: 'Pioche — Fer', cost: 400, durability: 60, multiplier: 1.6 },
  { id: 'diamond', name: 'Pioche — Diamant', cost: 1000, durability: 90, multiplier: 2 },
  { id: 'tsukamunite', name: 'Pioche — tsukamunite', cost: 2500, durability: 150, multiplier: 3 }
];

const BAGS = [
  { id: 'small', name: 'Petit sac', cost: 100, capacity: 50 },
  { id: 'medium', name: 'Sac moyen', cost: 400, capacity: 150 },
  { id: 'large', name: 'Grand sac', cost: 1000, capacity: 300 },
  { id: 'legend', name: 'Sac légendaire', cost: 2500, capacity: 600 }
];

const MINERALS = [
  { id: 'charbon', name: 'Charbon', value: 5 },
  { id: 'fer', name: 'Fer', value: 10 },
  { id: 'or', name: 'Or', value: 20 },
  { id: 'diamant', name: 'Diamant', value: 50 },
  { id: 'emeraude', name: 'Emeraude', value: 100 }
];

function bagCapacity(level) { return level * 50; } // legacy support if used; but we'll store bag level or bag object

// ---------- Persistence ----------
let data = { users: {}, clans: {} };
try {
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  }
} catch (err) {
  console.error('Erreur lecture/data.json :', err);
  process.exit(1);
}
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Erreur sauvegarde data:', err);
  }
}

// ---------- Helpers ----------
function ensureUser(id) {
  if (!data.users[id]) {
    data.users[id] = {
      coins: START_COINS,
      lastDaily: 0,
      // pickaxe stored as { id, name, durability, multiplier } or null
      pickaxe: null,
      // bag stored as { id, name, capacity } or null -> default small
      bag: { id: 'small', name: 'Petit sac', capacity: 50 },
      inventory: {}, // mineralName -> qty
      clan: null,
      lastMine: 0
    };
    saveData();
  }
  return data.users[id];
}

function ensureClan(name) {
  if (!data.clans[name]) {
    data.clans[name] = { name, leader: null, members: [], bank: 0 };
    saveData();
  }
  return data.clans[name];
}

function now() { return Date.now(); }

function clanTotalCoins(clanName) {
  const clan = data.clans[clanName];
  if (!clan) return 0;
  let sum = clan.bank || 0;
  for (const mId of clan.members) {
    ensureUser(mId);
    sum += data.users[mId].coins || 0;
  }
  return sum;
}

// ---------- Client ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once('ready', async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    try { await ensureGuildSetup(guild); } catch (e) { console.error('setup guild err', e); }
  }
});

client.on('guildCreate', async guild => {
  try { await ensureGuildSetup(guild); } catch (e) { console.error('guildCreate setup err', e); }
});

// ---------- Guild Setup ----------
async function ensureGuildSetup(guild) {
  // create category GuardX if missing
  let category = guild.channels.cache.find(c => c.name === 'GuardX' && c.type === 4);
  if (!category) {
    try {
      category = await guild.channels.create({ name: 'GuardX', type: 4 });
    } catch (e) { /* ignore permission issues */ }
  }

  const findOrCreate = async (name) => {
    let ch = guild.channels.cache.find(c => c.name === name);
    if (!ch) {
      try {
        ch = await guild.channels.create({ name, type: 0, parent: category ? category.id : undefined });
      } catch (e) { console.warn(`Impossible de créer ${name} (permissions?)`); }
    }
    return ch;
  };

  const shop = await findOrCreate('🛒-shop');
  const minage = await findOrCreate('⛏️-minage');
  const sell = await findOrCreate('💰-vente');

  // remove old bot messages and post fresh embeds
  if (shop) await resetChannelBotMessages(shop);
  if (minage) await resetChannelBotMessages(minage);
  if (sell) await resetChannelBotMessages(sell);

  if (shop) await sendShopEmbed(shop);
  if (minage) await sendMineEmbed(minage);
  if (sell) await sendSellEmbed(sell);
}

async function resetChannelBotMessages(channel) {
  try {
    const msgs = await channel.messages.fetch({ limit: 100 });
    const botMsgs = msgs.filter(m => m.author?.id === client.user.id);
    for (const m of botMsgs.values()) {
      try { await m.delete(); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

// ---------- Embeds & Shop layout ----------
async function sendShopEmbed(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🛒 Boutique Officielle')
    .setDescription('Clique sur le bouton d\'un objet pour voir ses détails (embed privé) puis achète si tu veux.')
    .setColor('#0EA5E9')
    .setFooter({ text: 'par asap trop uhq' });

  // show pickaxes summary
  embed.addFields({ name: 'Pioches', value: PICKAXES.map(p => `${p.name} — ${p.cost} coins | Dur: ${p.durability} | x${p.multiplier}`).join('\n') });
  // show bags summary
  embed.addFields({ name: 'Sacs', value: BAGS.map(b => `${b.name} — ${b.cost} coins | Capacité: ${b.capacity}`).join('\n') });

  // build rows of buttons: Discord allows max 5 buttons per row, we can create multiple rows
  const components = [];
  // pickaxe buttons, chunked into rows of 5
  for (let i = 0; i < PICKAXES.length; i += 5) {
    const row = new ActionRowBuilder();
    PICKAXES.slice(i, i + 5).forEach(p => row.addComponents(
      new ButtonBuilder().setCustomId(`details_pickaxe_${p.id}`).setLabel(p.name).setStyle(ButtonStyle.Primary)
    ));
    components.push(row);
  }
  // bags buttons
  for (let i = 0; i < BAGS.length; i += 5) {
    const row = new ActionRowBuilder();
    BAGS.slice(i, i + 5).forEach(b => row.addComponents(
      new ButtonBuilder().setCustomId(`details_bag_${b.id}`).setLabel(b.name).setStyle(ButtonStyle.Secondary)
    ));
    components.push(row);
  }

  await channel.send({ embeds: [embed], components });
}

async function sendMineEmbed(channel) {
  const embed = new EmbedBuilder()
    .setTitle('⛏️ Zone de Minage')
    .setDescription(`Clique sur **Miner** pour tenter d'extraire un minerai.\nCooldown : ${Math.floor(MINE_COOLDOWN_MS / 1000)}s\nLes résultats sont envoyés en message privé (éphémère).`)
    .setColor('#10B981');

  const mineralsList = MINERALS.map(m => `${m.name} — valeur: ${m.value} coins`).join('\n');
  embed.addFields({ name: 'Minerais possibles', value: mineralsList });

  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('mine_action').setLabel('⛏️ Miner').setStyle(ButtonStyle.Success));
  await channel.send({ embeds: [embed], components: [row] });
}

async function sendSellEmbed(channel) {
  const embed = new EmbedBuilder()
    .setTitle('💰 Vente de Ressources')
    .setDescription('Clique sur **Vendre** pour convertir tous tes minerais en coins (réponse éphémère).')
    .setColor('#F59E0B');

  const prices = MINERALS.map(m => `${m.name} — ${m.value} coins`).join('\n');
  embed.addFields({ name: 'Prix actuels', value: prices });

  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('sell_action').setLabel('💰 Vendre tout').setStyle(ButtonStyle.Danger));
  await channel.send({ embeds: [embed], components: [row] });
}

// ---------- Interactions ----------
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton()) return;

    const uid = interaction.user.id;
    ensureUser(uid);
    const user = data.users[uid];

    // Details for pickaxe -> send ephemeral embed with a buy button
    if (interaction.customId.startsWith('details_pickaxe_')) {
      const id = interaction.customId.replace('details_pickaxe_', '');
      const pick = PICKAXES.find(p => p.id === id);
      if (!pick) return interaction.reply({ content: 'Item introuvable.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle(`${pick.name}`)
        .setDescription(`Prix: **${pick.cost}** coins\nDurabilité: **${pick.durability}**\nMultiplicateur: **x${pick.multiplier}**`)
        .setColor('#38BDF8');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`buy_pickaxe_${pick.id}`).setLabel('Acheter').setStyle(ButtonStyle.Success)
      );
      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    // Details for bag
    if (interaction.customId.startsWith('details_bag_')) {
      const id = interaction.customId.replace('details_bag_', '');
      const bag = BAGS.find(b => b.id === id);
      if (!bag) return interaction.reply({ content: 'Item introuvable.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle(`${bag.name}`)
        .setDescription(`Prix: **${bag.cost}** coins\nCapacité: **${bag.capacity}** minerais`)
        .setColor('#A78BFA');
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`buy_bag_${bag.id}`).setLabel('Acheter').setStyle(ButtonStyle.Success)
      );
      return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    // Buy pickaxe (after details)
    if (interaction.customId.startsWith('buy_pickaxe_')) {
      const id = interaction.customId.replace('buy_pickaxe_', '');
      const pick = PICKAXES.find(p => p.id === id);
      if (!pick) return interaction.reply({ content: 'Pioche introuvable.', ephemeral: true });
      if (user.coins < pick.cost) return interaction.reply({ content: `❌ Il te faut ${pick.cost} coins pour acheter cette pioche.`, ephemeral: true });
      // Deduct and assign
      user.coins -= pick.cost;
      user.pickaxe = { id: pick.id, name: pick.name, durability: pick.durability, multiplier: pick.multiplier };
      saveData();
      return interaction.reply({ content: `✅ Achat confirmé : ${pick.name} (durabilité ${pick.durability})`, ephemeral: true });
    }

    // Buy bag
    if (interaction.customId.startsWith('buy_bag_')) {
      const id = interaction.customId.replace('buy_bag_', '');
      const bag = BAGS.find(b => b.id === id);
      if (!bag) return interaction.reply({ content: 'Sac introuvable.', ephemeral: true });
      if (user.coins < bag.cost) return interaction.reply({ content: `❌ Il te faut ${bag.cost} coins pour acheter ce sac.`, ephemeral: true });
      user.coins -= bag.cost;
      user.bag = { id: bag.id, name: bag.name, capacity: bag.capacity };
      saveData();
      return interaction.reply({ content: `✅ Tu as acheté ${bag.name} — capacité: ${bag.capacity}`, ephemeral: true });
    }

    // Mine (ephemeral result)
    if (interaction.customId === 'mine_action') {
      // checks
      if (!user.pickaxe) return interaction.reply({ content: '❌ Tu n\'as pas de pioche. Achète-en une dans la boutique.', ephemeral: true });
      if (now() - user.lastMine < MINE_COOLDOWN_MS) return interaction.reply({ content: `⏳ Attends encore ${Math.ceil((MINE_COOLDOWN_MS - (now() - user.lastMine)) / 1000)}s.`, ephemeral: true });
      if (user.pickaxe.durability <= 0) { user.pickaxe = null; saveData(); return interaction.reply({ content: '💥 Ta pioche est cassée !', ephemeral: true }); }

      // weighted mineral selection
      const r = Math.random();
      let chosen;
      if (r > 0.97) chosen = MINERALS.find(m => m.id === 'emeraude');
      else if (r > 0.9) chosen = MINERALS.find(m => m.id === 'diamant');
      else if (r > 0.6) chosen = MINERALS.find(m => m.id === 'or');
      else if (r > 0.25) chosen = MINERALS.find(m => m.id === 'fer');
      else chosen = MINERALS.find(m => m.id === 'charbon');

      // quantity and capacity check
      const qty = Math.max(1, Math.floor(1 * user.pickaxe.multiplier));
      const capacity = user.bag?.capacity || 50;
      const current = Object.values(user.inventory).reduce((a, b) => a + b, 0);
      if (current + qty > capacity) return interaction.reply({ content: `💼 Ton sac est plein (${current}/${capacity}). Achète un sac plus grand ou vends tes minerais.`, ephemeral: true });

      // add mineral, reduce durability, update lastMine
      user.inventory[chosen.name] = (user.inventory[chosen.name] || 0) + qty;
      user.pickaxe.durability -= 1;
      user.lastMine = now();
      saveData();

      // reply ephemeral
      let replyText = `⛏️ Tu as miné **${qty} x ${chosen.name}** !`;
      if (user.pickaxe.durability <= 0) replyText += '\n💥 Ta pioche s\'est cassée après cette utilisation !';
      replyText += `\n💼 Sac: ${current + qty}/${capacity}`;
      return interaction.reply({ content: replyText, ephemeral: true });
    }

    // Sell (ephemeral)
    if (interaction.customId === 'sell_action') {
      let total = 0;
      for (const m of MINERALS) {
        const qty = user.inventory[m.name] || 0;
        if (qty > 0) {
          total += qty * m.value;
          user.inventory[m.name] = 0;
        }
      }
      if (total === 0) return interaction.reply({ content: '📦 Tu n\'as aucun minerai à vendre.', ephemeral: true });
      user.coins += total;
      saveData();
      return interaction.reply({ content: `💰 Vente réussie — tu as reçu **${total}** coins.`, ephemeral: true });
    }

  } catch (err) {
    console.error('interactionCreate err', err);
    try { if (!interaction.replied) await interaction.reply({ content: 'Erreur interne.', ephemeral: true }); } catch (e) { /* ignore */ }
  }
});

// ---------- Message Commands ----------
client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const uid = message.author.id;
    ensureUser(uid);
    const user = data.users[uid];

    // HELP
    if (cmd === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('📜 Commandes disponibles')
        .setColor('#8B5CF6')
        .setDescription('Voici les principales commandes :')
        .addFields(
          { name: '+help', value: 'Affiche cette aide' },
          { name: '+profile', value: 'Affiche ton profil' },
          { name: '+daily', value: 'Récompense quotidienne' },
          { name: '+pay @user <montant>', value: 'Envoyer des coins à un joueur' },
          { name: '+createclan <nom>', value: `Créer un clan (coût: ${CLAN_CREATE_COST} coins)` },
          { name: '+joinclan <nom>', value: 'Rejoindre un clan' },
          { name: '+leaveclan', value: 'Quitter son clan' },
          { name: '+claninfo <nom?>', value: 'Voir info clan' },
          { name: '+deposit <montant>', value: 'Déposer dans la banque du clan' },
          { name: '+withdraw <montant>', value: 'Retirer (seul le chef)' },
          { name: '+war <nomClan>', value: 'Déclarer la guerre (seul le chef)' },
          { name: '+sell <Minerai> <qty>', value: 'Vendre manuellement un minerai' },
          { name: '+resetembeds', value: 'Réinitialiser les embeds Shop/Minage/Vente' },
          { name: '+leaderboard', value: 'Classement par coins' }
        );
      return message.channel.send({ embeds: [embed] });
    }

    // PROFILE
    if (cmd === 'profile' || cmd === 'profil') {
      const invLines = MINERALS.map(m => `${m.name}: ${user.inventory[m.name] || 0}`).join('\n') || 'Aucune ressource';
      const embed = new EmbedBuilder()
        .setTitle(`👤 Profil — ${message.author.username}`)
        .setColor('#06B6D4')
        .addFields(
          { name: '💰 Coins', value: `${user.coins}`, inline: true },
          { name: '⛏️ Pioche', value: `${user.pickaxe ? `${user.pickaxe.name} (dur:${user.pickaxe.durability})` : 'Aucune'}`, inline: true },
          { name: '💼 Sac', value: `${user.bag ? `${user.bag.name} (cap:${user.bag.capacity})` : 'Petit sac (50)'}`, inline: true },
          { name: '📦 Inventaire', value: invLines }
        )
        .setFooter({ text: `Clan: ${user.clan || 'Aucun'}` });
      return message.channel.send({ embeds: [embed] });
    }

    // DAILY
    if (cmd === 'daily') {
      const last = user.lastDaily || 0;
      const DAY_MS = 24 * 60 * 60 * 1000;
      if (now() - last < DAY_MS) return message.reply('⏳ Daily déjà récupéré aujourd\'hui — reviens demain.');
      const gain = 50;
      user.coins += gain;
      user.lastDaily = now();
      saveData();
      return message.reply(`🎁 Daily pris : +${gain} coins`);
    }

    // PAY
    if (cmd === 'pay') {
      const member = message.mentions.users.first();
      const amount = parseInt(args[1] || args[0]);
      if (!member || isNaN(amount) || amount <= 0) return message.reply('Usage: +pay @user <montant>');
      ensureUser(member.id);
      if (user.coins < amount) return message.reply('❌ Tu n\'as pas assez de coins.');
      user.coins -= amount;
      data.users[member.id].coins += amount;
      saveData();
      return message.reply(`✅ Paiement effectué : ${amount} coins envoyés à ${member.username}`);
    }

    // CREATECLAN / JOIN / LEAVE / CLANINFO / DEPOSIT / WITHDRAW / WAR
    // (Same implementations as before — kept intact)

    if (cmd === 'createclan') {
      const name = args.join(' ').trim();
      if (!name) return message.reply('Usage: +createclan <nom>');
      if (user.clan) return message.reply('Tu es déjà dans un clan.');
      if (data.clans[name]) return message.reply('Un clan avec ce nom existe déjà.');
      if (user.coins < CLAN_CREATE_COST) return message.reply(`Il faut ${CLAN_CREATE_COST} coins pour créer un clan.`);
      user.coins -= CLAN_CREATE_COST;
      data.clans[name] = { name, leader: message.author.id, members: [message.author.id], bank: 0 };
      user.clan = name;
      saveData();
      return message.reply(`✅ Clan **${name}** créé. Tu en es le chef.`);
    }

    if (cmd === 'joinclan') {
      const name = args.join(' ').trim();
      if (!name) return message.reply('Usage: +joinclan <nom>');
      const clan = data.clans[name];
      if (!clan) return message.reply('Clan introuvable.');
      if (user.clan) return message.reply('Tu es déjà dans un clan.');
      clan.members.push(message.author.id);
      user.clan = name;
      saveData();
      return message.reply(`✅ Tu as rejoint le clan **${name}**.`);
    }

    if (cmd === 'leaveclan') {
      const cname = user.clan;
      if (!cname) return message.reply('Tu n\'es dans aucun clan.');
      const clan = data.clans[cname];
      const idx = clan.members.indexOf(message.author.id);
      if (idx !== -1) clan.members.splice(idx, 1);
      if (clan.leader === message.author.id) {
        if (clan.members.length > 0) clan.leader = clan.members[0];
        else delete data.clans[cname];
      }
      user.clan = null;
      saveData();
      return message.reply('Tu as quitté ton clan.');
    }

    if (cmd === 'claninfo') {
      const name = args.join(' ') || user.clan;
      if (!name) return message.reply('Usage: +claninfo <nom>, ou +claninfo pour ton clan.');
      const clan = data.clans[name];
      if (!clan) return message.reply('Clan introuvable.');
      const leaderUser = await client.users.fetch(clan.leader).catch(() => null);
      const embed = new EmbedBuilder()
        .setTitle(`🏰 Clan — ${clan.name}`)
        .setColor('#F97316')
        .addFields(
          { name: 'Chef', value: leaderUser ? leaderUser.username : 'Inconnu', inline: true },
          { name: 'Membres', value: `${clan.members.length}`, inline: true },
          { name: 'Banque', value: `${clan.bank} coins`, inline: true }
        );
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd === 'deposit') {
      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount <= 0) return message.reply('Usage: +deposit <montant>');
      if (!user.clan) return message.reply('Tu n\'es dans aucun clan.');
      if (user.coins < amount) return message.reply('Tu n\'as pas assez de coins.');
      data.clans[user.clan].bank += amount;
      user.coins -= amount;
      saveData();
      return message.reply(`✅ Tu as déposé ${amount} coins dans la banque du clan.`);
    }

    if (cmd === 'withdraw') {
      const amount = parseInt(args[0]);
      if (isNaN(amount) || amount <= 0) return message.reply('Usage: +withdraw <montant>');
      if (!user.clan) return message.reply('Tu n\'es dans aucun clan.');
      const clan = data.clans[user.clan];
      if (clan.leader !== message.author.id) return message.reply('Seul le chef peut retirer de la banque.');
      if (clan.bank < amount) return message.reply('La banque du clan n\'a pas assez.');
      clan.bank -= amount;
      user.coins += amount;
      saveData();
      return message.reply(`✅ Retrait effectué : ${amount} coins.`);
    }

    if (cmd === 'war') {
      const targetName = args.join(' ').trim();
      if (!targetName) return message.reply('Usage: +war <nomClanCible>');
      if (!user.clan) return message.reply('Tu dois être dans un clan pour déclarer la guerre.');
      const myClan = data.clans[user.clan];
      if (myClan.leader !== message.author.id) return message.reply('Seul le chef peut déclarer la guerre.');
      const targetClan = data.clans[targetName];
      if (!targetClan) return message.reply('Clan cible introuvable.');
      if (targetName === user.clan) return message.reply('Tu ne peux pas attaquer ton propre clan.');

      const myCoins = clanTotalCoins(user.clan);
      const targetCoins = clanTotalCoins(targetName);
      const chance = myCoins / (myCoins + targetCoins || 1);
      const roll = Math.random();
      const stake = Math.max(100, Math.floor(0.1 * Math.min(myCoins, targetCoins)));
      if (roll < chance) {
        const stolen = Math.min(stake, targetClan.bank);
        targetClan.bank -= stolen;
        myClan.bank += stolen;
        saveData();
        return message.reply(`⚔️ Victoire ! Votre clan a volé ${stolen} coins à **${targetName}**.`);
      } else {
        const lost = Math.min(stake, myClan.bank);
        myClan.bank -= lost;
        targetClan.bank += lost;
        saveData();
        return message.reply(`❌ Défaite... Votre clan a perdu ${lost} coins au profit de **${targetName}**.`);
      }
    }

    // SELL manual
    if (cmd === 'sell') {
      const mineralNameInput = args[0];
      const qty = parseInt(args[1]);
      if (!mineralNameInput || isNaN(qty) || qty <= 0) return message.reply('Usage: +sell <Minerai> <quantité> (ex: +sell Diamant 2)');
      const mineral = MINERALS.find(m => m.name.toLowerCase() === mineralNameInput.toLowerCase());
      if (!mineral) return message.reply('Minerai inconnu.');
      const owned = user.inventory[mineral.name] || 0;
      if (owned < qty) return message.reply('Tu n\'as pas autant de minerais.');
      user.inventory[mineral.name] -= qty;
      const total = qty * mineral.value;
      user.coins += total;
      saveData();
      return message.reply(`💰 Tu as vendu ${qty} x ${mineral.name} pour ${total} coins.`);
    }

    // RESET EMBEDS
    if (cmd === 'resetembeds') {
      const shop = message.guild.channels.cache.find(c => c.name === '🛒-shop');
      const minage = message.guild.channels.cache.find(c => c.name === '⛏️-minage');
      const sell = message.guild.channels.cache.find(c => c.name === '💰-vente');

      if (shop) { await resetChannelBotMessages(shop); await sendShopEmbed(shop); }
      if (minage) { await resetChannelBotMessages(minage); await sendMineEmbed(minage); }
      if (sell) { await resetChannelBotMessages(sell); await sendSellEmbed(sell); }

      return message.reply('♻️ Embeds réinitialisés.');
    }

    // LEADERBOARD
    if (cmd === 'leaderboard' || cmd === 'lb') {
      const arr = Object.entries(data.users).map(([id, u]) => ({ id, coins: u.coins || 0 }));
      arr.sort((a, b) => b.coins - a.coins);
      const top = arr.slice(0, 10);
      const lines = await Promise.all(top.map(async (t, idx) => {
        const userObj = await client.users.fetch(t.id).catch(() => ({ username: 'Inconnu' }));
        return `#${idx + 1} — ${userObj.username} : ${t.coins} coins`;
      }));
      const embed = new EmbedBuilder().setTitle('🏆 Leaderboard — Coins').setDescription(lines.join('\n') || 'Aucun joueur').setColor('#FACC15');
      return message.channel.send({ embeds: [embed] });
    }

    saveData();
  } catch (err) {
    console.error('messageCreate err', err);
    try { message.reply('Erreur interne lors de l\'exécution de la commande.'); } catch (e) { /* ignore */ }
  }
});

client.login(process.env.TOKEN);
