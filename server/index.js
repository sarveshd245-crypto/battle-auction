
import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import { GoogleGenerativeAI } from '@google/generative-ai';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rooms = new Map();
const turnTimers = new Map();
const revealTimers = new Map();
const genreCache = new Map();
const imageCache = new Map();

const GENRES = [
  'Ramayana', 'Mahabharata', 'Football', 'Cricket',
  'Marvel', 'DC', 'Harry Potter', 'Anime'
];

const SEED_CHARACTERS = [
  {
    id: 'marvel-spider-man', name: 'Spider-Man', universe: 'Marvel',
    version: 'Earth-616', rating: 88,
    abilities: ['Spider-sense', 'Agility', 'Web-slinging'],
    strengths: ['Mobility', 'Reflexes', 'Improvisation'],
    weaknesses: ['Human-level durability'],
    description: 'Peter Parker is a brilliant hero with extraordinary agility and danger awareness.',
    combatStyle: 'Fast, mobile and improvisational', sources: []
  },
  {
    id: 'marvel-iron-man', name: 'Iron Man', universe: 'Marvel',
    version: 'Earth-616', rating: 91,
    abilities: ['Powered armour', 'Repulsors', 'Flight'],
    strengths: ['Technology', 'Range', 'Adaptability'],
    weaknesses: ['Armour dependence'],
    description: 'Tony Stark is an inventor who uses advanced powered armour.',
    combatStyle: 'Technology-driven ranged combat', sources: []
  },
  {
    id: 'marvel-thor', name: 'Thor', universe: 'Marvel',
    version: 'Earth-616', rating: 96,
    abilities: ['Asgardian physiology', 'Mjolnir', 'Lightning'],
    strengths: ['Durability', 'Strength', 'Energy projection'],
    weaknesses: ['Version-dependent limits'],
    description: 'Thor is an Asgardian warrior with immense strength.',
    combatStyle: 'Powerful close combat and storm-based attacks', sources: []
  },
  {
    id: 'dc-batman', name: 'Batman', universe: 'DC',
    version: 'Main continuity', rating: 87,
    abilities: ['Detective skills', 'Martial arts', 'Technology'],
    strengths: ['Preparation', 'Strategy', 'Stealth'],
    weaknesses: ['Human physiology'],
    description: 'Bruce Wayne is a highly trained detective and strategist.',
    combatStyle: 'Strategic and technical', sources: []
  },
  {
    id: 'dc-superman', name: 'Superman', universe: 'DC',
    version: 'Main continuity', rating: 98,
    abilities: ['Flight', 'Super strength', 'Heat vision'],
    strengths: ['Speed', 'Durability', 'Power'],
    weaknesses: ['Continuity-dependent vulnerabilities'],
    description: 'Clark Kent is a Kryptonian with exceptional strength and speed.',
    combatStyle: 'High-power physical and ranged combat', sources: []
  },
  {
    id: 'dc-wonder-woman', name: 'Wonder Woman', universe: 'DC',
    version: 'Main continuity', rating: 94,
    abilities: ['Amazonian abilities', 'Combat skill', 'Lasso'],
    strengths: ['Combat', 'Durability', 'Leadership'],
    weaknesses: ['Continuity-dependent limits'],
    description: 'Diana is an Amazonian warrior known for her strength and combat experience.',
    combatStyle: 'Disciplined close combat', sources: []
  }
];

// --------------------------------------------------
// CURATED EPIC CHARACTER DATABASES
// --------------------------------------------------

const EPIC_CHARACTERS = {
  Ramayana: [
    ['Rama',98,'Prince of Ayodhya and skilled warrior and archer'],
    ['Lakshmana',94,'Brother of Rama and powerful warrior'],
    ['Bharata',88,'Brother of Rama and warrior prince'],
    ['Shatrughna',87,'Brother of Rama and warrior prince'],
    ['Hanuman',99,'Powerful Vanara warrior with extraordinary strength'],
    ['Ravana',98,'King of Lanka and formidable warrior'],
    ['Kumbhakarna',95,'Powerful warrior and brother of Ravana'],
    ['Indrajit',97,'Son of Ravana and master of celestial weapons'],
    ['Vibhishana',87,'Brother of Ravana who fought alongside Rama'],
    ['Sugriva',90,'Vanara king and warrior ally of Rama'],
    ['Vali',96,'Extremely powerful Vanara warrior and king'],
    ['Angada',91,'Son of Vali and skilled Vanara warrior'],
    ['Jambavan',92,'Experienced warrior and leader of the bear army'],
    ['Jatayu',86,'Warrior bird who fought to protect Sita'],
    ['Garuda',98,'Divine warrior bird with immense power'],
    ['Maricha',85,'Rakshasa warrior with magical abilities'],
    ['Subahu',83,'Rakshasa warrior who fought against Rama'],
    ['Tataka',85,'Powerful Rakshasi warrior'],
    ['Nala',87,'Vanara warrior and bridge builder'],
    ['Nila',87,'Vanara warrior and commander'],
    ['Prahasta',91,'Chief commander of Ravana’s army'],
    ['Akampana',85,'Rakshasa warrior in Ravana’s army'],
    ['Atikaya',92,'Powerful son of Ravana and warrior'],
    ['Narantaka',87,'Son of Ravana and warrior'],
    ['Devantaka',88,'Son of Ravana and powerful fighter'],
    ['Trishira',87,'Three-headed warrior in Ravana’s army'],
    ['Mahodara',85,'Rakshasa commander of Lanka'],
    ['Mahaparshva',85,'Rakshasa warrior and commander'],
    ['Dhumraksha',86,'Rakshasa general in Ravana’s army'],
    ['Vajradamshtra',86,'Powerful Rakshasa warrior'],
    ['Kumbha',89,'Son of Kumbhakarna and warrior of Lanka'],
    ['Nikumbha',88,'Son of Kumbhakarna and Rakshasa warrior'],
    ['Mainda',85,'Vanara warrior in Rama’s army'],
    ['Dvivida',86,'Vanara warrior and commander'],
    ['Gavaksha',84,'Vanara commander in Rama’s army'],
    ['Gaja',84,'Vanara warrior and commander'],
    ['Rishabha',84,'Vanara warrior who fought in Lanka'],
    ['Sushena',85,'Vanara commander and warrior'],
    ['Makaraksha',87,'Son of Khara and Rakshasa warrior'],
    ['Virupaksha',84,'Rakshasa warrior of Lanka']
  ],
  Mahabharata: [
    ['Krishna',100,'Strategist and guide who played a key role in the war'],
    ['Arjuna',99,'Legendary archer and one of the greatest warriors'],
    ['Karna',98,'Legendary archer and formidable warrior'],
    ['Bhishma',99,'Grand commander and master of warfare'],
    ['Drona',97,'Master of archery and military strategy'],
    ['Ashwatthama',96,'Powerful warrior and son of Drona'],
    ['Bhima',97,'Pandava warrior known for immense strength'],
    ['Yudhishthira',91,'Pandava warrior and skilled fighter'],
    ['Nakula',90,'Pandava warrior skilled in swordsmanship'],
    ['Sahadeva',90,'Pandava warrior and skilled fighter'],
    ['Duryodhana',96,'Kaurava leader and master of mace fighting'],
    ['Dushasana',88,'Kaurava warrior and brother of Duryodhana'],
    ['Abhimanyu',96,'Young warrior renowned for entering the Chakravyuha'],
    ['Ghatotkacha',96,'Powerful warrior and son of Bhima'],
    ['Balarama',97,'Master of mace fighting and powerful warrior'],
    ['Satyaki',93,'Skilled Yadava warrior allied with the Pandavas'],
    ['Kripacharya',94,'Experienced warrior and master of weapons'],
    ['Shikhandi',90,'Warrior who played a key role against Bhishma'],
    ['Dhrishtadyumna',94,'Commander of the Pandava army'],
    ['Parashurama',100,'Legendary warrior and master of weapons'],
    ['Ekalavya',94,'Exceptional archer known for his dedication'],
    ['Jayadratha',89,'King and warrior who fought for the Kauravas'],
    ['Barbarika',99,'Legendary warrior with extraordinary archery skills'],
    ['Uttara Kumara',85,'Prince and warrior of the Matsya kingdom'],
    ['Virata',88,'King of Matsya and warrior'],
    ['Drupada',90,'King of Panchala and experienced warrior'],
    ['Pandu',89,'Father of the Pandavas and skilled archer'],
    ['Somadatta',87,'Kuru-side warrior'],
    ['Bhagadatta',94,'King and elephant-warrior who fought for the Kauravas'],
    ['Shalya',93,'King of Madra and powerful warrior'],
    ['Kritavarma',91,'Yadava warrior who fought for the Kauravas'],
    ['Bhurishravas',91,'Experienced Kuru-side warrior'],
    ['Vikarna',86,'Kaurava warrior and brother of Duryodhana'],
    ['Alambusha',90,'Rakshasa warrior who fought in the Kurukshetra war'],
    ['Bahlika',88,'Elder Kuru warrior and king'],
    ['Sudakshina',87,'King of Kamboja and warrior'],
    ['Brihadbala',88,'King of Kosala who fought in the war'],
    ['Susharma',88,'King of Trigarta and warrior'],
    ['Chekitana',89,'Warrior who fought on the Pandava side'],
    ['Yuyutsu',85,'Kaurava brother who fought for the Pandavas']
  ]
};

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function shuffle(list) {
  const array = [...list];
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function slugify(value) {
  return String(value).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function safeText(value, fallback = '') {
  return String(value || fallback).trim().slice(0, 1000);
}

function cleanList(value) {
  if (Array.isArray(value)) {
    return value.map(x => String(x).trim()).filter(Boolean).slice(0, 12);
  }
  if (typeof value === 'string') {
    return value.split(',').map(x => x.trim()).filter(Boolean).slice(0, 12);
  }
  return [];
}

function extractJSON(value) {
  const cleaned = String(value || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error('Gemini returned invalid JSON.');
  }
}

function normalizeCharacter(raw, genre) {
  if (!raw || typeof raw !== 'object') return null;

  const name = String(raw.name || '').trim().slice(0, 80);
  if (!name) return null;

  const rating = Math.round(Number(raw.rating));

  return {
    id: `${slugify(genre)}-${slugify(name)}`,
    name,
    universe: genre,
    version: String(raw.version || 'General version').slice(0, 100),
    rating: Number.isFinite(rating) ? Math.max(1, Math.min(100, rating)) : 70,
    abilities: cleanList(raw.abilities),
    strengths: cleanList(raw.strengths),
    weaknesses: cleanList(raw.weaknesses),
    description: String(raw.description || '').slice(0, 500),
    combatStyle: String(raw.combatStyle || 'Versatile').slice(0, 150),
    sources: [],
    imageUrl: null
  };
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}

function getGeminiModel() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini API key is missing. Add GEMINI_API_KEY in Render.');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  return genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.3
    }
  });
}

// Retries temporary errors. A hard quota exhaustion cannot be fixed by retrying.
async function generateWithRetry(model, prompt, label = 'Gemini') {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await model.generateContent(prompt);
    } catch (error) {
      lastError = error;
      const message = String(error.message || '').toLowerCase();

      const quotaExhausted =
        message.includes('quota exceeded') ||
        message.includes('billing') ||
        message.includes('limit: 0');

      if (quotaExhausted) {
        throw new Error(
          `${label}: Gemini API quota is exhausted. Check Google AI Studio usage and billing.`
        );
      }

      if (attempt === 3) break;

      const delay = attempt * 2500;
      console.warn(`${label} attempt ${attempt} failed. Retrying in ${delay}ms.`);
      await sleep(delay);
    }
  }

  throw lastError || new Error(`${label} failed.`);
}

// --------------------------------------------------
// CHARACTER IMAGE LOOKUP
// --------------------------------------------------

async function getWikipediaImage(character) {
  const cacheKey = `${character.universe}:${character.name}`.toLowerCase();

  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);

  const promise = (async () => {
    try {
      const url = new URL('https://en.wikipedia.org/w/api.php');
      url.searchParams.set('action', 'query');
      url.searchParams.set('generator', 'search');
      url.searchParams.set('gsrsearch', `${character.name} ${character.universe}`);
      url.searchParams.set('gsrnamespace', '0');
      url.searchParams.set('gsrlimit', '5');
      url.searchParams.set('prop', 'pageimages');
      url.searchParams.set('piprop', 'thumbnail');
      url.searchParams.set('pithumbsize', '700');
      url.searchParams.set('format', 'json');

      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'BattleAuctionGame/1.0' }
      });

      if (!response.ok) return null;

      const data = await response.json();
      const pages = Object.values(data.query?.pages || {});
      if (!pages.length) return null;

      const name = character.name.toLowerCase();
      const best = pages.find(p =>
        String(p.title || '').toLowerCase().includes(name)
      ) || pages[0];

      return best.thumbnail?.source || null;
    } catch (error) {
      console.warn(`Image lookup failed for ${character.name}:`, error.message);
      return null;
    }
  })();

  imageCache.set(cacheKey, promise);
  return promise;
}

async function attachCharacterImages(room) {
  const characters = room.characters;
  let nextIndex = 0;
  const workerCount = Math.min(5, characters.length);

  async function worker() {
    while (nextIndex < characters.length) {
      const index = nextIndex++;
      characters[index].imageUrl = await getWikipediaImage(characters[index]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (rooms.has(room.code)) emitRoom(room);
}

// --------------------------------------------------
// CHARACTER GENERATION
// --------------------------------------------------

function makeEpicSeedCharacters(genre) {
  return (EPIC_CHARACTERS[genre] || []).map(([name, rating, description]) => ({
    id: `${slugify(genre)}-${slugify(name)}`,
    name,
    universe: genre,
    version: 'Traditional epic',
    rating,
    abilities: ['Traditional epic combat abilities', 'Warfare and strategy'],
    strengths: ['Experience', 'Courage', 'Combat skill'],
    weaknesses: ['Depends on the version and interpretation'],
    description,
    combatStyle: 'Traditional epic warrior',
    sources: [],
    imageUrl: null
  }));
}

async function generateGenreCharacters(genre) {
  if (genre === 'Ramayana' || genre === 'Mahabharata') {
    return makeEpicSeedCharacters(genre);
  }

  const generated = [];
  const seen = new Set();

  function addCharacter(character) {
    if (!character) return;

    const key = String(character.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

    if (!key || seen.has(key)) return;
    seen.add(key);
    generated.push(character);
  }

  SEED_CHARACTERS
    .filter(item => item.universe === genre)
    .forEach(item => addCharacter(clone(item)));

  if (!process.env.GEMINI_API_KEY) {
    throw new Error(`A Gemini API key is required to generate ${genre} characters.`);
  }

  const model = getGeminiModel();

  // Five smaller batches reduce response size and improve reliability.
  for (let batch = 0; batch < 5 && generated.length < 100; batch++) {
    const count = Math.min(20, 100 - generated.length);
    const existingNames = generated.map(c => c.name).join(', ');

    const prompt = `
Generate ${count} additional established and distinct characters from "${genre}".

Do not repeat these names: ${existingNames}

Use established characters only. Do not invent characters.
For Football and Cricket, use real established players.
For Marvel and DC, use established comic-book characters.
For Harry Potter, use established characters from the books and films.
For Anime, use established characters from anime series.

Return JSON only:
{
  "characters": [
    {
      "name": "Character name",
      "version": "Series or version",
      "rating": 85,
      "abilities": ["Ability 1"],
      "strengths": ["Strength 1"],
      "weaknesses": ["Weakness 1"],
      "description": "Short description",
      "combatStyle": "Style"
    }
  ]
}`;

    try {
      const result = await generateWithRetry(
        model,
        prompt,
        `${genre} character batch ${batch + 1}`
      );

      const parsed = extractJSON(result.response.text());
      const entries = Array.isArray(parsed.characters) ? parsed.characters : [];

      for (const raw of entries) {
        addCharacter(normalizeCharacter(raw, genre));
        if (generated.length >= 100) break;
      }

      if (!entries.length) {
        console.warn(`${genre}: Gemini returned an empty batch.`);
        break;
      }
    } catch (error) {
      console.warn(`${genre} generation stopped:`, error.message);
      break;
    }
  }

  console.log(`${genre}: ${generated.length} unique characters available`);

  if (generated.length < 10) {
    throw new Error(
      `${genre} produced only ${generated.length} characters. Check Gemini quota or select another genre.`
    );
  }

  return generated.slice(0, 100);
}

async function getGenreCharacters(genre) {
  if (!GENRES.includes(genre)) {
    throw new Error(`Unsupported genre: ${genre}`);
  }

  if (genreCache.has(genre)) return genreCache.get(genre);

  const promise = generateGenreCharacters(genre);

  try {
    const characters = await promise;

    // Cache curated epic pools and complete generated pools only.
    const isEpic = genre === 'Ramayana' || genre === 'Mahabharata';
    if (isEpic || characters.length >= 100) {
      genreCache.set(genre, Promise.resolve(characters));
    }

    // Partial pools are deliberately not cached. A later attempt can retry.
    return characters;
  } catch (error) {
    genreCache.delete(genre);
    throw error;
  }
}

// --------------------------------------------------
// ROOM STATE
// --------------------------------------------------

function publicRoom(room, viewerId) {
  const showAllTeams = room.status === 'championship';

  const connectedPlayers = room.players.filter(p => p.connected);
  const currentTurnIndex = connectedPlayers.findIndex(
    p => p.id === room.currentTurnPlayerId
  );

  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    settings: room.settings,
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      budget: player.budget,
      team: showAllTeams || player.id === viewerId ? player.team : [],
      connected: player.connected
    })),
    characters: room.characters,
    characterIndex: room.characterIndex,
    currentCharacter: room.currentCharacter,
    currentBid: room.currentBid,
    highestBidderId: room.highestBidderId,
    lastBidderId: room.lastBidderId,
    currentTurnPlayerId: room.currentTurnPlayerId,
    currentTurnIndex: Math.max(0, currentTurnIndex),
    turnDeadline: room.turnDeadline,
    noIncreaseTurns: room.noIncreaseTurns,
    openingPlayerId: room.openingPlayerId,
    nextOpeningPlayerId: room.nextOpeningPlayerId,
    auctionLog: room.auctionLog,
    results: room.results,
    championship: room.championship,
    reserveCount: room.reserveCharacters.length,
    completionError: room.completionError,
    stateVersion: room.stateVersion || 0,
    serverTime: Date.now()
  };
}

function emitRoom(room) {
  room.stateVersion = (room.stateVersion || 0) + 1;

  for (const player of room.players) {
    io.to(player.id).emit('room:update', publicRoom(room, player.id));
  }
}

function stopTimer(code) {
  const timer = turnTimers.get(code);
  if (timer) clearTimeout(timer);
  turnTimers.delete(code);
}

function activePlayers(room) {
  return room.players.filter(player => player.connected);
}

function findRoomForSocket(socketId) {
  return [...rooms.values()].find(room =>
    room.players.some(player => player.id === socketId)
  );
}

function findPlayer(room, playerId) {
  return room.players.find(player => player.id === playerId);
}

function canBid(player, room) {
  return Boolean(
    player &&
    player.connected &&
    player.team.length < room.settings.teamSize &&
    player.budget >= room.currentBid + 1
  );
}

// --------------------------------------------------
// AUCTION TURN MANAGEMENT
// --------------------------------------------------

function getNextEligiblePlayer(room, afterPlayerId) {
  const players = room.players;
  if (!players.length) return null;

  const startIndex = players.findIndex(p => p.id === afterPlayerId);

  for (let step = 1; step <= players.length; step++) {
    const index = (Math.max(startIndex, -1) + step) % players.length;
    const player = players[index];

    if (!player.connected) continue;
    if (player.id === room.highestBidderId) continue;
    if (room.passedPlayerIds.has(player.id)) continue;
    if (!canBid(player, room)) continue;

    return player;
  }

  return null;
}

function finishTurnCycle(room) {
  if (room.status !== 'auction') return;

  const nextPlayer = getNextEligiblePlayer(room, room.currentTurnPlayerId);

  if (!nextPlayer) {
    resolveAuction(room);
    return;
  }

  room.currentTurnPlayerId = nextPlayer.id;
  beginTurn(room);
}

function beginTurn(room) {
  stopTimer(room.code);
  if (room.status !== 'auction') return;

  if (!activePlayers(room).length) {
    room.turnDeadline = null;
    room.currentTurnPlayerId = null;
    room.status = 'auction_paused';
    emitRoom(room);
    return;
  }

  let currentPlayer = findPlayer(room, room.currentTurnPlayerId);

  const eligible =
    currentPlayer &&
    currentPlayer.connected &&
    currentPlayer.id !== room.highestBidderId &&
    !room.passedPlayerIds.has(currentPlayer.id) &&
    canBid(currentPlayer, room);

  if (!eligible) {
    currentPlayer = getNextEligiblePlayer(room, room.currentTurnPlayerId);
  }

  if (!currentPlayer) {
    resolveAuction(room);
    return;
  }

  room.currentTurnPlayerId = currentPlayer.id;
  room.turnDeadline = Date.now() + room.settings.turnSeconds * 1000;
  room.turnToken = (room.turnToken || 0) + 1;

  const token = room.turnToken;
  const deadline = room.turnDeadline;

  emitRoom(room);

  const timer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);

    if (!currentRoom || currentRoom.status !== 'auction') return;
    if (currentRoom.turnToken !== token) return;
    if (currentRoom.turnDeadline !== deadline) return;

    passTurn(currentRoom, 'TIMEOUT');
  }, room.settings.turnSeconds * 1000 + 100);

  turnTimers.set(room.code, timer);
}

function passTurn(room, reason = 'SKIP') {
  if (room.status !== 'auction') return;

  stopTimer(room.code);

  const player = findPlayer(room, room.currentTurnPlayerId);
  if (player) room.passedPlayerIds.add(player.id);

  room.noIncreaseTurns = room.passedPlayerIds.size;

  room.auctionLog.push({
    type: reason,
    playerId: player?.id || null,
    at: Date.now()
  });

  room.turnDeadline = null;
  finishTurnCycle(room);
}

// --------------------------------------------------
// RESOLVE CURRENT AUCTION
// --------------------------------------------------

function resolveAuction(room) {
  if (room.status !== 'auction' || !room.currentCharacter) return;

  stopTimer(room.code);

  const character = clone(room.currentCharacter);
  const winner = findPlayer(room, room.lastBidderId);

  let awarded = false;

  if (
    winner &&
    winner.connected &&
    winner.budget >= room.currentBid &&
    winner.team.length < room.settings.teamSize
  ) {
    winner.budget -= room.currentBid;
    winner.team.push({ ...character, paid: room.currentBid });

    room.results.push({
      characterId: character.id,
      characterName: character.name,
      winnerId: winner.id,
      winnerName: winner.name,
      amount: room.currentBid
    });

    awarded = true;
  }

  if (!awarded) {
    room.reserveCharacters.push(character);

    room.results.push({
      characterId: character.id,
      characterName: character.name,
      winnerId: null,
      winnerName: null,
      amount: 0
    });
  }

  room.auctionLog.push({
    type: 'RESOLVED',
    characterId: character.id,
    winnerId: awarded ? winner.id : null,
    at: Date.now()
  });

  room.nextOpeningPlayerId = awarded
    ? winner.id
    : (room.openingPlayerId || room.hostId);

  room.currentCharacter = null;
  room.turnDeadline = null;
  room.currentTurnPlayerId = null;
  room.currentBid = room.settings.startingBid;
  room.highestBidderId = null;
  room.lastBidderId = null;
  room.noIncreaseTurns = 0;
  room.passedPlayerIds = new Set();
  room.currentTurnIndex = 0;
  room.status = 'auction_ready';

  if (room.characterIndex >= room.characters.length - 1) {
    completeAuction(room);
    return;
  }

  emitRoom(room);
}

// --------------------------------------------------
// FREE CHARACTER ALLOCATION AND TEAM REVEAL
// --------------------------------------------------

function completeAuction(room) {
  if (
    room.status !== 'auction_ready' &&
    room.status !== 'auction'
  ) return;

  stopTimer(room.code);

  const emptySlots = [];

  for (const player of room.players) {
    while (player.team.length < room.settings.teamSize) {
      emptySlots.push(player);
    }
  }

  const assignedIds = new Set(
    room.players.flatMap(player => player.team.map(character => character.id))
  );

  const availableCharacters = room.characters.filter(
    character => !assignedIds.has(character.id)
  );

  const freePool = shuffle(availableCharacters);

  if (freePool.length < emptySlots.length) {
    room.status = 'incomplete';
    room.currentCharacter = null;
    room.turnDeadline = null;
    room.completionError =
      `Not enough unused characters. ${emptySlots.length} slots are empty, but only ${freePool.length} characters remain.`;
    emitRoom(room);
    return;
  }

  emptySlots.forEach((player, index) => {
    player.team.push({
      ...clone(freePool[index]),
      paid: 0,
      allocatedFree: true
    });
  });

  room.reserveCharacters = freePool.slice(emptySlots.length);
  room.currentCharacter = null;
  room.turnDeadline = null;
  room.currentTurnPlayerId = null;
  room.completionError = null;
  room.status = 'team_reveal';

  emitRoom(room);

  const oldTimer = revealTimers.get(room.code);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);

    if (!currentRoom || currentRoom.status !== 'team_reveal') return;

    currentRoom.status = 'ready_for_fight';
    revealTimers.delete(room.code);
    emitRoom(currentRoom);
  }, 10000);

  revealTimers.set(room.code, timer);
}

// --------------------------------------------------
// TEAM STRENGTH AND COMBINED STANDINGS
// --------------------------------------------------

function calculateTeamStrength(team) {
  if (!team.length) return 0;

  const ratings = team.reduce(
    (total, character) => total + Number(character.rating || 0),
    0
  );

  const strengths = new Set(
    team.flatMap(character => character.strengths || [])
  );

  const abilities = new Set(
    team.flatMap(character => character.abilities || [])
  );

  const synergy = Math.min(
    5,
    Math.floor((strengths.size + abilities.size) / team.length)
  );

  return Math.max(0, Math.min(100, Math.round(ratings / team.length + synergy)));
}

/*
  OPTION C - COMBINED CHAMPIONSHIP

  70% = normalized head-to-head match points
  30% = overall team evaluation score

  A win = 3 match points
  A draw = 1 match point
  A loss = 0 match points

  Maximum possible match points = 3 x (number of opponents).
*/

function calculateStandings(room, matches, evaluations = []) {
  const evaluationMap = new Map(
    evaluations.map(evaluation => [evaluation.playerId, evaluation])
  );

  const maxMatchPoints = Math.max(1, 3 * (room.players.length - 1));

  const standings = room.players.map(player => {
    const played = matches.filter(match =>
      match.teamAId === player.id || match.teamBId === player.id
    );

    const wins = played.filter(match => match.winnerId === player.id).length;
    const draws = played.filter(match => match.result === 'DRAW').length;
    const losses = played.length - wins - draws;
    const points = wins * 3 + draws;

    const scoreDifference = played.reduce((total, match) => {
      return total + (
        match.teamAId === player.id
          ? match.scoreA - match.scoreB
          : match.scoreB - match.scoreA
      );
    }, 0);

    const evaluation = evaluationMap.get(player.id);
    const teamEvaluationScore = Number(
      evaluation?.score ?? calculateTeamStrength(player.team)
    );

    const normalizedMatchScore = (points / maxMatchPoints) * 100;

    const combinedScore = Math.round(
      normalizedMatchScore * 0.70 +
      teamEvaluationScore * 0.30
    );

    return {
      playerId: player.id,
      name: player.name,
      wins,
      draws,
      losses,
      points,
      scoreDifference,
      teamStrength: teamEvaluationScore,
      normalizedMatchScore: Number(normalizedMatchScore.toFixed(2)),
      combinedScore,
      aiSummary: evaluation?.summary || '',
      strengths: evaluation?.strengths || [],
      weaknesses: evaluation?.weaknesses || [],
      synergy: evaluation?.synergy || '',
      balance: evaluation?.balance || '',
      vulnerabilities: evaluation?.vulnerabilities || [],
      keyContributions: evaluation?.keyContributions || [],
      rankingRationale: evaluation?.rankingRationale || '',
      team: player.team
    };
  });

  standings.sort((a, b) =>
    b.combinedScore - a.combinedScore ||
    b.points - a.points ||
    b.wins - a.wins ||
    b.scoreDifference - a.scoreDifference ||
    b.teamStrength - a.teamStrength
  );

  let previousKey = null;
  let rank = 0;

  standings.forEach((standing, index) => {
    const key = [
      standing.combinedScore,
      standing.points,
      standing.wins,
      standing.scoreDifference,
      standing.teamStrength
    ].join(':');

    if (key !== previousKey) rank = index + 1;

    standing.rank = rank;
    previousKey = key;
  });

  return standings;
}

// --------------------------------------------------
// LOCAL CHARACTER ANALYSIS FOR EACH MATCHUP
// --------------------------------------------------

function buildCharacterAnalysis(team, opponentTeam) {
  return team.map(character => {
    const advantages = [
      ...(character.strengths || []),
      ...(character.abilities || [])
    ].slice(0, 5);

    const disadvantages = (character.weaknesses || []).slice(0, 5);

    const opponentMatchups = opponentTeam.slice(0, 5).map(opponent => ({
      opponentName: opponent.name,
      advantage: advantages[0]
        ? `${character.name} may benefit from ${advantages[0]}.`
        : 'No specific advantage was supplied in the character data.',
      disadvantage: disadvantages[0]
        ? `${character.name} has the listed limitation: ${disadvantages[0]}.`
        : 'No specific weakness was supplied in the character data.',
      impact: `This is a character-data-based comparison with ${opponent.name}, not a guaranteed outcome.`
    }));

    return {
      characterName: character.name,
      opponentMatchups,
      advantages: advantages.length ? advantages : ['No specific advantage supplied.'],
      disadvantages: disadvantages.length ? disadvantages : ['No specific weakness supplied.'],
      impact: character.description || 'Contribution based on the supplied character profile.',
      tacticalRole: character.combatStyle || 'Role not specified.'
    };
  });
}

// --------------------------------------------------
// FALLBACK CHAMPIONSHIP
// --------------------------------------------------

function createFallbackChampionship(room, errorMessage) {
  const matches = [];

  for (let i = 0; i < room.players.length; i++) {
    for (let j = i + 1; j < room.players.length; j++) {
      const a = room.players[i];
      const b = room.players[j];

      const scoreA = calculateTeamStrength(a.team);
      const scoreB = calculateTeamStrength(b.team);

      let winnerId = null;
      let result = 'DRAW';

      if (scoreA > scoreB) {
        winnerId = a.id;
        result = 'TEAM_A_WINS';
      } else if (scoreB > scoreA) {
        winnerId = b.id;
        result = 'TEAM_B_WINS';
      }

      matches.push({
        teamAId: a.id,
        teamAName: a.name,
        teamBId: b.id,
        teamBName: b.name,
        scoreA,
        scoreB,
        winnerId,
        result,
        explanation:
          `${a.name} received ${scoreA}/100 and ${b.name} received ${scoreB}/100 using the fallback team-strength calculation.`,
        teamAAnalysis: buildCharacterAnalysis(a.team, b.team),
        teamBAnalysis: buildCharacterAnalysis(b.team, a.team),
        analysisStatus: 'fallback'
      });
    }
  }

  const evaluations = room.players.map(player => ({
    playerId: player.id,
    score: calculateTeamStrength(player.team),
    summary: 'Provisional team evaluation based on character ratings and available team attributes.',
    strengths: [],
    weaknesses: [],
    synergy: 'Fallback calculation; detailed Gemini analysis was unavailable.',
    balance: 'Based on the available character ratings.',
    vulnerabilities: [],
    keyContributions: [],
    rankingRationale: 'Provisional ranking using the combined scoring formula.'
  }));

  const standings = calculateStandings(room, matches, evaluations);

  return {
    matches,
    standings,
    totalMatches: matches.length,
    completedAt: Date.now(),
    overallSummary:
      'Gemini could not complete the detailed evaluation. These are provisional results based on character ratings and team attributes.',
    rankingExplanation:
      'The combined formula is still applied, but the team-evaluation component uses the fallback rating calculation.',
    aiEvaluation: {
      provider: 'Gemini',
      status: 'unavailable',
      message: safeText(
        errorMessage,
        'Gemini evaluation failed. Check the server logs and API configuration.'
      )
    },
    rankingRules: [
      'Combined score = 70% normalized head-to-head match points + 30% overall team evaluation.',
      'Match win: 3 points',
      'Match draw: 1 point',
      'Match loss: 0 points',
      'Tiebreakers: combined score, match points, wins, score difference, team evaluation score.',
      'Fallback team evaluation is based on character ratings and team attributes.'
    ]
  };
}

// --------------------------------------------------
// GEMINI CHAMPIONSHIP EVALUATION
// --------------------------------------------------

async function evaluateChampionshipWithGemini(room) {
  const model = getGeminiModel();

  const teams = room.players.map(player => ({
    playerId: player.id,
    playerName: player.name,
    characters: player.team.map(character => ({
      name: character.name,
      genre: character.universe,
      version: character.version,
      rating: character.rating,
      abilities: character.abilities || [],
      strengths: character.strengths || [],
      weaknesses: character.weaknesses || [],
      description: character.description || '',
      style: character.combatStyle || ''
    }))
  }));

  const expectedPairs = [];

  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      expectedPairs.push({
        teamAId: teams[i].playerId,
        teamBId: teams[j].playerId
      });
    }
  }

  // Compact response: Gemini evaluates teams and pair scores.
  // Character-by-character matchup details are then constructed from supplied data.
  const prompt = `
You are a neutral judge for a fictional and sporting team-building championship.

Evaluate all supplied teams and every required head-to-head pair.

Rules:
- Use only supplied character information.
- Do not invent abilities, achievements, equipment or weaknesses.
- Ratings are supporting information, not the only deciding factor.
- Consider team composition, balance, role diversity, strengths, weaknesses and synergy.
- For Football and Cricket, judge sporting skills, positions and team balance.
- For fictional characters, keep the evaluation non-graphic and focused on fictional abilities and strategy.
- Do not automatically favour famous characters.
- Scores must be integers from 1 to 100.
- Matchup winner must match the higher score. Use null for a draw.
- Return every team exactly once and every requested matchup exactly once.

Return JSON only:
{
  "overallSummary": "Short championship summary",
  "teams": [
    {
      "playerId": "EXACT_ID",
      "score": 90,
      "summary": "Team summary",
      "strengths": ["Strength"],
      "weaknesses": ["Weakness"],
      "synergy": "Synergy explanation",
      "balance": "Balance explanation",
      "vulnerabilities": ["Vulnerability"],
      "keyContributions": [
        {"characterName": "Exact character name", "contribution": "Contribution"}
      ],
      "rankingRationale": "Why this team received this evaluation"
    }
  ],
  "matchups": [
    {
      "teamAId": "EXACT_ID",
      "teamBId": "EXACT_ID",
      "scoreA": 85,
      "scoreB": 80,
      "winnerId": "EXACT_ID or null",
      "explanation": "Short matchup explanation"
    }
  ]
}

TEAMS:
${JSON.stringify(teams)}

REQUIRED PAIRS:
${JSON.stringify(expectedPairs)}
`;

  const result = await generateWithRetry(
    model,
    prompt,
    'Championship evaluation'
  );

  const parsed = extractJSON(result.response.text());

  if (!Array.isArray(parsed.teams) || !Array.isArray(parsed.matchups)) {
    throw new Error('Gemini returned an incomplete championship evaluation.');
  }

  const validIds = new Set(room.players.map(p => p.id));
  const evaluationMap = new Map();

  for (const entry of parsed.teams) {
    if (!validIds.has(entry.playerId) || evaluationMap.has(entry.playerId)) {
      throw new Error('Gemini returned an unknown or duplicate team evaluation.');
    }

    const score = Number(entry.score);
    if (!Number.isFinite(score)) {
      throw new Error('Gemini returned an invalid team score.');
    }

    const player = findPlayer(room, entry.playerId);

    const contributions = Array.isArray(entry.keyContributions)
      ? entry.keyContributions.slice(0, 20).map(item => ({
          characterName: safeText(item.characterName, 'Team member'),
          contribution: safeText(item.contribution, 'Contribution not specified.')
        }))
      : [];

    evaluationMap.set(entry.playerId, {
      playerId: entry.playerId,
      score: Math.max(1, Math.min(100, Math.round(score))),
      summary: safeText(entry.summary, 'Team evaluated by Gemini.'),
      strengths: cleanList(entry.strengths),
      weaknesses: cleanList(entry.weaknesses),
      synergy: safeText(entry.synergy),
      balance: safeText(entry.balance),
      vulnerabilities: cleanList(entry.vulnerabilities),
      keyContributions: contributions,
      rankingRationale: safeText(entry.rankingRationale),
      team: player.team
    });
  }

  if (evaluationMap.size !== room.players.length) {
    throw new Error('Gemini did not evaluate every player exactly once.');
  }

  const expectedSet = new Set(
    expectedPairs.map(pair =>
      [pair.teamAId, pair.teamBId].sort().join('|')
    )
  );

  const actualSet = new Set();
  const matches = [];

  for (const entry of parsed.matchups) {
    const aId = entry.teamAId;
    const bId = entry.teamBId;

    if (!validIds.has(aId) || !validIds.has(bId) || aId === bId) {
      throw new Error('Gemini returned an invalid matchup.');
    }

    const key = [aId, bId].sort().join('|');

    if (!expectedSet.has(key) || actualSet.has(key)) {
      throw new Error('Gemini returned a duplicate or unexpected matchup.');
    }

    actualSet.add(key);

    const scoreA = Number(entry.scoreA);
    const scoreB = Number(entry.scoreB);

    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) {
      throw new Error('Gemini returned invalid matchup scores.');
    }

    const cleanScoreA = Math.max(1, Math.min(100, Math.round(scoreA)));
    const cleanScoreB = Math.max(1, Math.min(100, Math.round(scoreB)));

    let winnerId = null;
    let result = 'DRAW';

    if (cleanScoreA > cleanScoreB) {
      winnerId = aId;
      result = 'TEAM_A_WINS';
    } else if (cleanScoreB > cleanScoreA) {
      winnerId = bId;
      result = 'TEAM_B_WINS';
    }

    const playerA = findPlayer(room, aId);
    const playerB = findPlayer(room, bId);

    matches.push({
      teamAId: aId,
      teamAName: playerA.name,
      teamBId: bId,
      teamBName: playerB.name,
      scoreA: cleanScoreA,
      scoreB: cleanScoreB,
      winnerId,
      result,
      explanation: safeText(
        entry.explanation,
        `${playerA.name}: ${cleanScoreA}/100. ${playerB.name}: ${cleanScoreB}/100.`
      ),
      teamAAnalysis: buildCharacterAnalysis(playerA.team, playerB.team),
      teamBAnalysis: buildCharacterAnalysis(playerB.team, playerA.team),
      analysisStatus: 'complete'
    });
  }

  if (actualSet.size !== expectedSet.size) {
    throw new Error('Gemini did not evaluate every head-to-head matchup.');
  }

  const evaluations = room.players.map(player =>
    evaluationMap.get(player.id)
  );

  const standings = calculateStandings(room, matches, evaluations);

  return {
    matches,
    standings,
    totalMatches: matches.length,
    completedAt: Date.now(),
    overallSummary: safeText(
      parsed.overallSummary,
      'The championship has been evaluated.'
    ),
    rankingExplanation:
      'Final ranking combines 70% normalized head-to-head match points and 30% Gemini overall team evaluation.',
    aiEvaluation: {
      provider: 'Gemini',
      status: 'complete',
      message:
        'Gemini evaluated every team and every head-to-head matchup. Character-level matchup details are generated from the supplied character profiles.'
    },
    rankingRules: [
      '70% of the final score comes from normalized head-to-head match points.',
      '30% of the final score comes from Gemini overall team evaluation.',
      'Match win: 3 points',
      'Match draw: 1 point',
      'Match loss: 0 points',
      'Tiebreakers: combined score, match points, wins, score difference, team evaluation score.'
    ]
  };
}

// --------------------------------------------------
// START CHAMPIONSHIP
// --------------------------------------------------

async function startChampionship(room) {
  if (room.status !== 'ready_for_fight') return;

  const incompletePlayer = room.players.find(
    player => player.team.length !== room.settings.teamSize
  );

  if (incompletePlayer) return;

  room.status = 'championship';

  room.championship = {
    matches: [],
    standings: [],
    totalMatches: 0,
    completedAt: null,
    overallSummary: 'Evaluating every team and matchup...',
    rankingExplanation:
      'The final ranking will combine head-to-head results and overall team evaluation.',
    aiEvaluation: {
      provider: 'Gemini',
      status: 'evaluating',
      message: 'Championship evaluation is in progress.'
    },
    rankingRules: []
  };

  emitRoom(room);

  try {
    const evaluation = await evaluateChampionshipWithGemini(room);

    if (!rooms.has(room.code)) return;

    room.championship = evaluation;
    emitRoom(room);

    console.log(`Championship completed for room ${room.code}`);
  } catch (error) {
    console.error('Gemini championship evaluation failed:', error);

    if (!rooms.has(room.code)) return;

    room.championship = createFallbackChampionship(room, error.message);
    emitRoom(room);
  }
}

// --------------------------------------------------
// HOST VALIDATION
// --------------------------------------------------

function isHost(room, socket) {
  if (!room || room.hostId !== socket.id) {
    socket.emit('error:message', 'Only the host can perform this action.');
    return false;
  }
  return true;
}

// --------------------------------------------------
// API ROUTES
// --------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'BATTLE AUCTION',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.get('/api/universes', (_req, res) => {
  res.json(GENRES);
});

app.post('/api/research', async (req, res) => {
  const genre = String(req.body?.universe || '').trim();

  if (!GENRES.includes(genre)) {
    return res.status(400).json({
      error: 'Choose one of the supported genres.'
    });
  }

  try {
    const characters = await getGenreCharacters(genre);

    res.json({
      note: 'Epic character lists are curated. Other generated entries should be reviewed for accuracy.',
      count: characters.length,
      characters
    });
  } catch (error) {
    res.status(502).json({
      error: 'Character generation failed.',
      detail: error.message
    });
  }
});

// --------------------------------------------------
// SOCKET.IO EVENTS
// --------------------------------------------------

io.on('connection', socket => {

  // CREATE ROOM
  socket.on('room:create', ({ name, settings = {} } = {}) => {
    let code;
    do {
      code = roomCode();
    } while (rooms.has(code));

    const startingBudget = 100;

    const player = {
      id: socket.id,
      name: String(name || 'Host').trim().slice(0, 24),
      budget: startingBudget,
      team: [],
      connected: true
    };

    const room = {
      code,
      hostId: socket.id,
      status: 'lobby',
      settings: {
        startingBudget,
        teamSize: 3,
        turnSeconds: 10,
        startingBid: 1,
        universes: ['Marvel', 'DC'],
        ...settings
      },
      players: [player],
      characters: [],
      characterIndex: -1,
      currentCharacter: null,
      currentBid: 1,
      highestBidderId: null,
      lastBidderId: null,
      currentTurnIndex: 0,
      currentTurnPlayerId: null,
      openingPlayerId: socket.id,
      nextOpeningPlayerId: socket.id,
      turnDeadline: null,
      turnToken: 0,
      noIncreaseTurns: 0,
      passedPlayerIds: new Set(),
      auctionLog: [],
      results: [],
      reserveCharacters: [],
      championship: null,
      completionError: null,
      stateVersion: 0
    };

    rooms.set(code, room);
    socket.join(code);

    socket.emit('room:created', publicRoom(room, socket.id));
    emitRoom(room);
  });

  // JOIN ROOM
  socket.on('room:join', ({ code, name } = {}) => {
    const room = rooms.get(String(code || '').toUpperCase());

    if (!room || room.status !== 'lobby') {
      return socket.emit('error:message', 'Room not found or game already started.');
    }

    if (room.players.length >= 10) {
      return socket.emit('error:message', 'Room is full.');
    }

    const player = {
      id: socket.id,
      name: String(name || 'Player').trim().slice(0, 24),
      budget: room.settings.startingBudget,
      team: [],
      connected: true
    };

    room.players.push(player);
    socket.join(room.code);

    socket.emit('room:joined', publicRoom(room, socket.id));
    emitRoom(room);
  });

  // START GAME AND GENERATE CHARACTER POOL
  socket.on('room:start', async ({
    universes,
    teamSize,
    turnSeconds,
    startingBid
  } = {}) => {
    const room = [...rooms.values()].find(r => r.hostId === socket.id);

    if (!room || room.status !== 'lobby') return;

    if (room.players.length < 2) {
      return socket.emit('error:message', 'At least two players are required.');
    }

    const parsedTeamSize = Number(teamSize);
    const parsedTurnSeconds = Number(turnSeconds);
    const parsedStartingBid = Number(startingBid);

    if (!Number.isInteger(parsedTeamSize) || parsedTeamSize < 1 || parsedTeamSize > 20) {
      return socket.emit('error:message', 'Team size must be between 1 and 20.');
    }

    if (!Number.isInteger(parsedTurnSeconds) || parsedTurnSeconds < 5 || parsedTurnSeconds > 120) {
      return socket.emit('error:message', 'Turn duration must be between 5 and 120 seconds.');
    }

    if (
      !Number.isInteger(parsedStartingBid) ||
      parsedStartingBid < 1 ||
      parsedStartingBid >= room.settings.startingBudget
    ) {
      return socket.emit(
        'error:message',
        'Starting bid must be a positive whole number below the starting budget.'
      );
    }

    const selectedGenres =
      Array.isArray(universes) && universes.length
        ? [...new Set(universes.filter(value => GENRES.includes(value)))]
        : room.settings.universes.filter(value => GENRES.includes(value));

    if (!selectedGenres.length) {
      return socket.emit('error:message', 'Choose at least one available genre.');
    }

    const needsGemini = selectedGenres.some(
      genre => genre !== 'Ramayana' && genre !== 'Mahabharata'
    );

    if (needsGemini && !process.env.GEMINI_API_KEY) {
      return socket.emit(
        'error:message',
        'A Gemini API key is required for the selected genre. Ramayana and Mahabharata can be played without Gemini.'
      );
    }

    const requiredCharacters = room.players.length * parsedTeamSize;

    room.status = 'loading_characters';
    room.completionError = null;
    emitRoom(room);

    try {
      const genrePools = [];

      for (const genre of selectedGenres) {
        const characters = await getGenreCharacters(genre);
        genrePools.push(...characters);
      }

      const uniqueCharacters = [];
      const seenIds = new Set();

      for (const character of genrePools) {
        if (seenIds.has(character.id)) continue;
        seenIds.add(character.id);
        uniqueCharacters.push(character);
      }

      if (uniqueCharacters.length < requiredCharacters) {
        room.status = 'lobby';

        socket.emit(
          'error:message',
          `Not enough characters. You need ${requiredCharacters}, but only ${uniqueCharacters.length} unique characters are available. Choose more genres or reduce team size.`
        );

        emitRoom(room);
        return;
      }

      room.characters = shuffle(uniqueCharacters).slice(0, requiredCharacters);

      room.settings.teamSize = parsedTeamSize;
      room.settings.turnSeconds = parsedTurnSeconds;
      room.settings.startingBid = parsedStartingBid;
      room.settings.universes = selectedGenres;
      room.settings.characterCount = requiredCharacters;

      room.players.forEach(player => {
        player.budget = room.settings.startingBudget;
        player.team = [];
      });

      room.characterIndex = -1;
      room.currentCharacter = null;
      room.currentBid = parsedStartingBid;
      room.highestBidderId = null;
      room.lastBidderId = null;
      room.currentTurnIndex = 0;
      room.currentTurnPlayerId = null;
      room.openingPlayerId = room.hostId;
      room.nextOpeningPlayerId = room.hostId;
      room.turnDeadline = null;
      room.turnToken = 0;
      room.noIncreaseTurns = 0;
      room.passedPlayerIds = new Set();
      room.auctionLog = [];
      room.results = [];
      room.reserveCharacters = [];
      room.championship = null;
      room.completionError = null;
      room.status = 'auction_ready';

      emitRoom(room);

      // Images load in the background. They no longer block the auction.
      attachCharacterImages(room).catch(error => {
        console.warn('Background image loading failed:', error.message);
      });

    } catch (error) {
      console.error('Character generation failed:', error);

      room.status = 'lobby';

      socket.emit(
        'error:message',
        `Character generation failed: ${error.message}`
      );

      emitRoom(room);
    }
  });

  // HOST DEPLOYS NEXT RANDOM CHARACTER
  socket.on('auction:next-character', () => {
    const room = [...rooms.values()].find(r => r.hostId === socket.id);

    if (!isHost(room, socket)) return;

    if (room.status !== 'auction_ready') {
      return socket.emit('error:message', 'The next character is not ready yet.');
    }

    if (room.characterIndex + 1 >= room.characters.length) {
      return completeAuction(room);
    }

    room.characterIndex++;
    room.currentCharacter = clone(room.characters[room.characterIndex]);
    room.currentBid = room.settings.startingBid;
    room.highestBidderId = null;
    room.lastBidderId = null;
    room.noIncreaseTurns = 0;
    room.passedPlayerIds = new Set();

    room.openingPlayerId = room.nextOpeningPlayerId || room.hostId;

    let openingPlayer = findPlayer(room, room.openingPlayerId);

    if (!openingPlayer || !openingPlayer.connected || !canBid(openingPlayer, room)) {
      openingPlayer = room.players.find(player =>
        player.connected && canBid(player, room)
      );
    }

    room.currentTurnPlayerId = openingPlayer?.id || null;
    room.turnDeadline = null;
    room.status = 'auction';

    beginTurn(room);
  });

  // INCREASE BID
  socket.on('bid:increase', ({ amount } = {}) => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.status !== 'auction') return;

    if (room.currentTurnPlayerId !== socket.id) {
      return socket.emit('error:message', 'It is not your turn.');
    }

    if (!room.turnDeadline || Date.now() > room.turnDeadline) {
      return socket.emit('error:message', 'Your turn has expired.');
    }

    const player = findPlayer(room, socket.id);
    const increment = Number(amount);

    if (!Number.isInteger(increment) || increment < 1) {
      return socket.emit('error:message', 'Enter a whole-number increase of at least ₹1.');
    }

    if (player.team.length >= room.settings.teamSize) {
      return socket.emit('error:message', 'Your team is full.');
    }

    const newBid = room.currentBid + increment;

    if (newBid > player.budget) {
      return socket.emit('error:message', 'That bid exceeds your remaining budget.');
    }

    stopTimer(room.code);

    room.currentBid = newBid;
    room.highestBidderId = player.id;
    room.lastBidderId = player.id;
    room.passedPlayerIds = new Set([player.id]);
    room.noIncreaseTurns = 0;

    room.auctionLog.push({
      type: 'BID',
      playerId: player.id,
      amount: newBid,
      increment,
      at: Date.now()
    });

    room.turnDeadline = null;
    finishTurnCycle(room);
  });

  // SKIP TURN
  socket.on('bid:skip', () => {
    const room = findRoomForSocket(socket.id);
    if (!room || room.status !== 'auction') return;

    if (room.currentTurnPlayerId !== socket.id) {
      return socket.emit('error:message', 'It is not your turn.');
    }

    if (!room.turnDeadline || Date.now() > room.turnDeadline) {
      return socket.emit('error:message', 'Your turn has expired.');
    }

    passTurn(room, 'SKIP');
  });

  // HOST STARTS TEAM COMPARISON
  socket.on('championship:start', async () => {
    const room = [...rooms.values()].find(r => r.hostId === socket.id);

    if (!isHost(room, socket)) return;

    if (room.status !== 'ready_for_fight') {
      return socket.emit(
        'error:message',
        'The teams are not ready for the championship.'
      );
    }

    const incompletePlayer = room.players.find(
      player => player.team.length !== room.settings.teamSize
    );

    if (incompletePlayer) {
      return socket.emit(
        'error:message',
        `${incompletePlayer.name}'s team is not complete.`
      );
    }

    await startChampionship(room);
  });

  // PLAYER DISCONNECT
  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = findPlayer(room, socket.id);
      if (!player) continue;

      player.connected = false;

      if (room.status === 'auction') {
        if (room.currentTurnPlayerId === socket.id) {
          stopTimer(room.code);
          room.passedPlayerIds.add(socket.id);
          room.noIncreaseTurns = room.passedPlayerIds.size;
          room.currentTurnPlayerId = socket.id;
          room.turnDeadline = null;
          finishTurnCycle(room);
        } else {
          if (room.highestBidderId === socket.id) {
            room.highestBidderId = null;
            room.lastBidderId = null;
            room.currentBid = room.settings.startingBid;
            room.passedPlayerIds = new Set();
          }

          emitRoom(room);
        }
      } else {
        emitRoom(room);
      }
    }
  });
});

// --------------------------------------------------
// SERVE FRONTEND
// --------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'dist')));

// RegExp route works with both Express 4 and Express 5.
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();

  res.sendFile(
    path.join(__dirname, '..', 'dist', 'index.html'),
    error => {
      if (error) next(error);
    }
  );
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

server.listen(PORT, () => {
  console.log(`BATTLE AUCTION server listening on ${PORT}`);
});
