
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
    rating: 98,
    abilities: ['Immense strength', 'Flight', 'Form-changing'],
    strengths: ['Devotion', 'Strength', 'Resilience'],
    weaknesses: ['Tradition-specific interpretations'],
    description: 'Hanuman is revered for extraordinary strength, courage and devotion.',
    combatStyle: 'Mythological strength and mobility',
    sources: []
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

// --------------------------------------------------
// GEMINI CHARACTER GENERATION
// --------------------------------------------------

async function generateGenreCharacters(genre) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('Gemini API key is missing. Add GEMINI_API_KEY in Render.');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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
Create up to ${count} distinct established entries for "${genre}".

Rules:
- Ramayana and Mahabharata: established figures from the epic traditions.
- Football and Cricket: real established players.
- Marvel and DC: established characters from those universes.
- Harry Potter: established characters from that universe.
- Anime: established characters from well-known anime series.
- Do not invent characters.
- Do not repeat characters.
- Ratings are subjective game ratings from 1 to 100.
- Keep descriptions concise.
- Return fewer entries if necessary.

Return JSON only:
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
      "combatStyle": "Playing or combat style"
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
        `Character batch ${batch + 1} failed for ${genre}:`,
        error.message
      );
    }
  }

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
    currentTurnIndex: room.currentTurnIndex,
    turnDeadline: room.turnDeadline,
    noIncreaseTurns: room.noIncreaseTurns,
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
    ((room.currentTurnIndex % players.length) + players.length) %
    players.length;

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

// --------------------------------------------------
// AUCTION TIMER AND TURN MANAGEMENT
// --------------------------------------------------

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

  let attempts = 0;

  while (attempts < players.length) {
    if (room.noIncreaseTurns >= players.length) {
      return resolveAuction(room);
    }

    const player = getCurrentPlayer(room);

    // The turn has returned to the highest bidder.
    // They win the character.
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

    attempts++;
  }

  if (
    attempts >= players.length ||
    room.noIncreaseTurns >= players.length
  ) {
    return resolveAuction(room);
  }

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

// --------------------------------------------------
// RESOLVE THE CURRENT AUCTION
// --------------------------------------------------

function resolveAuction(room) {
  if (room.status !== 'auction' || !room.currentCharacter) return;

  stopTimer(room.code);

  const character = clone(room.currentCharacter);
  const winnerId = room.lastBidderId;

  const winner = room.players.find(
    player => player.id === winnerId
  );

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
  room.currentBid = room.settings.startingBid;
  room.highestBidderId = null;
  room.lastBidderId = null;
  room.noIncreaseTurns = 0;
  room.currentTurnIndex = 0;
  room.status = 'auction_ready';

  // The last character has now been awarded or reserved.
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
  stopTimer(room.code);

  const emptySlots = [];

  for (const player of room.players) {
    while (player.team.length < room.settings.teamSize) {
      emptySlots.push(player);
    }
  }

  const assignedIds = new Set();

  for (const player of room.players) {
    for (const character of player.team) {
      assignedIds.add(character.id);
    }
  }

  // Every selected character not already owned is available.
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

  // Give free characters to players with empty slots.
  // Their wallet balance does not matter.
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
  room.completionError = null;

  // Each player sees only their own team.
  room.status = 'team_reveal';
  emitRoom(room);

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

function createFallbackChampionship(room) {
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
        explanation: 'Fallback comparison based on team ratings.'
      });
    }
  }

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

  return {
    matches,
    standings,
    totalMatches: matches.length,
    completedAt: Date.now(),
    aiEvaluation: {
      provider: 'Gemini',
      status: 'unavailable',
      message: 'Using fallback character-rating comparison.'
    },
    rankingRules: [
      'Match win: 3 points',
      'Match draw: 1 point',
      'Match loss: 0 points',
      'Tiebreakers: wins, score difference, then team strength'
    ]
  };
}

// --------------------------------------------------
// GEMINI TEAM COMPARISON AND FINAL RANKINGS
// --------------------------------------------------

async function evaluateChampionshipWithGemini(room) {
  const genAI = new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY
  );

  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    generationConfig: {
      responseMimeType: 'application/json'
    }
  });

  const teams = room.players.map(player => ({
    playerId: player.id,
    playerName: player.name,
    characters: player.team.map(character => ({
      name: character.name,
      genre: character.universe,
      rating: character.rating,
      abilities: character.abilities,
      strengths: character.strengths,
      weaknesses: character.weaknesses,
      description: character.description,
      style: character.combatStyle
    }))
  }));

  const prompt = `
You are the neutral judge of a friendly team-building championship.

Compare every team fairly using:
- Individual character abilities and ratings.
- Strengths and weaknesses.
- Team balance and compatibility.
- Complementary abilities and overall team composition.

For Football and Cricket, consider sporting ability and team balance.
For fictional teams, consider the supplied character abilities.
Do not invent abilities.
Do not favour a team merely because it has famous characters.

Give each team a score from 1 to 100.
Explain the reasoning briefly.

Return JSON only in this structure:

{
  "teams": [
    {
      "playerId": "EXACT_PLAYER_ID",
      "score": 90,
      "summary": "Explanation of the team's strengths and weaknesses"
    }
  ]
}

Include every player exactly once.
Use the exact playerId values provided.

TEAMS:
${JSON.stringify(teams)}
`;

  const result = await model.generateContent(prompt);
  const parsed = extractJSON(result.response.text());

  if (!Array.isArray(parsed.teams)) {
    throw new Error('Gemini did not return a valid team list.');
  }

  const scoreMap = new Map();

  for (const entry of parsed.teams) {
    const score = Math.round(Number(entry.score));

    if (
      room.players.some(player => player.id === entry.playerId) &&
      Number.isFinite(score)
    ) {
      scoreMap.set(entry.playerId, {
        score: Math.max(1, Math.min(100, score)),
        summary: String(
          entry.summary || 'Team evaluated by Gemini.'
        ).slice(0, 500)
      });
    }
  }

  if (scoreMap.size !== room.players.length) {
    throw new Error('Gemini did not evaluate every team.');
  }

  const evaluatedPlayers = room.players.map(player => ({
    ...player,
    aiScore: scoreMap.get(player.id).score,
    aiSummary: scoreMap.get(player.id).summary
  }));

  // Generate every head-to-head comparison.
  const matches = [];

  for (let i = 0; i < evaluatedPlayers.length; i++) {
    for (let j = i + 1; j < evaluatedPlayers.length; j++) {
      const a = evaluatedPlayers[i];
      const b = evaluatedPlayers[j];

      let winnerId = null;
      let result = 'DRAW';

      if (a.aiScore > b.aiScore) {
        winnerId = a.id;
        result = 'TEAM_A_WINS';
      } else if (b.aiScore > a.aiScore) {
        winnerId = b.id;
        result = 'TEAM_B_WINS';
      }

      matches.push({
        teamAId: a.id,
        teamAName: a.name,
        teamBId: b.id,
        teamBName: b.name,
        scoreA: a.aiScore,
        scoreB: b.aiScore,
        winnerId,
        result,
        explanation:
          `${a.name}: ${a.aiScore}/100. ${a.aiSummary} ` +
          `${b.name}: ${b.aiScore}/100. ${b.aiSummary}`
      });
    }
  }

  const standings = evaluatedPlayers.map(player => {
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

    return {
      playerId: player.id,
      name: player.name,
      wins,
      draws,
      losses,
      points,
      scoreDifference,
      teamStrength: player.aiScore,
      aiSummary: player.aiSummary,
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

  return {
    matches,
    standings,
    totalMatches: matches.length,
    completedAt: Date.now(),
    aiEvaluation: {
      provider: 'Gemini',
      status: 'complete'
    },
    rankingRules: [
      'Match win: 3 points',
      'Match draw: 1 point',
      'Match loss: 0 points',
      'Tiebreakers: wins, score difference, then Gemini team score'
    ]
  };
}

async function startChampionship(room) {
  if (room.status !== 'ready_for_fight') return;

  const incompletePlayer = room.players.find(
    player => player.team.length !== room.settings.teamSize
  );

  if (incompletePlayer) {
    return;
  }

  // Reveal all teams to everyone and show a loading result.
  room.status = 'championship';
  room.championship = {
    matches: [],
    standings: [],
    totalMatches: 0,
    completedAt: null,
    aiEvaluation: {
      provider: 'Gemini',
      status: 'evaluating'
    },
    rankingRules: []
  };

  emitRoom(room);

  try {
    room.championship = await evaluateChampionshipWithGemini(room);
    emitRoom(room);

    console.log(`Gemini rankings completed for ${room.code}`);
  } catch (error) {
    console.error('Gemini team comparison failed:', error);

    room.championship = createFallbackChampionship(room);
    room.championship.aiEvaluation.message =
      'Gemini comparison could not be completed. Fallback rankings are displayed.';

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
      openingPlayerId: socket.id,
      nextOpeningPlayerId: socket.id,
      turnDeadline: null,
      turnToken: 0,
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
          `Not enough characters. You need ${requiredCharacters}, but only ${uniqueCharacters.length} unique characters were generated. Choose more genres or reduce the team size.`
        );

        emitRoom(room);
        return;
      }

      // Exactly one auction character per team slot.
      room.characters = shuffle(uniqueCharacters)
        .slice(0, requiredCharacters);

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
      room.openingPlayerId = room.hostId;
      room.nextOpeningPlayerId = room.hostId;
      room.turnDeadline = null;
      room.turnToken = 0;
      room.noIncreaseTurns = 0;
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

    const players = activePlayers(room);

    room.openingPlayerId =
      room.nextOpeningPlayerId || room.hostId;

    let openingIndex = players.findIndex(
      player => player.id === room.openingPlayerId
    );

    if (openingIndex < 0) {
      openingIndex = players.findIndex(
        player => player.id === room.hostId
      );
    }

    if (openingIndex < 0) openingIndex = 0;

    room.currentTurnIndex = openingIndex;
    room.turnDeadline = null;
    room.status = 'auction';

    beginTurn(room);
  });

  // INCREASE BID
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

  // SKIP TURN
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
