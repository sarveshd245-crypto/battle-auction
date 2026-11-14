
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
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const rooms = new Map();
const turnTimers = new Map();
const genreCache = new Map();
const imageCache = new Map();

const GENRES = [
  'Ramayana',
  'Mahabharata',
  'Football',
  'Cricket',
  'Marvel',
  'DC',
  'Harry Potter',
  'Anime'
];

const SEED_CHARACTERS = [
  {
    id: 'marvel-spider-man',
    name: 'Spider-Man',
    universe: 'Marvel',
    version: 'Earth-616',
    rating: 88,
    abilities: ['Spider-sense', 'Agility', 'Web-slinging'],
    strengths: ['Mobility', 'Reflexes', 'Improvisation'],
    weaknesses: ['Human-level durability'],
    description: 'Peter Parker is a brilliant hero with extraordinary agility and danger awareness.',
    combatStyle: 'Fast, mobile and improvisational',
    sources: []
  },
  {
    id: 'marvel-iron-man',
    name: 'Iron Man',
    universe: 'Marvel',
    version: 'Earth-616',
    rating: 91,
    abilities: ['Powered armour', 'Repulsors', 'Flight'],
    strengths: ['Technology', 'Range', 'Adaptability'],
    weaknesses: ['Armour dependence'],
    description: 'Tony Stark is an inventor who uses advanced powered armour.',
    combatStyle: 'Technology-driven ranged combat',
    sources: []
  },
  {
    id: 'marvel-thor',
    name: 'Thor',
    universe: 'Marvel',
    version: 'Earth-616',
    rating: 96,
    abilities: ['Asgardian physiology', 'Mjolnir', 'Lightning'],
    strengths: ['Durability', 'Strength', 'Energy projection'],
    weaknesses: ['Version-dependent limits'],
    description: 'Thor is an Asgardian warrior with immense strength.',
    combatStyle: 'Powerful close combat and storm-based attacks',
    sources: []
  },
  {
    id: 'dc-batman',
    name: 'Batman',
    universe: 'DC',
    version: 'Main continuity',
    rating: 87,
    abilities: ['Detective skills', 'Martial arts', 'Technology'],
    strengths: ['Preparation', 'Strategy', 'Stealth'],
    weaknesses: ['Human physiology'],
    description: 'Bruce Wayne is a highly trained detective and strategist.',
    combatStyle: 'Strategic and technical',
    sources: []
  },
  {
    id: 'dc-superman',
    name: 'Superman',
    universe: 'DC',
    version: 'Main continuity',
    rating: 98,
    abilities: ['Flight', 'Super strength', 'Heat vision'],
    strengths: ['Speed', 'Durability', 'Power'],
    weaknesses: ['Continuity-dependent vulnerabilities'],
    description: 'Clark Kent is a Kryptonian with exceptional strength and speed.',
    combatStyle: 'High-power physical and ranged combat',
    sources: []
  },
  {
    id: 'dc-wonder-woman',
    name: 'Wonder Woman',
    universe: 'DC',
    version: 'Main continuity',
    rating: 94,
    abilities: ['Amazonian abilities', 'Combat skill', 'Lasso'],
    strengths: ['Combat', 'Durability', 'Leadership'],
    weaknesses: ['Continuity-dependent limits'],
    description: 'Diana is an Amazonian warrior known for her strength and combat experience.',
    combatStyle: 'Disciplined close combat',
    sources: []
  },
  {
    id: 'ramayana-hanuman',
    name: 'Hanuman',
    universe: 'Ramayana',
    version: 'Traditional epic',
    rating: 99,
    abilities: ['Immense strength', 'Flight', 'Form-changing'],
    strengths: ['Strength', 'Resilience', 'Combat skill'],
    weaknesses: ['Tradition-specific interpretations'],
    description: 'Hanuman is a powerful Vanara warrior.',
    combatStyle: 'Mythological strength and mobility',
    sources: []
  },
  {
    id: 'mahabharata-arjuna',
    name: 'Arjuna',
    universe: 'Mahabharata',
    version: 'Traditional epic',
    rating: 99,
    abilities: ['Archery', 'Divine astras', 'Warfare'],
    strengths: ['Precision', 'Discipline', 'Combat skill'],
    weaknesses: ['Weapon and context constraints'],
    description: 'Arjuna is renowned for exceptional archery.',
    combatStyle: 'Precision archery',
    sources: []
  }
];

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

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
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
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

function cleanList(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  if (typeof value === 'string') {
    return value.split(',')
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  return [];
}

function safeText(value, fallback = '') {
  return String(value || fallback).trim().slice(0, 1000);
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
    rating: Number.isFinite(rating)
      ? Math.max(1, Math.min(100, rating))
      : 70,
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

  return Array.from(
    { length: 6 },
    () => chars[Math.floor(Math.random() * chars.length)]
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
      responseMimeType: 'application/json'
    }
  });
}

// --------------------------------------------------
// CHARACTER IMAGE LOOKUP
// --------------------------------------------------

async function getWikipediaImage(character) {
  const cacheKey = `${character.universe}:${character.name}`.toLowerCase();

  if (imageCache.has(cacheKey)) {
    return imageCache.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const searchText = `${character.name} ${character.universe}`;

      const searchUrl = new URL('https://en.wikipedia.org/w/api.php');
      searchUrl.searchParams.set('action', 'query');
      searchUrl.searchParams.set('generator', 'search');
      searchUrl.searchParams.set('gsrsearch', searchText);
      searchUrl.searchParams.set('gsrnamespace', '0');
      searchUrl.searchParams.set('gsrlimit', '5');
      searchUrl.searchParams.set('prop', 'pageimages');
      searchUrl.searchParams.set('piprop', 'thumbnail');
      searchUrl.searchParams.set('pithumbsize', '700');
      searchUrl.searchParams.set('format', 'json');

      const response = await fetch(searchUrl, {
        signal: AbortSignal.timeout(7000),
        headers: {
          'User-Agent': 'BattleAuctionGame/1.0 (character image lookup)'
        }
      });

      if (!response.ok) return null;

      const data = await response.json();
      const pages = Object.values(data.query?.pages || {});

      if (!pages.length) return null;

      const name = character.name.toLowerCase();

      const bestPage =
        pages.find(page =>
          String(page.title || '').toLowerCase().includes(name)
        ) ||
        pages[0];

      return bestPage.thumbnail?.source || null;

    } catch (error) {
      console.warn(
        `Image lookup failed for ${character.name}:`,
        error.message
      );

      return null;
    }
  })();

  imageCache.set(cacheKey, promise);

  return promise;
}

async function attachCharacterImages(characters) {
  let nextIndex = 0;

  const workerCount = Math.min(5, characters.length);

  async function worker() {
    while (nextIndex < characters.length) {
      const index = nextIndex++;
      const character = characters[index];

      character.imageUrl = await getWikipediaImage(character);
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, () => worker())
  );

  return characters;
}

// --------------------------------------------------
// WARRIOR-ONLY EPIC CHARACTER DATABASES
// --------------------------------------------------

const EPIC_CHARACTERS = {
  Ramayana: [
    ['Rama', 98, 'Prince of Ayodhya and skilled warrior and archer'],
    ['Lakshmana', 94, 'Brother of Rama and powerful warrior'],
    ['Bharata', 88, 'Brother of Rama and warrior prince'],
    ['Shatrughna', 87, 'Brother of Rama and warrior prince'],
    ['Hanuman', 99, 'Powerful Vanara warrior with extraordinary strength'],
    ['Ravana', 98, 'King of Lanka and formidable warrior'],
    ['Kumbhakarna', 95, 'Powerful warrior and brother of Ravana'],
    ['Indrajit', 97, 'Son of Ravana and master of celestial weapons'],
    ['Vibhishana', 87, 'Brother of Ravana who fought alongside Rama'],
    ['Sugriva', 90, 'Vanara king and warrior ally of Rama'],
    ['Vali', 96, 'Extremely powerful Vanara warrior and king'],
    ['Angada', 91, 'Son of Vali and skilled Vanara warrior'],
    ['Jambavan', 92, 'Experienced warrior and leader of the bear army'],
    ['Jatayu', 86, 'Warrior bird who fought to protect Sita'],
    ['Garuda', 98, 'Divine warrior bird with immense power'],
    ['Maricha', 85, 'Rakshasa warrior with magical abilities'],
    ['Subahu', 83, 'Rakshasa warrior who fought against Rama'],
    ['Tataka', 85, 'Powerful Rakshasi warrior'],
    ['Nala', 87, 'Vanara warrior and bridge builder'],
    ['Nila', 87, 'Vanara warrior and commander'],
    ['Prahasta', 91, 'Chief commander of Ravana’s army'],
    ['Akampana', 85, 'Rakshasa warrior in Ravana’s army'],
    ['Atikaya', 92, 'Powerful son of Ravana and warrior'],
    ['Narantaka', 87, 'Son of Ravana and warrior'],
    ['Devantaka', 88, 'Son of Ravana and powerful fighter'],
    ['Trishira', 87, 'Three-headed warrior in Ravana’s army'],
    ['Mahodara', 85, 'Rakshasa commander of Lanka'],
    ['Mahaparshva', 85, 'Rakshasa warrior and commander'],
    ['Dhumraksha', 86, 'Rakshasa general in Ravana’s army'],
    ['Vajradamshtra', 86, 'Powerful Rakshasa warrior'],
    ['Kumbha', 89, 'Son of Kumbhakarna and warrior of Lanka'],
    ['Nikumbha', 88, 'Son of Kumbhakarna and Rakshasa warrior'],
    ['Mainda', 85, 'Vanara warrior in Rama’s army'],
    ['Dvivida', 86, 'Vanara warrior and commander'],
    ['Gavaksha', 84, 'Vanara commander in Rama’s army'],
    ['Gaja', 84, 'Vanara warrior and commander'],
    ['Rishabha', 84, 'Vanara warrior who fought in Lanka'],
    ['Sushena', 85, 'Vanara commander and warrior'],
    ['Makaraksha', 87, 'Son of Khara and Rakshasa warrior'],
    ['Virupaksha', 84, 'Rakshasa warrior of Lanka']
  ],

  Mahabharata: [
    ['Krishna', 100, 'Strategist and guide who played a key role in the war'],
    ['Arjuna', 99, 'Legendary archer and one of the greatest warriors'],
    ['Karna', 98, 'Legendary archer and formidable warrior'],
    ['Bhishma', 99, 'Grand commander and master of warfare'],
    ['Drona', 97, 'Master of archery and military strategy'],
    ['Ashwatthama', 96, 'Powerful warrior and son of Drona'],
    ['Bhima', 97, 'Pandava warrior known for immense strength'],
    ['Yudhishthira', 91, 'Pandava warrior and skilled fighter'],
    ['Nakula', 90, 'Pandava warrior skilled in swordsmanship'],
    ['Sahadeva', 90, 'Pandava warrior and skilled fighter'],
    ['Duryodhana', 96, 'Kaurava leader and master of mace fighting'],
    ['Dushasana', 88, 'Kaurava warrior and brother of Duryodhana'],
    ['Abhimanyu', 96, 'Young warrior renowned for entering the Chakravyuha'],
    ['Ghatotkacha', 96, 'Powerful warrior and son of Bhima'],
    ['Balarama', 97, 'Master of mace fighting and powerful warrior'],
    ['Satyaki', 93, 'Skilled Yadava warrior allied with the Pandavas'],
    ['Kripacharya', 94, 'Experienced warrior and master of weapons'],
    ['Shikhandi', 90, 'Warrior who played a key role against Bhishma'],
    ['Dhrishtadyumna', 94, 'Commander of the Pandava army'],
    ['Parashurama', 100, 'Legendary warrior and master of weapons'],
    ['Ekalavya', 94, 'Exceptional archer known for his dedication'],
    ['Jayadratha', 89, 'King and warrior who fought for the Kauravas'],
    ['Barbarika', 99, 'Legendary warrior with extraordinary archery skills'],
    ['Uttara Kumara', 85, 'Prince and warrior of the Matsya kingdom'],
    ['Virata', 88, 'King of Matsya and warrior'],
    ['Drupada', 90, 'King of Panchala and experienced warrior'],
    ['Pandu', 89, 'Father of the Pandavas and skilled archer'],
    ['Somadatta', 87, 'Kuru-side warrior'],
    ['Bhagadatta', 94, 'King and elephant-warrior who fought for the Kauravas'],
    ['Shalya', 93, 'King of Madra and powerful warrior'],
    ['Kritavarma', 91, 'Yadava warrior who fought for the Kauravas'],
    ['Bhurishravas', 91, 'Experienced Kuru-side warrior'],
    ['Vikarna', 86, 'Kaurava warrior and brother of Duryodhana'],
    ['Alambusha', 90, 'Rakshasa warrior who fought in the Kurukshetra war'],
    ['Bahlika', 88, 'Elder Kuru warrior and king'],
    ['Sudakshina', 87, 'King of Kamboja and warrior'],
    ['Brihadbala', 88, 'King of Kosala who fought in the war'],
    ['Susharma', 88, 'King of Trigarta and warrior'],
    ['Chekitana', 89, 'Warrior who fought on the Pandava side'],
    ['Yuyutsu', 85, 'Kaurava brother who fought for the Pandavas']
  ]
};

function makeEpicSeedCharacters(genre) {
  const entries = EPIC_CHARACTERS[genre] || [];

  return entries.map(([name, rating, description]) => ({
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

// --------------------------------------------------
// GEMINI CHARACTER GENERATION
// --------------------------------------------------

async function generateGenreCharacters(genre) {
  if (genre === 'Ramayana' || genre === 'Mahabharata') {
    const warriors = makeEpicSeedCharacters(genre);

    console.log(
      `${genre}: ${warriors.length} curated warriors available`
    );

    return warriors;
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

  for (const character of SEED_CHARACTERS.filter(
    item => item.universe === genre
  )) {
    addCharacter(clone(character));
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const model = getGeminiModel();

      for (let batch = 0; batch < 6; batch++) {
        if (generated.length >= 100) break;

        const count = Math.min(20, 100 - generated.length);

        const existingNames = generated
          .map(character => character.name)
          .join(', ');

        const prompt = `
Generate ${count} additional established and distinct characters
from "${genre}".

Do not repeat these names:
${existingNames}

Do not invent characters.
Use established characters only.
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
      "abilities": ["Ability 1", "Ability 2"],
      "strengths": ["Strength 1", "Strength 2"],
      "weaknesses": ["Weakness 1"],
      "description": "Short description",
      "combatStyle": "Style"
    }
  ]
}
`;

        try {
          const result = await model.generateContent(prompt);
          const parsed = extractJSON(result.response.text());

          const entries = Array.isArray(parsed.characters)
            ? parsed.characters
            : [];

          for (const raw of entries) {
            addCharacter(normalizeCharacter(raw, genre));

            if (generated.length >= 100) break;
          }

        } catch (error) {
          console.warn(
            `Gemini batch ${batch + 1} failed for ${genre}:`,
            error.message
          );
        }
      }

    } catch (error) {
      console.warn(
        `Gemini unavailable for ${genre}:`,
        error.message
      );
    }
  }

  console.log(
    `${genre}: ${generated.length} unique characters available`
  );

  return generated.slice(0, 100);
}

async function getGenreCharacters(genre) {
  if (!GENRES.includes(genre)) {
    throw new Error(`Unsupported genre: ${genre}`);
  }

  if (genreCache.has(genre)) {
    return genreCache.get(genre);
  }

  const promise = generateGenreCharacters(genre);
  genreCache.set(genre, promise);

  try {
    return await promise;
  } catch (error) {
    genreCache.delete(genre);
    throw error;
  }
}

// --------------------------------------------------
// ROOM DATA AND PRIVATE TEAM VISIBILITY
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
      team:
        showAllTeams || player.id === viewerId
          ? player.team
          : [],
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
    io.to(player.id).emit(
      'room:update',
      publicRoom(room, player.id)
    );
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

  const startIndex = players.findIndex(
    player => player.id === afterPlayerId
  );

  for (let step = 1; step <= players.length; step++) {
    const index =
      (Math.max(startIndex, -1) + step) % players.length;

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

  const nextPlayer = getNextEligiblePlayer(
    room,
    room.currentTurnPlayerId
  );

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

  const players = activePlayers(room);

  if (!players.length) {
    room.turnDeadline = null;
    room.currentTurnPlayerId = null;
    room.status = 'auction_paused';
    emitRoom(room);
    return;
  }

  let currentPlayer = findPlayer(
    room,
    room.currentTurnPlayerId
  );

  const eligible =
    currentPlayer &&
    currentPlayer.connected &&
    currentPlayer.id !== room.highestBidderId &&
    !room.passedPlayerIds.has(currentPlayer.id) &&
    canBid(currentPlayer, room);

  if (!eligible) {
    currentPlayer = getNextEligiblePlayer(
      room,
      room.currentTurnPlayerId
    );
  }

  if (!currentPlayer) {
    resolveAuction(room);
    return;
  }

  room.currentTurnPlayerId = currentPlayer.id;

  room.turnDeadline =
    Date.now() + room.settings.turnSeconds * 1000;

  room.turnToken = (room.turnToken || 0) + 1;

  const token = room.turnToken;
  const deadline = room.turnDeadline;

  emitRoom(room);

  const timer = setTimeout(() => {
    const currentRoom = rooms.get(room.code);

    if (!currentRoom) return;
    if (currentRoom.status !== 'auction') return;
    if (currentRoom.turnToken !== token) return;
    if (currentRoom.turnDeadline !== deadline) return;

    passTurn(currentRoom, 'TIMEOUT');
  }, room.settings.turnSeconds * 1000 + 100);

  turnTimers.set(room.code, timer);
}

function passTurn(room, reason = 'SKIP') {
  if (room.status !== 'auction') return;

  stopTimer(room.code);

  const player = findPlayer(
    room,
    room.currentTurnPlayerId
  );

  if (player) {
    room.passedPlayerIds.add(player.id);
  }

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
// RESOLVE THE CURRENT AUCTION
// --------------------------------------------------

function resolveAuction(room) {
  if (room.status !== 'auction' || !room.currentCharacter) return;

  stopTimer(room.code);

  const character = clone(room.currentCharacter);
  const winnerId = room.lastBidderId;
  const winner = findPlayer(room, winnerId);

  let awarded = false;

  if (
    winner &&
    winner.connected &&
    winner.budget >= room.currentBid &&
    winner.team.length < room.settings.teamSize
  ) {
    winner.budget -= room.currentBid;

    winner.team.push({
      ...character,
      paid: room.currentBid
    });

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
    !room ||
    room.status === 'team_reveal' ||
    room.status === 'ready_for_fight' ||
    room.status === 'championship'
  ) {
    return;
  }

  stopTimer(room.code);

  // Find all empty team slots.
  const emptySlots = [];

  for (const player of room.players) {
    while (player.team.length < room.settings.teamSize) {
      emptySlots.push(player);
    }
  }

  // All teams are already full.
  if (emptySlots.length === 0) {
    room.reserveCharacters = [];
    room.currentCharacter = null;
    room.currentTurnPlayerId = null;
    room.turnDeadline = null;
    room.completionError = null;
    room.status = 'team_reveal';

    emitRoom(room);

    setTimeout(() => {
      const currentRoom = rooms.get(room.code);

      if (!currentRoom || currentRoom.status !== 'team_reveal') {
        return;
      }

      currentRoom.status = 'ready_for_fight';
      emitRoom(currentRoom);
    }, 10000);

    return;
  }

  // Find characters already assigned to teams.
  const assignedIds = new Set();

  for (const player of room.players) {
    for (const character of player.team) {
      assignedIds.add(character.id);
    }
  }

  // Combine all possible unused characters.
  const combinedPool = [
    ...(room.characters || []),
    ...(room.reserveCharacters || [])
  ];

  const uniqueAvailable = new Map();

  for (const character of combinedPool) {
    if (!character || !character.id) continue;
    if (assignedIds.has(character.id)) continue;

    if (!uniqueAvailable.has(character.id)) {
      uniqueAvailable.set(character.id, character);
    }
  }

  const freePool = shuffle([...uniqueAvailable.values()]);

  console.log(
    `[FREE ALLOCATION] Room ${room.code}: ` +
    `${emptySlots.length} empty slots, ` +
    `${freePool.length} available characters.`
  );

  // Make sure there are enough characters for every empty slot.
  if (freePool.length < emptySlots.length) {
    room.status = 'incomplete';
    room.currentCharacter = null;
    room.currentTurnPlayerId = null;
    room.turnDeadline = null;

    room.completionError =
      `Free allocation failed. ${emptySlots.length} slots are empty, ` +
      `but only ${freePool.length} unused characters are available.`;

    console.error(room.completionError);
    emitRoom(room);
    return;
  }

  const allocations = [];

  // Give one unique free character to each empty slot.
  for (let i = 0; i < emptySlots.length; i++) {
    const player = emptySlots[i];
    const character = clone(freePool[i]);

    player.team.push({
      ...character,
      paid: 0,
      allocatedFree: true
    });

    allocations.push({
      characterId: character.id,
      characterName: character.name,
      winnerId: player.id,
      winnerName: player.name,
      amount: 0,
      allocatedFree: true
    });

    room.results.push({
      characterId: character.id,
      characterName: character.name,
      winnerId: player.id,
      winnerName: player.name,
      amount: 0,
      allocatedFree: true
    });

    room.auctionLog.push({
      type: 'FREE_ALLOCATION',
      characterId: character.id,
      playerId: player.id,
      playerName: player.name,
      amount: 0,
      at: Date.now()
    });
  }

  // Preserve any unused characters in the reserve pool.
  room.reserveCharacters = freePool.slice(emptySlots.length);

  // Clear auction state.
  room.currentCharacter = null;
  room.currentTurnPlayerId = null;
  room.turnDeadline = null;
  room.currentBid = room.settings.startingBid;
  room.highestBidderId = null;
  room.lastBidderId = null;
  room.noIncreaseTurns = 0;
  room.passedPlayerIds = new Set();
  room.completionError = null;

  // Verify that every player has a complete team.
  const incompletePlayer = room.players.find(
    player => player.team.length !== room.settings.teamSize
  );

  if (incompletePlayer) {
    room.status = 'incomplete';
    room.completionError =
      `${incompletePlayer.name}'s team could not be completed.`;

    console.error(room.completionError);
    emitRoom(room);
    return;
  }

  console.log(
    `[FREE ALLOCATION COMPLETE] Room ${room.code}:`,
    allocations
  );

  // Reveal teams privately to each player.
  room.status = 'team_reveal';
  emitRoom(room);

  // Enable the Fight button after the reveal period.
  setTimeout(() => {
    const currentRoom = rooms.get(room.code);

    if (
      !currentRoom ||
      currentRoom.status !== 'team_reveal'
    ) {
      return;
    }

    currentRoom.status = 'ready_for_fight';
    emitRoom(currentRoom);

    console.log(
      `[TEAMS READY] Room ${currentRoom.code}: All teams are complete.`
    );
  }, 10000);
}

// --------------------------------------------------
// TEAM STRENGTH FALLBACK
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

  return Math.round(ratings / team.length + synergy);
}

function calculateStandings(room, matches, evaluations = []) {
  const evaluationMap = new Map(
    evaluations.map(evaluation => [
      evaluation.playerId,
      evaluation
    ])
  );

  const standings = room.players.map(player => {
    const played = matches.filter(match =>
      match.teamAId === player.id ||
      match.teamBId === player.id
    );

    const wins = played.filter(
      match => match.winnerId === player.id
    ).length;

    const draws = played.filter(
      match => match.result === 'DRAW'
    ).length;

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

    return {
      playerId: player.id,
      name: player.name,
      wins,
      draws,
      losses,
      points,
      scoreDifference,
      teamStrength: evaluation?.score ?? calculateTeamStrength(player.team),
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
    b.points - a.points ||
    b.wins - a.wins ||
    b.scoreDifference - a.scoreDifference ||
    b.teamStrength - a.teamStrength
  );

  let previousKey = null;
  let rank = 0;

  standings.forEach((standing, index) => {
    const key = [
      standing.points,
      standing.wins,
      standing.scoreDifference,
      standing.teamStrength
    ].join(':');

    if (key !== previousKey) {
      rank = index + 1;
    }

    standing.rank = rank;
    previousKey = key;
  });

  return standings;
}

// --------------------------------------------------
// MATCHUP NORMALIZATION
// --------------------------------------------------

function normalizeCharacterAnalysis(raw, team) {
  if (!Array.isArray(raw)) {
    throw new Error('Gemini omitted character matchup analysis.');
  }

  const teamCharacters = new Map(
    team.map(character => [
      character.name.toLowerCase(),
      character
    ])
  );

  if (raw.length !== team.length) {
    throw new Error(
      'Gemini did not provide analysis for every character in a team.'
    );
  }

  const seen = new Set();

  return raw.map(item => {
    const name = safeText(item.characterName);
    const key = name.toLowerCase();

    if (!teamCharacters.has(key) || seen.has(key)) {
      throw new Error(
        `Gemini returned an unknown or duplicate character: ${name}`
      );
    }

    seen.add(key);

    const advantages = cleanList(item.advantages);
    const disadvantages = cleanList(item.disadvantages);

    if (!advantages.length || !disadvantages.length) {
      throw new Error(
        `Character analysis is incomplete for ${name}.`
      );
    }

    return {
      characterName: name,
      opponentMatchups: Array.isArray(item.opponentMatchups)
        ? item.opponentMatchups.slice(0, 20).map(opponent => ({
            opponentName: safeText(opponent.opponentName, 'Opponent'),
            advantage: safeText(opponent.advantage, 'No specific advantage supplied.'),
            disadvantage: safeText(opponent.disadvantage, 'No specific disadvantage supplied.'),
            impact: safeText(opponent.impact, 'Impact not specified.')
          }))
        : [],
      advantages,
      disadvantages,
      impact: safeText(item.impact, 'Contribution not specified.'),
      tacticalRole: safeText(item.tacticalRole, 'Role not specified.')
    };
  });
}

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
          `${a.name} received ${scoreA}/100 and ${b.name} received ${scoreB}/100 using the fallback rating calculation.`,
        teamAAnalysis: [],
        teamBAnalysis: [],
        analysisStatus: 'unavailable'
      });
    }
  }

  const standings = calculateStandings(room, matches);

  return {
    matches,
    standings,
    totalMatches: matches.length,
    completedAt: Date.now(),
    overallSummary:
      'Gemini could not complete the detailed character matchup evaluation. These provisional results use character ratings only.',
    rankingExplanation:
      'These are fallback rankings, not AI matchup rankings. Match wins award 3 points, draws award 1 point and losses award 0 points.',
    aiEvaluation: {
      provider: 'Gemini',
      status: 'unavailable',
      message: safeText(
        errorMessage,
        'Gemini evaluation failed. Check the server logs and API configuration.'
      )
    },
    rankingRules: [
      'Match win: 3 points',
      'Match draw: 1 point',
      'Match loss: 0 points',
      'Fallback tiebreakers: wins, score difference, then average character rating'
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
      abilities: character.abilities,
      strengths: character.strengths,
      weaknesses: character.weaknesses,
      description: character.description,
      style: character.combatStyle
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

  const prompt = `
You are the neutral and fair judge of a fictional and sporting team-building championship.

Your job is to analyse every team and every possible head-to-head matchup.

IMPORTANT RULES:

1. Use ONLY the character information supplied.
2. Never invent powers, abilities, achievements, weaknesses or equipment.
3. Do not automatically favour famous or highly rated characters.
4. Ratings are supporting information, not the deciding factor.
5. Evaluate how abilities and weaknesses interact.
6. Explain uncertainty when characters belong to different fictional universes.
7. Keep all explanations non-graphic and focused on fictional abilities, tactics and strategy.
8. For Football and Cricket, evaluate sporting roles, skills, strengths, weaknesses and team balance instead of fictional combat.

TEAM EVALUATION:

For every player, provide:
- Score from 1 to 100.
- Overall summary.
- Strengths.
- Weaknesses.
- Synergy.
- Balance.
- Vulnerabilities.
- Key contributions of every character.
- Ranking rationale.

HEAD-TO-HEAD EVALUATION:

Every unordered pair of teams must be evaluated exactly once.

For EACH matchup:

A. Evaluate team A against team B.
B. Evaluate team B against team A.
C. Give each team a matchup score from 1 to 100.
D. Choose the winner based on the actual matchup analysis.
E. Explain why the winner has an advantage or why it is a draw.

CHARACTER-BY-CHARACTER ANALYSIS:

For EVERY character in team A:
- Identify the specific opposing characters they match up well against.
- Identify opposing characters who create disadvantages for them.
- Explain their advantages.
- Explain their disadvantages.
- Explain their contribution to the overall matchup.
- Identify their tactical role.

Repeat this process for EVERY character in team B.

Do not provide generic statements such as "strong character" or "good abilities".
Use the actual supplied character names and abilities.

Each character must have:
- At least one advantage.
- At least one disadvantage.
- An explanation of impact.
- A tactical role.
- Opponent-specific matchup details.

Do not assume that a character defeats every opponent.
A character can have an advantage against one opponent and a disadvantage against another.

MATCHUP SCORING:

- Scores must reflect the matchup rather than copied team ratings.
- A team with better overall ratings can lose a particular matchup if its abilities and composition are poorly suited to the opponent.
- Consider coverage, role diversity, weaknesses, counterplay, coordination and synergy.
- Do not award a winner solely because of a higher average character rating.
- A close matchup can be a draw.
- winnerId must match the team with the higher matchup score, or null for a draw.

RETURN JSON ONLY.

Use EXACTLY this structure:

{
  "overallSummary": "Championship overview",
  "rankingExplanation": "How the standings were determined",
  "teams": [
    {
      "playerId": "EXACT_PLAYER_ID",
      "score": 90,
      "summary": "Team evaluation",
      "strengths": ["Strength"],
      "weaknesses": ["Weakness"],
      "synergy": "Team synergy",
      "balance": "Team balance",
      "vulnerabilities": ["Vulnerability"],
      "keyContributions": [
        {
          "characterName": "Exact character name",
          "contribution": "Contribution"
        }
      ],
      "rankingRationale": "Ranking rationale"
    }
  ],
  "matchups": [
    {
      "teamAId": "EXACT_PLAYER_ID",
      "teamBId": "EXACT_PLAYER_ID",
      "scoreA": 85,
      "scoreB": 80,
      "winnerId": "EXACT_PLAYER_ID",
      "explanation": "Detailed matchup explanation",
      "teamAAnalysis": [
        {
          "characterName": "Exact character name",
          "opponentMatchups": [
            {
              "opponentName": "Exact opposing character name",
              "advantage": "Specific advantage or disadvantage",
              "disadvantage": "Specific limitation",
              "impact": "How this affects the matchup"
            }
          ],
          "advantages": ["Specific advantage"],
          "disadvantages": ["Specific disadvantage"],
          "impact": "Overall character contribution",
          "tacticalRole": "Role in this matchup"
        }
      ],
      "teamBAnalysis": [
        {
          "characterName": "Exact character name",
          "opponentMatchups": [
            {
              "opponentName": "Exact opposing character name",
              "advantage": "Specific advantage or disadvantage",
              "disadvantage": "Specific limitation",
              "impact": "How this affects the matchup"
            }
          ],
          "advantages": ["Specific advantage"],
          "disadvantages": ["Specific disadvantage"],
          "impact": "Overall character contribution",
          "tacticalRole": "Role in this matchup"
        }
      ]
    }
  ]
}

VALIDATION REQUIREMENTS:

- Every player must appear exactly once in teams.
- Every unordered pair of players must appear exactly once in matchups.
- Use the exact player IDs supplied.
- Every character in every team must appear exactly once in that team's matchup analysis for each matchup.
- Use exact character names.
- Every character must have advantages and disadvantages.
- Do not omit character matchup details.
- winnerId must be teamAId, teamBId, or null.
- Do not include Markdown or text outside JSON.

TEAMS:
${JSON.stringify(teams)}

REQUIRED MATCHUP PAIRS:
${JSON.stringify(expectedPairs)}
`;

  let parsed = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await model.generateContent(
        attempt === 1
          ? prompt
          : `${prompt}

IMPORTANT: Your previous response was incomplete or invalid.
Return the complete JSON structure. Do not omit any player,
matchup or character analysis.`
      );

      parsed = extractJSON(result.response.text());
      break;

    } catch (error) {
      lastError = error;

      console.warn(
        `Championship Gemini attempt ${attempt} failed:`,
        error.message
      );
    }
  }

  if (!parsed) {
    throw lastError || new Error('Gemini did not return an evaluation.');
  }

  if (
    !Array.isArray(parsed.teams) ||
    !Array.isArray(parsed.matchups)
  ) {
    throw new Error(
      'Gemini returned an incomplete championship evaluation.'
    );
  }

  const playerIds = room.players.map(player => player.id);
  const validIds = new Set(playerIds);

  const evaluationMap = new Map();

  for (const entry of parsed.teams) {
    if (!validIds.has(entry.playerId)) {
      throw new Error('Gemini returned an unknown player ID.');
    }

    if (evaluationMap.has(entry.playerId)) {
      throw new Error('Gemini returned a duplicate team evaluation.');
    }

    const score = Number(entry.score);

    if (!Number.isFinite(score)) {
      throw new Error('Gemini returned an invalid team score.');
    }

    const player = findPlayer(room, entry.playerId);

    const contributions = Array.isArray(entry.keyContributions)
      ? entry.keyContributions.slice(0, 20).map(item => ({
          characterName: safeText(item.characterName, 'Team member'),
          contribution: safeText(
            item.contribution,
            'Contribution not specified.'
          )
        }))
      : [];

    evaluationMap.set(entry.playerId, {
      playerId: entry.playerId,
      score: Math.max(1, Math.min(100, Math.round(score))),
      summary: safeText(entry.summary, 'Team evaluated by Gemini.'),
      strengths: cleanList(entry.strengths),
      weaknesses: cleanList(entry.weaknesses),
      synergy: safeText(entry.synergy, 'No synergy explanation supplied.'),
      balance: safeText(entry.balance, 'No balance explanation supplied.'),
      vulnerabilities: cleanList(entry.vulnerabilities),
      keyContributions: contributions,
      rankingRationale: safeText(
        entry.rankingRationale,
        'No ranking rationale supplied.'
      ),
      team: player.team
    });
  }

  if (evaluationMap.size !== room.players.length) {
    throw new Error(
      'Gemini did not evaluate every player exactly once.'
    );
  }

  const expectedPairSet = new Set(
    expectedPairs.map(pair =>
      [pair.teamAId, pair.teamBId].sort().join('|')
    )
  );

  const actualPairSet = new Set();
  const matches = [];

  for (const entry of parsed.matchups) {
    const aId = entry.teamAId;
    const bId = entry.teamBId;

    if (
      !validIds.has(aId) ||
      !validIds.has(bId) ||
      aId === bId
    ) {
      throw new Error('Gemini returned an invalid matchup.');
    }

    const pairKey = [aId, bId].sort().join('|');

    if (
      !expectedPairSet.has(pairKey) ||
      actualPairSet.has(pairKey)
    ) {
      throw new Error(
        'Gemini returned a duplicate or unexpected matchup.'
      );
    }

    actualPairSet.add(pairKey);

    const scoreA = Number(entry.scoreA);
    const scoreB = Number(entry.scoreB);

    if (
      !Number.isFinite(scoreA) ||
      !Number.isFinite(scoreB)
    ) {
      throw new Error('Gemini returned invalid matchup scores.');
    }

    const cleanScoreA = Math.max(
      1,
      Math.min(100, Math.round(scoreA))
    );

    const cleanScoreB = Math.max(
      1,
      Math.min(100, Math.round(scoreB))
    );

    let winnerId = null;
    let result = 'DRAW';

    if (cleanScoreA > cleanScoreB) {
      winnerId = aId;
      result = 'TEAM_A_WINS';
    } else if (cleanScoreB > cleanScoreA) {
      winnerId = bId;
      result = 'TEAM_B_WINS';
    }

    if (
      entry.winnerId !== null &&
      entry.winnerId !== undefined &&
      entry.winnerId !== winnerId
    ) {
      throw new Error(
        'Gemini returned a winner inconsistent with its matchup scores.'
      );
    }

    const playerA = findPlayer(room, aId);
    const playerB = findPlayer(room, bId);

    const teamAAnalysis = normalizeCharacterAnalysis(
      entry.teamAAnalysis,
      playerA.team
    );

    const teamBAnalysis = normalizeCharacterAnalysis(
      entry.teamBAnalysis,
      playerB.team
    );

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
        `${playerA.name} scored ${cleanScoreA}/100 and ${playerB.name} scored ${cleanScoreB}/100.`
      ),

      teamAAnalysis,
      teamBAnalysis,

      analysisStatus: 'complete'
    });
  }

  if (actualPairSet.size !== expectedPairSet.size) {
    throw new Error(
      'Gemini did not evaluate every head-to-head matchup.'
    );
  }

  const evaluations = room.players.map(player =>
    evaluationMap.get(player.id)
  );

  const standings = calculateStandings(
    room,
    matches,
    evaluations
  );

  return {
    matches,
    standings,
    totalMatches: matches.length,
    completedAt: Date.now(),

    overallSummary: safeText(
      parsed.overallSummary,
      'The championship has been evaluated.'
    ),

    rankingExplanation: safeText(
      parsed.rankingExplanation,
      'Rankings are calculated from validated head-to-head matchup results.'
    ),

    aiEvaluation: {
      provider: 'Gemini',
      status: 'complete',
      message:
        'All team evaluations, head-to-head matchups and character-by-character analyses were validated.'
    },

    rankingRules: [
      'Match win: 3 points',
      'Match draw: 1 point',
      'Match loss: 0 points',
      'Tiebreakers: wins, score difference, then Gemini team evaluation score'
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

    overallSummary: 'Evaluating every team and character matchup...',

    rankingExplanation:
      'Gemini is analysing the individual characters and team combinations.',

    aiEvaluation: {
      provider: 'Gemini',
      status: 'evaluating',
      message: 'Character-by-character evaluation is in progress.'
    },

    rankingRules: []
  };

  emitRoom(room);

  try {
    const evaluation = await evaluateChampionshipWithGemini(room);

    if (!rooms.has(room.code)) return;

    room.championship = evaluation;

    emitRoom(room);

    console.log(
      `Gemini character-by-character championship completed for ${room.code}`
    );

  } catch (error) {
    console.error(
      'Gemini championship evaluation failed:',
      error
    );

    if (!rooms.has(room.code)) return;

    room.championship = createFallbackChampionship(
      room,
      error.message
    );

    emitRoom(room);
  }
}

// --------------------------------------------------
// HOST VALIDATION
// --------------------------------------------------

function isHost(room, socket) {
  if (!room || room.hostId !== socket.id) {
    socket.emit(
      'error:message',
      'Only the host can perform this action.'
    );

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
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: 'Gemini is not configured. Add GEMINI_API_KEY to Render.'
    });
  }

  const genre = String(req.body?.universe || '').trim();

  if (!GENRES.includes(genre)) {
    return res.status(400).json({
      error: 'Choose one of the supported genres.'
    });
  }

  try {
    const characters = await getGenreCharacters(genre);

    res.json({
      note: 'Epic character lists contain warriors only. Other generated entries should be reviewed for accuracy.',
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
      return socket.emit(
        'error:message',
        'Room not found or game already started.'
      );
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

    const room = [...rooms.values()].find(
      r => r.hostId === socket.id
    );

    if (!room || room.status !== 'lobby') return;

    if (room.players.length < 2) {
      return socket.emit(
        'error:message',
        'At least two players are required.'
      );
    }

    if (!process.env.GEMINI_API_KEY) {
      return socket.emit(
        'error:message',
        'Gemini API key is missing. Add GEMINI_API_KEY to Render.'
      );
    }

    const parsedTeamSize = Number(teamSize);
    const parsedTurnSeconds = Number(turnSeconds);
    const parsedStartingBid = Number(startingBid);

    if (
      !Number.isInteger(parsedTeamSize) ||
      parsedTeamSize < 1 ||
      parsedTeamSize > 20
    ) {
      return socket.emit(
        'error:message',
        'Team size must be between 1 and 20.'
      );
    }

    if (
      !Number.isInteger(parsedTurnSeconds) ||
      parsedTurnSeconds < 5 ||
      parsedTurnSeconds > 120
    ) {
      return socket.emit(
        'error:message',
        'Turn duration must be between 5 and 120 seconds.'
      );
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
      return socket.emit(
        'error:message',
        'Choose at least one available genre.'
      );
    }

    const requiredCharacters =
      room.players.length * parsedTeamSize;

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
          `Not enough characters. You need ${requiredCharacters}, but only ${uniqueCharacters.length} unique characters are available. Choose more genres or reduce the team size.`
        );

        emitRoom(room);
        return;
      }

      room.characters = shuffle(uniqueCharacters)
        .slice(0, requiredCharacters);

      await attachCharacterImages(room.characters);

      if (
        room.status !== 'loading_characters' ||
        !rooms.has(room.code)
      ) {
        return;
      }

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
    const room = [...rooms.values()].find(
      r => r.hostId === socket.id
    );

    if (!isHost(room, socket)) return;

    if (room.status !== 'auction_ready') {
      return socket.emit(
        'error:message',
        'The next character is not ready yet.'
      );
    }

    if (room.characterIndex + 1 >= room.characters.length) {
      return completeAuction(room);
    }

    room.characterIndex++;

    room.currentCharacter =
      clone(room.characters[room.characterIndex]);

    room.currentBid = room.settings.startingBid;
    room.highestBidderId = null;
    room.lastBidderId = null;
    room.noIncreaseTurns = 0;
    room.passedPlayerIds = new Set();

    room.openingPlayerId =
      room.nextOpeningPlayerId || room.hostId;

    let openingPlayer = findPlayer(
      room,
      room.openingPlayerId
    );

    if (
      !openingPlayer ||
      !openingPlayer.connected ||
      !canBid(openingPlayer, room)
    ) {
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
      return socket.emit(
        'error:message',
        'It is not your turn.'
      );
    }

    if (!room.turnDeadline || Date.now() > room.turnDeadline) {
      return socket.emit(
        'error:message',
        'Your turn has expired.'
      );
    }

    const player = findPlayer(room, socket.id);
    const increment = Number(amount);

    if (!Number.isInteger(increment) || increment < 1) {
      return socket.emit(
        'error:message',
        'Enter a whole-number increase of at least ₹1.'
      );
    }

    if (player.team.length >= room.settings.teamSize) {
      return socket.emit('error:message', 'Your team is full.');
    }

    const newBid = room.currentBid + increment;

    if (newBid > player.budget) {
      return socket.emit(
        'error:message',
        'That bid exceeds your remaining budget.'
      );
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
      return socket.emit(
        'error:message',
        'It is not your turn.'
      );
    }

    if (!room.turnDeadline || Date.now() > room.turnDeadline) {
      return socket.emit(
        'error:message',
        'Your turn has expired.'
      );
    }

    passTurn(room, 'SKIP');
  });

  // HOST STARTS TEAM COMPARISON
  socket.on('championship:start', async () => {
    const room = [...rooms.values()].find(
      r => r.hostId === socket.id
    );

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

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  res.sendFile(
    path.join(__dirname, '..', 'dist', 'index.html')
  );
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

server.listen(PORT, () => {
  console.log(`BATTLE AUCTION server listening on ${PORT}`);
});
