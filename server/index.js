
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
const genreCache = new Map();

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

// Existing approved characters retained as additional catalogue entries.
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
    description: 'Peter Parker is a brilliant young hero whose spider-like abilities combine extraordinary agility, danger awareness and web-based mobility.',
    combatStyle: 'Fast, mobile and improvisational',
    sources: ['https://www.marvel.com/characters/spider-man-peter-parker']
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
    description: 'Tony Stark is an inventor who uses advanced powered armour and technological tools.',
    combatStyle: 'Technology-driven ranged combat',
    sources: ['https://www.marvel.com/characters/iron-man-tony-stark']
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
    description: 'Thor is an Asgardian warrior with immense strength and control over storm energy.',
    combatStyle: 'Powerful close combat and storm-based attacks',
    sources: ['https://www.marvel.com/characters/thor-thor-odinson']
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
    combatStyle: 'Strategic, technical and stealth-oriented',
    sources: ['https://www.dc.com/characters/batman']
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
    description: 'Clark Kent is a Kryptonian whose abilities include exceptional strength, speed and flight.',
    combatStyle: 'High-power physical and ranged combat',
    sources: ['https://www.dc.com/characters/superman']
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
    combatStyle: 'Disciplined close combat and tactical defence',
    sources: ['https://www.dc.com/characters/wonder-woman']
  },
  {
    id: 'ramayana-hanuman',
    name: 'Hanuman',
    universe: 'Ramayana',
    version: 'Traditional epic',
    rating: 98,
    abilities: ['Immense strength', 'Flight', 'Form-changing'],
    strengths: ['Devotion', 'Strength', 'Resilience'],
    weaknesses: ['Tradition-specific interpretations'],
    description: 'Hanuman is revered in the Ramayana for extraordinary strength, courage, wisdom and devotion.',
    combatStyle: 'Mythological strength and extraordinary mobility',
    sources: ['https://www.valmiki.iitk.ac.in/']
  },
  {
    id: 'mahabharata-arjuna',
    name: 'Arjuna',
    universe: 'Mahabharata',
    version: 'Traditional epic',
    rating: 91,
    abilities: ['Archery', 'Divine astras', 'Warfare'],
    strengths: ['Precision', 'Discipline', 'Combat skill'],
    weaknesses: ['Weapon and context constraints'],
    description: 'Arjuna is one of the central warriors of the Mahabharata, renowned for exceptional archery.',
    combatStyle: 'Precision archery and traditional warfare',
    sources: ['https://www.sacred-texts.com/hin/']
  }
];

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

function extractJSON(text) {
  const cleaned = String(text || '')
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

    throw new Error('Gemini did not return valid JSON.');
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

// Generate one batch at a time to reduce the risk of oversized responses.
// A genre can contain fewer than 100 characters if Gemini cannot supply
// 100 valid, distinct entries.
async function generateGenreCharacters(genre) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini API key is missing. Add GEMINI_API_KEY in Render.');
  }

  const genAI = new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY
  );

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json'
    }
  });

  const generated = [];
  const seen = new Set();

  for (let batch = 0; batch < 4; batch++) {
    const remaining = 100 - generated.length;

    if (remaining <= 0) break;

    const count = Math.min(25, remaining);

    const prompt = `
Create up to ${count} distinct, established entries for the genre "${genre}".

The entries will be used in a friendly character/team auction game.

Rules:
- For Ramayana and Mahabharata, use established figures from the respective epic traditions.
- For Football and Cricket, use real, established players from the sport.
- For Marvel and DC, use established characters from the respective universes.
- For Harry Potter, use established characters from the Harry Potter universe.
- For Anime, use established characters from well-known anime series.
- Do not invent characters.
- Do not repeat the same person or character.
- For sports, use a suitable playing career or era in the version field.
- Ratings are subjective GAME ratings from 1 to 100, not official statistics.
- Keep descriptions concise.
- Return fewer entries if you cannot provide the requested number reliably.

Return valid JSON only in this exact structure:
{
  "characters": [
    {
      "name": "Name",
      "version": "Version, series, team or era",
      "rating": 85,
      "abilities": ["Ability 1", "Ability 2"],
      "strengths": ["Strength 1", "Strength 2"],
      "weaknesses": ["Weakness 1"],
      "description": "Short description",
      "combatStyle": "Short description of playing or combat style"
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
        const character = normalizeCharacter(raw, genre);

        if (!character) continue;

        const key = character.name.toLowerCase();

        if (seen.has(key)) continue;

        seen.add(key);
        generated.push(character);

        if (generated.length >= 100) break;
      }
    } catch (error) {
      console.warn(
        `Gemini batch ${batch + 1} failed for ${genre}:`,
        error.message
      );

      // Continue with other batches instead of failing the whole genre.
    }
  }

  // Add existing approved seed characters from this genre.
  for (const seed of SEED_CHARACTERS.filter(
    character => character.universe === genre
  )) {
    const key = seed.name.toLowerCase();

    if (!seen.has(key) && generated.length < 100) {
      seen.add(key);
      generated.push(clone(seed));
    }
  }

  return generated.slice(0, 100);
}

async function getGenreCharacters(genre) {
  if (!GENRES.includes(genre)) {
    throw new Error(`Unsupported genre: ${genre}`);
  }

  if (genreCache.has(genre)) {
    return genreCache.get(genre);
  }

  const generationPromise = generateGenreCharacters(genre);

  genreCache.set(genre, generationPromise);

  try {
    return await generationPromise;
  } catch (error) {
    genreCache.delete(genre);
    throw error;
  }
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  return Array.from(
    { length: 6 },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}

// A player sees their own team.
// All teams become visible when the championship begins.
function publicRoom(room, viewerId) {
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
        room.status === 'championship' || player.id === viewerId
          ? player.team
          : [],
      connected: player.connected
    })),

    characters: room.characters,
    characterIndex: room.characterIndex,
    currentCharacter: room.currentCharacter,
    currentBid: room.currentBid,
    highestBidderId: room.highestBidderId,
    currentTurnIndex: room.currentTurnIndex,
    turnDeadline: room.turnDeadline,
    noIncreaseTurns: room.noIncreaseTurns,
    lastBidderId: room.lastBidderId,
    openingPlayerId: room.openingPlayerId,
    nextOpeningPlayerId: room.nextOpeningPlayerId,
    auctionLog: room.auctionLog,
    results: room.results,
    championship: room.championship,
    reserveCount: room.reserveCharacters.length,
    completionError: room.completionError
  };
}

function emitRoom(room) {
  // Send a different team view to each player.
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

function getCurrentPlayer(room) {
  const players = activePlayers(room);

  if (!players.length) return null;

  room.currentTurnIndex =
    ((room.currentTurnIndex % players.length) + players.length) % players.length;

  return players[room.currentTurnIndex];
}

function canBid(player, room) {
  return Boolean(
    player &&
    player.connected &&
    player.team.length < room.settings.teamSize &&
    player.budget >= room.currentBid + 1
  );
}

function beginTurn(room) {
  stopTimer(room.code);

  if (room.status !== 'auction') return;

  const players = activePlayers(room);

  if (!players.length) {
    room.turnDeadline = null;
    room.status = 'auction_paused';
    emitRoom(room);
    return;
  }

  if (room.noIncreaseTurns >= players.length) {
    return resolveAuction(room);
  }

  let tries = 0;

  while (tries < players.length) {
    const player = getCurrentPlayer(room);

    // Once the previous highest bidder's turn comes around again,
    // the auction ends. This gives everyone else a chance to respond.
    if (
      room.highestBidderId &&
      player?.id === room.highestBidderId
    ) {
      return resolveAuction(room);
    }

    if (canBid(player, room)) break;

    room.noIncreaseTurns++;
    room.currentTurnIndex =
      (room.currentTurnIndex + 1) % players.length;

    tries++;

    if (room.noIncreaseTurns >= players.length) {
      return resolveAuction(room);
    }
  }

  if (tries >= players.length) {
    return resolveAuction(room);
  }

  room.turnDeadline =
    Date.now() + room.settings.turnSeconds * 1000;

  emitRoom(room);

  const delay = Math.max(0, room.turnDeadline - Date.now());

  turnTimers.set(room.code, setTimeout(() => {
    const currentRoom = rooms.get(room.code);

    if (
      !currentRoom ||
      currentRoom.status !== 'auction' ||
      Date.now() < currentRoom.turnDeadline
    ) return;

    passTurn(currentRoom, 'TIMEOUT');
  }, delay + 20));
}

function nextTurn(room) {
  const players = activePlayers(room);

  if (!players.length) {
    room.status = 'auction_paused';
    room.turnDeadline = null;
    emitRoom(room);
    return;
  }

  room.currentTurnIndex =
    (room.currentTurnIndex + 1) % players.length;

  beginTurn(room);
}

function passTurn(room, reason = 'SKIP') {
  if (room.status !== 'auction') return;

  stopTimer(room.code);

  const player = getCurrentPlayer(room);

  room.noIncreaseTurns++;

  room.auctionLog.push({
    type: reason,
    playerId: player?.id || null,
    at: Date.now()
  });

  nextTurn(room);
}

function resolveAuction(room) {
  stopTimer(room.code);

  if (room.status !== 'auction' || !room.currentCharacter) return;

  const character = room.currentCharacter;
  const winnerId = room.lastBidderId;

  const winner = room.players.find(player =>
    player.id === winnerId
  );

  if (
    winner &&
    winner.connected &&
    winner.budget >= room.currentBid &&
    winner.team.length < room.settings.teamSize
  ) {
    winner.budget -= room.currentBid;

    winner.team.push({
      ...clone(character),
      paid: room.currentBid
    });

    room.results.push({
      characterId: character.id,
      characterName: character.name,
      winnerId: winner.id,
      winnerName: winner.name,
      amount: room.currentBid
    });
  } else {
    room.reserveCharacters.push(clone(character));

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
    winnerId: winner?.id || null,
    at: Date.now()
  });

  // The winner starts the next auction.
  if (winner && winner.id) {
    room.nextOpeningPlayerId = winner.id;
  } else {
    room.nextOpeningPlayerId =
      room.openingPlayerId || room.hostId;
  }

  room.status = 'auction_ready';
  room.turnDeadline = null;
  room.currentTurnIndex = 0;
  room.highestBidderId = null;
  room.lastBidderId = null;
  room.noIncreaseTurns = 0;

  if (room.characterIndex >= room.characters.length - 1) {
    completeAuction(room);
    return;
  }

  emitRoom(room);
}

function completeAuction(room) {
  stopTimer(room.code);

  const emptySlots = [];

  for (const player of room.players) {
    while (player.team.length < room.settings.teamSize) {
      emptySlots.push(player);
    }
  }

  const assignedCharacterIds = new Set();

  for (const player of room.players) {
    for (const character of player.team) {
      assignedCharacterIds.add(character.id);
    }
  }

  const availableCharacters = room.characters.filter(
    character => !assignedCharacterIds.has(character.id)
  );

  const freePool = shuffle(availableCharacters);

  if (freePool.length < emptySlots.length) {
    room.status = 'incomplete';
    room.turnDeadline = null;
    room.currentCharacter = null;

    room.completionError =
      `Not enough unused characters. ${emptySlots.length} slots are empty, but only ${freePool.length} unused characters remain.`;

    emitRoom(room);
    return;
  }

  // Fill all empty team slots with free characters.
  emptySlots.forEach((player, index) => {
    const character = freePool[index];

    player.team.push({
      ...clone(character),
      paid: 0,
      allocatedFree: true
    });
  });

  room.reserveCharacters = freePool.slice(emptySlots.length);

  room.currentCharacter = null;
  room.turnDeadline = null;
  room.completionError = null;

  // First show each player only their own completed team.
  room.status = 'team_reveal';

  emitRoom(room);

  // After 10 seconds, the host can compare all teams.
  setTimeout(() => {
    const currentRoom = rooms.get(room.code);

    if (!currentRoom || currentRoom.status !== 'team_reveal') {
      return;
    }

    currentRoom.status = 'ready_for_fight';
    emitRoom(currentRoom);
  }, 10000);
}

function calculateTeamStrength(team) {
  if (!team.length) return 0;

  const ratings = team.reduce(
    (total, character) => total + Number(character.rating || 0),
    0
  );

  const allStrengths = new Set(
    team.flatMap(character => character.strengths || [])
  );

  const allAbilities = new Set(
    team.flatMap(character => character.abilities || [])
  );

  const synergy = Math.min(
    5,
    Math.floor((allStrengths.size + allAbilities.size) / team.length)
  );

  return Math.round(ratings / team.length + synergy);
}

function createMatch(teamA, teamB) {
  const scoreA = calculateTeamStrength(teamA.team);
  const scoreB = calculateTeamStrength(teamB.team);

  let winnerId = null;
  let result = 'DRAW';

  if (scoreA > scoreB) {
    winnerId = teamA.id;
    result = 'TEAM_A_WINS';
  } else if (scoreB > scoreA) {
    winnerId = teamB.id;
    result = 'TEAM_B_WINS';
  }

  const explanation = result === 'DRAW'
    ? 'Both teams have the same calculated strength. The match is recorded as a draw.'
    : `${winnerId === teamA.id ? teamA.name : teamB.name} wins with a calculated team strength of ${Math.max(scoreA, scoreB)} compared with ${Math.min(scoreA, scoreB)}.`;

  return {
    teamAId: teamA.id,
    teamAName: teamA.name,
    teamBId: teamB.id,
    teamBName: teamB.name,
    scoreA,
    scoreB,
    winnerId,
    result,
    explanation
  };
}

function startChampionship(room) {
  const matches = [];

  for (let i = 0; i < room.players.length; i++) {
    for (let j = i + 1; j < room.players.length; j++) {
      matches.push(createMatch(room.players[i], room.players[j]));
    }
  }

  const standings = room.players.map(player => {
    const played = matches.filter(match =>
      match.teamAId === player.id || match.teamBId === player.id
    );

    const wins = played.filter(match =>
      match.winnerId === player.id
    ).length;

    const draws = played.filter(match =>
      match.result === 'DRAW'
    ).length;

    const losses = played.length - wins - draws;
    const points = wins * 3 + draws;

    const scoreDifference = played.reduce((total, match) => {
      if (match.teamAId === player.id) {
        return total + match.scoreA - match.scoreB;
      }

      return total + match.scoreB - match.scoreA;
    }, 0);

    return {
      playerId: player.id,
      name: player.name,
      wins,
      draws,
      losses,
      points,
      scoreDifference,
      teamStrength: calculateTeamStrength(player.team),
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

    if (key !== previousKey) rank = index + 1;

    standing.rank = rank;
    previousKey = key;
  });

  room.championship = {
    matches,
    standings,
    totalMatches: matches.length,
    completedAt: Date.now(),
    rankingRules: [
      'Match win: 3 points',
      'Match draw: 1 point',
      'Match loss: 0 points',
      'Tiebreakers: wins, score difference, then team strength'
    ]
  };

  room.status = 'championship';

  emitRoom(room);
}

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

// API ROUTES

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
      note: 'AI-generated entries should be reviewed for accuracy.',
      count: characters.length,
      characters
    });
  } catch (error) {
    res.status(502).json({
      error: 'Gemini character generation failed.',
      detail: error.message
    });
  }
});

// SOCKET EVENTS

io.on('connection', socket => {

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
      openingPlayerId: socket.id,
      nextOpeningPlayerId: socket.id,
      turnDeadline: null,
      noIncreaseTurns: 0,
      auctionLog: [],
      results: [],
      reserveCharacters: [],
      championship: null,
      completionError: null
    };

    rooms.set(code, room);
    socket.join(code);

    socket.emit('room:created', publicRoom(room, socket.id));
    emitRoom(room);
  });

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

    // Prevent another start request while Gemini is generating.
    room.status = 'loading_characters';
    room.completionError = null;
    emitRoom(room);

    try {
      const genrePools = [];

      // Generate/cache each selected genre.
      for (const genre of selectedGenres) {
        const characters = await getGenreCharacters(genre);
        genrePools.push(...characters);
      }

      // Remove duplicates across selected genres.
      const uniqueCharacters = [];
      const seenIds = new Set();

      for (const character of genrePools) {
        if (seenIds.has(character.id)) continue;

        seenIds.add(character.id);
        uniqueCharacters.push(character);
      }

      if (uniqueCharacters.length < requiredCharacters) {
        room.status = 'lobby';

        const message =
          `Not enough characters are available. ` +
          `You need ${requiredCharacters}, but Gemini and the approved catalogue returned ` +
          `${uniqueCharacters.length} unique characters. ` +
          `Choose more genres or reduce the team size.`;

        socket.emit('error:message', message);
        emitRoom(room);
        return;
      }

      // Select only the number required for all team slots.
      // The remaining catalogue entries are not auction rounds.
      const selectedCharacters =
        shuffle(uniqueCharacters).slice(0, requiredCharacters);

      room.characters = selectedCharacters;

      if (room.status !== 'loading_characters' || !rooms.has(room.code)) {
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

      // First auction starts with the host.
      room.openingPlayerId = room.hostId;
      room.nextOpeningPlayerId = room.hostId;

      room.turnDeadline = null;
      room.noIncreaseTurns = 0;
      room.auctionLog = [];
      room.results = [];
      room.reserveCharacters = [];
      room.championship = null;
      room.completionError = null;
      room.status = 'auction_ready';

      emitRoom(room);

    } catch (error) {
      console.error('Room character generation failed:', error);

      room.status = 'lobby';

      socket.emit(
        'error:message',
        `Character generation failed: ${error.message}`
      );

      emitRoom(room);
    }
  });

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

    // Previous auction winner opens this auction.
    const active = activePlayers(room);

    room.openingPlayerId =
      room.nextOpeningPlayerId || room.hostId;

    let openingIndex = active.findIndex(
      player => player.id === room.openingPlayerId
    );

    if (openingIndex < 0) {
      openingIndex = active.findIndex(
        player => player.id === room.hostId
      );
    }

    if (openingIndex < 0) openingIndex = 0;

    room.currentTurnIndex = openingIndex;
    room.turnDeadline = null;
    room.status = 'auction';

    beginTurn(room);
  });

  socket.on('bid:increase', ({ amount } = {}) => {
    const room = findRoomForSocket(socket.id);

    if (!room || room.status !== 'auction') return;

    const current = getCurrentPlayer(room);

    if (
      !current ||
      current.id !== socket.id ||
      Date.now() > room.turnDeadline
    ) {
      return socket.emit(
        'error:message',
        'It is not your turn or your turn has expired.'
      );
    }

    const player = room.players.find(
      p => p.id === socket.id
    );

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
    room.noIncreaseTurns = 0;

    room.auctionLog.push({
      type: 'BID',
      playerId: player.id,
      amount: newBid,
      increment,
      at: Date.now()
    });

    nextTurn(room);
  });

  socket.on('bid:skip', () => {
    const room = findRoomForSocket(socket.id);

    if (!room || room.status !== 'auction') return;

    const current = getCurrentPlayer(room);

    if (
      !current ||
      current.id !== socket.id ||
      Date.now() > room.turnDeadline
    ) {
      return socket.emit(
        'error:message',
        'It is not your turn or your turn has expired.'
      );
    }

    passTurn(room, 'SKIP');
  });

  socket.on('championship:start', () => {
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
        `${incompletePlayer.name}'s team is not complete yet.`
      );
    }

    startChampionship(room);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = room.players.find(
        p => p.id === socket.id
      );

      if (!player) continue;

      const previousCurrentId =
        room.status === 'auction'
          ? getCurrentPlayer(room)?.id
          : null;

      player.connected = false;

      if (room.status === 'auction') {
        const remainingPlayers = activePlayers(room);

        if (previousCurrentId === socket.id) {
          stopTimer(room.code);
          room.noIncreaseTurns++;

          if (remainingPlayers.length) {
            room.currentTurnIndex =
              room.currentTurnIndex % remainingPlayers.length;

            beginTurn(room);
          } else {
            room.status = 'auction_paused';
            room.turnDeadline = null;
            emitRoom(room);
          }
        } else {
          const newIndex = remainingPlayers.findIndex(
            activePlayer => activePlayer.id === previousCurrentId
          );

          if (newIndex >= 0) {
            room.currentTurnIndex = newIndex;
          }

          emitRoom(room);
        }
      } else {
        emitRoom(room);
      }
    }
  });

});

app.use(express.static(path.join(__dirname, '..', 'dist')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  res.sendFile(
    path.join(__dirname, '..', 'dist', 'index.html')
  );
});

server.listen(PORT, () => {
  console.log(`BATTLE AUCTION server listening on ${PORT}`);
});
