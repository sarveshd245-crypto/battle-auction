
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

const IMAGE_TITLES = {
  'marvel-spider-man': 'Spider-Man',
  'marvel-iron-man': 'Iron Man',
  'marvel-thor': 'Thor (Marvel Comics)',
  'dc-batman': 'Batman',
  'dc-superman': 'Superman',
  'dc-wonder-woman': 'Wonder Woman',
  'naruto-naruto': 'Naruto Uzumaki',
  'naruto-sasuke': 'Sasuke Uchiha',
  'dragonball-goku': 'Goku',
  'dragonball-vegeta': 'Vegeta',
  'ramayana-hanuman': 'Hanuman',
  'mahabharata-arjuna': 'Arjuna'
};

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
    description: 'Peter Parker is a brilliant young hero whose spider-like abilities combine extraordinary agility, danger awareness and web-based mobility. His scientific creativity and quick thinking make him effective in unpredictable situations.',
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
    description: 'Tony Stark is an inventor who uses advanced powered armour, intelligent systems and a wide range of technological tools.',
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
    description: 'Thor is an Asgardian warrior with immense physical strength and control over powerful storm energy.',
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
    description: 'Bruce Wayne is a highly trained detective and strategist who combines scientific equipment, investigative ability and martial arts.',
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
    description: 'Clark Kent is a Kryptonian whose abilities include exceptional strength, speed, flight and energy projection.',
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
    description: 'Diana is an Amazonian warrior known for her strength, discipline and extensive combat experience.',
    combatStyle: 'Disciplined close combat and tactical defence',
    sources: ['https://www.dc.com/characters/wonder-woman']
  },
  {
    id: 'naruto-naruto',
    name: 'Naruto Uzumaki',
    universe: 'Naruto',
    version: 'End-of-series',
    rating: 95,
    abilities: ['Shadow clones', 'Sage powers', 'Kurama chakra'],
    strengths: ['Chakra reserves', 'Versatility', 'Resilience'],
    weaknesses: ['Specific power-state limits'],
    description: 'Naruto is a highly versatile ninja whose techniques, chakra reserves and ability to adapt allow him to approach challenges in many different ways.',
    combatStyle: 'Versatile ninjutsu and high-energy combat',
    sources: ['https://naruto-official.com/en']
  },
  {
    id: 'naruto-sasuke',
    name: 'Sasuke Uchiha',
    universe: 'Naruto',
    version: 'End-of-series',
    rating: 94,
    abilities: ['Sharingan', 'Rinnegan-era techniques', 'Lightning release'],
    strengths: ['Perception', 'Ninjutsu', 'Tactics'],
    weaknesses: ['Chakra constraints'],
    description: 'Sasuke is an exceptionally skilled shinobi who combines advanced visual abilities, lightning techniques and tactical intelligence.',
    combatStyle: 'Precision-based ninjutsu and tactical combat',
    sources: ['https://naruto-official.com/en']
  },
  {
    id: 'dragonball-goku',
    name: 'Goku',
    universe: 'Dragon Ball',
    version: 'Dragon Ball Super continuity',
    rating: 98,
    abilities: ['Ki control', 'Ultra Instinct forms'],
    strengths: ['Combat adaptation', 'Speed', 'Power'],
    weaknesses: ['Energy and form constraints'],
    description: 'Goku is a Saiyan martial artist who constantly develops his abilities through training and competition.',
    combatStyle: 'Martial arts and ki-based combat',
    sources: ['https://dragon-ball-official.com/']
  },
  {
    id: 'dragonball-vegeta',
    name: 'Vegeta',
    universe: 'Dragon Ball',
    version: 'Dragon Ball Super continuity',
    rating: 97,
    abilities: ['Ki control', 'Saiyan transformations'],
    strengths: ['Combat skill', 'Power', 'Determination'],
    weaknesses: ['Energy and form constraints'],
    description: 'Vegeta is a powerful Saiyan warrior whose disciplined training, technical combat skill and determination drive his development.',
    combatStyle: 'Aggressive martial arts and ki-based combat',
    sources: ['https://dragon-ball-official.com/']
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
    description: 'Arjuna is one of the central warriors of the Mahabharata, renowned for exceptional archery, discipline and knowledge of warfare.',
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

// Fetch character thumbnails from Wikipedia.
// If a page has no usable thumbnail, the character's fallback artwork is used.
async function addCharacterImages(characters) {
  return Promise.all(characters.map(async character => {
    const title = IMAGE_TITLES[character.id];

    if (!title) return character;

    try {
      const url =
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;

      const response = await fetch(url, {
        headers: { 'User-Agent': 'BattleAuction/2.0' },
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) return character;

      const data = await response.json();
      const imageUrl =
        data.thumbnail?.source || data.originalimage?.source || null;

      return { ...character, imageUrl };
    } catch (error) {
      console.warn(`Image lookup failed for ${character.name}:`, error.message);
      return character;
    }
  }));
}

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(
    { length: 6 },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    settings: room.settings,
    players: room.players.map(player => ({
      id: player.id,
      name: player.name,
      budget: player.budget,
      team: player.team,
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
    auctionLog: room.auctionLog,
    results: room.results,
    championship: room.championship,
    reserveCount: room.reserveCharacters.length,
    completionError: room.completionError
  };
}

function emitRoom(room) {
  io.to(room.code).emit('room:update', publicRoom(room));
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

    if (canBid(player, room)) break;

    room.noIncreaseTurns++;
    room.currentTurnIndex = (room.currentTurnIndex + 1) % players.length;
    tries++;

    if (room.noIncreaseTurns >= players.length) {
      return resolveAuction(room);
    }
  }

  if (tries >= players.length) {
    return resolveAuction(room);
  }

  room.turnDeadline = Date.now() + room.settings.turnSeconds * 1000;
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

  room.currentTurnIndex = (room.currentTurnIndex + 1) % players.length;
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
  const winner = room.players.find(player => player.id === winnerId);

  if (winner && winner.budget >= room.currentBid) {
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

  const reserve = shuffle(room.reserveCharacters);

  if (reserve.length < emptySlots.length) {
    room.status = 'incomplete';
    room.turnDeadline = null;
    room.currentCharacter = null;
    room.completionError =
      'There are not enough unused characters to complete every team.';
    emitRoom(room);
    return;
  }

  emptySlots.forEach((player, index) => {
    player.team.push({
      ...clone(reserve[index]),
      paid: 0,
      allocatedFree: true
    });
  });

  room.reserveCharacters = reserve.slice(emptySlots.length);
  room.currentCharacter = null;
  room.turnDeadline = null;
  room.status = 'ready_for_fight';

  emitRoom(room);
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

    const wins = played.filter(match => match.winnerId === player.id).length;
    const draws = played.filter(match => match.result === 'DRAW').length;
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
    socket.emit('error:message', 'Only the host can perform this action.');
    return false;
  }

  return true;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'BATTLE AUCTION',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
  });
});

app.get('/api/universes', (_req, res) => {
  res.json([...new Set(SEED_CHARACTERS.map(character => character.universe))]);
});

app.post('/api/research', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: 'Gemini is not configured. Add GEMINI_API_KEY to your server environment.'
    });
  }

  const universe = String(req.body?.universe || '').trim();

  if (!universe) {
    return res.status(400).json({ error: 'Universe name is required.' });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const model = genAI.getGenerativeModel({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash'
    });

    const prompt =
      `Research established fictional characters from "${universe}". ` +
      'Return JSON only with a characters array. Each character should include ' +
      'name, version, abilities, strengths, weaknesses, rating and reliable source URLs. ' +
      'Include only established characters. Return at most 20 characters. ' +
      'This output requires human review before being used in the game.';

    const result = await model.generateContent(prompt);

    res.json({
      note: 'AI research requires source verification and host approval before use.',
      output: result.response.text()
    });
  } catch (error) {
    res.status(502).json({
      error: 'Gemini research request failed.',
      detail: error.message
    });
  }
});

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

    socket.emit('room:created', publicRoom(room));
    emitRoom(room);
  });

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

    socket.emit('room:joined', publicRoom(room));
    emitRoom(room);
  });

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

    if (
      !Number.isInteger(parsedTeamSize) ||
      parsedTeamSize < 1 ||
      parsedTeamSize > 20
    ) {
      return socket.emit('error:message', 'Team size must be between 1 and 20.');
    }

    if (
      !Number.isInteger(parsedTurnSeconds) ||
      parsedTurnSeconds < 5 ||
      parsedTurnSeconds > 120
    ) {
      return socket.emit('error:message', 'Turn duration must be between 5 and 120 seconds.');
    }

    if (
      !Number.isInteger(parsedStartingBid) ||
      parsedStartingBid < 1 ||
      parsedStartingBid >= room.settings.startingBudget
    ) {
      return socket.emit('error:message', 'Starting bid must be a positive whole number below the starting budget.');
    }

    const selectedUniverses =
      Array.isArray(universes) && universes.length
        ? [...new Set(universes.filter(value =>
            SEED_CHARACTERS.some(character => character.universe === value)
          ))]
        : room.settings.universes;

    if (!selectedUniverses.length) {
      return socket.emit('error:message', 'Choose at least one available universe.');
    }

    const requiredCharacters = room.players.length * parsedTeamSize;

    const pool = SEED_CHARACTERS.filter(character =>
      selectedUniverses.includes(character.universe)
    );

    if (pool.length < requiredCharacters) {
      return socket.emit(
        'error:message',
        `Not enough approved characters. You need ${requiredCharacters}, but only ${pool.length} are available in the selected universes. Choose more universes or a smaller team size.`
      );
    }

    room.settings.teamSize = parsedTeamSize;
    room.settings.turnSeconds = parsedTurnSeconds;
    room.settings.startingBid = parsedStartingBid;
    room.settings.universes = selectedUniverses;
    room.settings.characterCount = requiredCharacters;

    const selectedCharacters = shuffle(pool).slice(0, requiredCharacters);

    // Image lookups are optional; the auction still starts if they fail.
    room.characters = await addCharacterImages(selectedCharacters);

    // The host may have left or the room may have changed during image lookup.
    if (room.status !== 'lobby' || !rooms.has(room.code)) return;

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
    room.turnDeadline = null;
    room.noIncreaseTurns = 0;
    room.auctionLog = [];
    room.results = [];
    room.reserveCharacters = [];
    room.championship = null;
    room.completionError = null;
    room.status = 'auction_ready';

    emitRoom(room);
  });

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
    room.currentTurnIndex = 0;
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
      return socket.emit('error:message', 'It is not your turn or your turn has expired.');
    }

    const player = room.players.find(p => p.id === socket.id);
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
      return socket.emit('error:message', 'It is not your turn or your turn has expired.');
    }

    passTurn(room, 'SKIP');
  });

  socket.on('championship:start', () => {
    const room = [...rooms.values()].find(r => r.hostId === socket.id);

    if (!isHost(room, socket)) return;

    if (room.status !== 'ready_for_fight') {
      return socket.emit('error:message', 'The teams are not ready for the championship.');
    }

    const incompletePlayer = room.players.find(player =>
      player.team.length !== room.settings.teamSize
    );

    if (incompletePlayer) {
      return socket.emit('error:message', `${incompletePlayer.name}'s team is not complete yet.`);
    }

    startChampionship(room);
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const player = room.players.find(p => p.id === socket.id);
      if (!player) continue;

      // Remember whose turn it was before removing this player from active players.
      const previousCurrentId =
        room.status === 'auction' ? getCurrentPlayer(room)?.id : null;

      player.connected = false;

      if (room.status === 'auction') {
        const remainingPlayers = activePlayers(room);

        if (previousCurrentId === socket.id) {
          stopTimer(room.code);
          room.noIncreaseTurns++;

          // The next player now occupies the disconnected player's old index.
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
          // Preserve the current player's identity if someone else disconnects.
          const newIndex = remainingPlayers.findIndex(
            activePlayer => activePlayer.id === previousCurrentId
          );

          if (newIndex >= 0) room.currentTurnIndex = newIndex;
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
  if (req.path.startsWith('/api/')) return next();

  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`BATTLE AUCTION server listening on ${PORT}`);
});
