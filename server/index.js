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

const SEED_CHARACTERS = [
  { id:'marvel-spider-man', name:'Spider-Man', universe:'Marvel', version:'Earth-616', rating:88, abilities:['Spider-sense','Agility','Web-slinging'], strengths:['Mobility','Reflexes','Improvisation'], weaknesses:['Human-level durability'], sources:['https://www.marvel.com/characters/spider-man-peter-parker'] },
  { id:'marvel-iron-man', name:'Iron Man', universe:'Marvel', version:'Earth-616', rating:91, abilities:['Powered armour','Repulsors','Flight'], strengths:['Technology','Range','Adaptability'], weaknesses:['Armour dependence'], sources:['https://www.marvel.com/characters/iron-man-tony-stark'] },
  { id:'marvel-thor', name:'Thor', universe:'Marvel', version:'Earth-616', rating:96, abilities:['Asgardian physiology','Mjolnir','Lightning'], strengths:['Durability','Strength','Energy projection'], weaknesses:['Version-dependent limits'], sources:['https://www.marvel.com/characters/thor-thor-odinson'] },
  { id:'dc-batman', name:'Batman', universe:'DC', version:'Main continuity', rating:87, abilities:['Detective skills','Martial arts','Technology'], strengths:['Preparation','Strategy','Stealth'], weaknesses:['Human physiology'], sources:['https://www.dc.com/characters/batman'] },
  { id:'dc-superman', name:'Superman', universe:'DC', version:'Main continuity', rating:98, abilities:['Flight','Super strength','Heat vision'], strengths:['Speed','Durability','Power'], weaknesses:['Continuity-dependent vulnerabilities'], sources:['https://www.dc.com/characters/superman'] },
  { id:'dc-wonder-woman', name:'Wonder Woman', universe:'DC', version:'Main continuity', rating:94, abilities:['Amazonian abilities','Combat skill','Lasso'], strengths:['Combat','Durability','Leadership'], weaknesses:['Continuity-dependent limits'], sources:['https://www.dc.com/characters/wonder-woman'] },
  { id:'naruto-naruto', name:'Naruto Uzumaki', universe:'Naruto', version:'End-of-series', rating:95, abilities:['Shadow clones','Sage powers','Kurama chakra'], strengths:['Chakra reserves','Versatility','Resilience'], weaknesses:['Specific power-state limits'], sources:['https://naruto-official.com/en'] },
  { id:'naruto-sasuke', name:'Sasuke Uchiha', universe:'Naruto', version:'End-of-series', rating:94, abilities:['Sharingan','Rinnegan-era techniques','Lightning release'], strengths:['Perception','Ninjutsu','Tactics'], weaknesses:['Chakra constraints'], sources:['https://naruto-official.com/en'] },
  { id:'dragonball-goku', name:'Goku', universe:'Dragon Ball', version:'Dragon Ball Super continuity', rating:98, abilities:['Ki control','Ultra Instinct forms'], strengths:['Combat adaptation','Speed','Power'], weaknesses:['Energy and form constraints'], sources:['https://dragon-ball-official.com/'] },
  { id:'dragonball-vegeta', name:'Vegeta', universe:'Dragon Ball', version:'Dragon Ball Super continuity', rating:97, abilities:['Ki control','Saiyan transformations'], strengths:['Combat skill','Power','Determination'], weaknesses:['Energy and form constraints'], sources:['https://dragon-ball-official.com/'] },
  { id:'ramayana-hanuman', name:'Hanuman', universe:'Ramayana', version:'Traditional epic', rating:98, abilities:['Immense strength','Flight','Form-changing'], strengths:['Devotion','Strength','Resilience'], weaknesses:['Tradition-specific interpretations'], sources:['https://www.valmiki.iitk.ac.in/'] },
  { id:'mahabharata-arjuna', name:'Arjuna', universe:'Mahabharata', version:'Traditional epic', rating:91, abilities:['Archery','Divine astras','Warfare'], strengths:['Precision','Discipline','Combat skill'], weaknesses:['Weapon and context constraints'], sources:['https://www.sacred-texts.com/hin/'] }
];

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function publicRoom(room) {
  return {
    code: room.code, hostId: room.hostId, status: room.status, settings: room.settings,
    players: room.players.map(p => ({ id:p.id, name:p.name, budget:p.budget, team:p.team, connected:p.connected })),
    characters: room.characters, characterIndex: room.characterIndex, currentCharacter: room.characters[room.characterIndex] || null,
    currentBid: room.currentBid, highestBidderId: room.highestBidderId, currentTurnIndex: room.currentTurnIndex,
    turnDeadline: room.turnDeadline, noIncreaseTurns: room.noIncreaseTurns, lastBidderId: room.lastBidderId,
    auctionLog: room.auctionLog, results: room.results
  };
}
function emitRoom(room) { io.to(room.code).emit('room:update', publicRoom(room)); }
function stopTimer(code) { const t = turnTimers.get(code); if (t) clearTimeout(t); turnTimers.delete(code); }
function activePlayers(room) { return room.players.filter(p => p.connected); }
function beginTurn(room) {
  stopTimer(room.code);
  if (room.status !== 'auction') return;
  const players = activePlayers(room);
  if (!players.length) return;
  if (room.noIncreaseTurns >= players.length && room.lastBidderId) return resolveAuction(room);
  let tries = 0;
  while (tries < players.length) {
    const p = players[room.currentTurnIndex % players.length];
    if (p && p.team.length < room.settings.teamSize && p.budget >= 1) break;
    room.currentTurnIndex = (room.currentTurnIndex + 1) % players.length;
    room.noIncreaseTurns++;
    tries++;
  }
  if (tries >= players.length) return resolveAuction(room);
  room.turnDeadline = Date.now() + room.settings.turnSeconds * 1000;
  emitRoom(room);
  const delay = Math.max(0, room.turnDeadline - Date.now());
  turnTimers.set(room.code, setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r || r.status !== 'auction' || Date.now() < r.turnDeadline) return;
    passTurn(r, 'TIMEOUT');
  }, delay + 20));
}
function nextTurn(room) {
  const players = activePlayers(room);
  if (!players.length) return;
  room.currentTurnIndex = (room.currentTurnIndex + 1) % players.length;
  beginTurn(room);
}
function passTurn(room, reason='SKIP') {
  if (room.status !== 'auction') return;
  stopTimer(room.code);
  room.noIncreaseTurns++;
  room.auctionLog.push({ type:reason, playerId:activePlayers(room)[room.currentTurnIndex]?.id, at:Date.now() });
  if (room.noIncreaseTurns >= activePlayers(room).length && room.lastBidderId) return resolveAuction(room);
  nextTurn(room);
}
function resolveAuction(room) {
  stopTimer(room.code);
  const char = room.characters[room.characterIndex];
  if (!char) return finishAuction(room);
  if (room.lastBidderId) {
    const winner = room.players.find(p => p.id === room.lastBidderId);
    if (winner) {
      winner.budget -= room.currentBid;
      winner.team.push({ ...char, paid:room.currentBid });
    }
    room.results.push({ characterId:char.id, characterName:char.name, winnerId:room.lastBidderId, amount:room.currentBid });
  } else {
    room.results.push({ characterId:char.id, characterName:char.name, winnerId:null, amount:0 });
  }
  room.characterIndex++;
  room.currentBid = room.settings.startingBid;
  room.highestBidderId = null;
  room.lastBidderId = null;
  room.noIncreaseTurns = 0;
  if (room.characterIndex >= room.characters.length) return finishAuction(room);
  room.currentTurnIndex = 0;
  beginTurn(room);
}
function finishAuction(room) {
  stopTimer(room.code);
  room.status = 'championship';
  room.turnDeadline = null;
  emitRoom(room);
}
function shuffle(list) {
  const a = [...list];
  for (let i=a.length-1;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function roomCode() {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:6},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
}

app.get('/api/health', (_req,res) => res.json({ ok:true, service:'BATTLE AUCTION', geminiConfigured:Boolean(process.env.GEMINI_API_KEY) }));
app.get('/api/universes', (_req,res) => res.json([...new Set(SEED_CHARACTERS.map(c=>c.universe))]));
app.post('/api/research', async (req,res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error:'Gemini is not configured. Add GEMINI_API_KEY to your server .env file.' });
  const universe = String(req.body?.universe || '').trim();
  if (!universe) return res.status(400).json({ error:'Universe name is required.' });
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model:process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
    const prompt = `Research established fictional characters from the universe "${universe}". Return JSON only: {"characters":[{"name":"","version":"","abilities":[],"strengths":[],"weaknesses":[],"rating":0,"sources":[]}]} Include only real, established characters and reliable source URLs. Do not invent characters or facts. If uncertain, omit the character or mark uncertain. Return at most 20 characters. This output must be reviewed by a host before use.`;
    const result = await model.generateContent(prompt);
    res.json({ note:'AI-generated research requires source verification and host approval before being saved.', output:result.response.text() });
  } catch (e) {
    res.status(502).json({ error:'Gemini research request failed.', detail:e.message });
  }
});

io.on('connection', socket => {
  socket.on('room:create', ({ name, settings={} }={}) => {
    const code = roomCode();
    const player = { id:socket.id, name:String(name||'Host').slice(0,24), budget:100, team:[], connected:true };
    const room = {
      code, hostId:socket.id, status:'lobby',
      settings:{ startingBudget:100, teamSize:5, turnSeconds:10, startingBid:1, characterCount:8, universes:['Marvel','DC'], ...settings },
      players:[player], characters:[], characterIndex:0, currentBid:Number(settings.startingBid||1),
      highestBidderId:null, lastBidderId:null, currentTurnIndex:0, turnDeadline:null, noIncreaseTurns:0,
      auctionLog:[], results:[]
    };
    rooms.set(code,room); socket.join(code); socket.emit('room:created', publicRoom(room)); emitRoom(room);
  });
  socket.on('room:join', ({ code, name }={}) => {
    const room=rooms.get(String(code||'').toUpperCase());
    if (!room || room.status!=='lobby') return socket.emit('error:message','Room not found or game already started.');
    if (room.players.length>=10) return socket.emit('error:message','Room is full.');
    const player={ id:socket.id, name:String(name||'Player').slice(0,24), budget:room.settings.startingBudget, team:[], connected:true };
    room.players.push(player); socket.join(room.code); socket.emit('room:joined',publicRoom(room)); emitRoom(room);
  });
  socket.on('room:start', ({ universes, characterCount, teamSize, turnSeconds, startingBid }={}) => {
    const room=[...rooms.values()].find(r=>r.hostId===socket.id);
    if (!room || room.status!=='lobby') return;
    if (room.players.length<2) return socket.emit('error:message','At least two players are required.');
    room.settings.teamSize=Math.max(1,Math.min(20,Number(teamSize||room.settings.teamSize)));
    room.settings.turnSeconds=Math.max(5,Math.min(60,Number(turnSeconds||room.settings.turnSeconds)));
    room.settings.startingBid=Math.max(1,Number(startingBid||room.settings.startingBid));
    room.settings.universes=Array.isArray(universes)&&universes.length?universes:room.settings.universes;
    const pool=SEED_CHARACTERS.filter(c=>room.settings.universes.includes(c.universe));
    if (!pool.length) return socket.emit('error:message','No approved seed characters found for those universes yet. Add approved character records to the database.');
    room.characters=shuffle(pool).slice(0,Math.min(Number(characterCount||room.settings.characterCount),pool.length));
    room.players.forEach(p=>p.budget=room.settings.startingBudget);
    room.status='auction'; room.characterIndex=0; room.currentTurnIndex=0;
    room.currentBid=room.settings.startingBid; room.noIncreaseTurns=0; room.results=[];
    beginTurn(room);
  });
  socket.on('bid:increase', ({ amount }={}) => {
    const room=[...rooms.values()].find(r=>r.players.some(p=>p.id===socket.id));
    if (!room || room.status!=='auction') return;
    const players=activePlayers(room), current=players[room.currentTurnIndex];
    if (!current || current.id!==socket.id || Date.now()>room.turnDeadline) return socket.emit('error:message','It is not your turn or your turn has expired.');
    const p=room.players.find(x=>x.id===socket.id);
    const inc=Number(amount);
    if (!Number.isInteger(inc)||inc<1) return socket.emit('error:message','Enter a whole-number increase of at least ₹1.');
    if (p.team.length>=room.settings.teamSize) return socket.emit('error:message','Your team is full.');
    const newBid=room.currentBid+inc;
    if (newBid>p.budget) return socket.emit('error:message','That bid exceeds your remaining budget.');
    stopTimer(room.code);
    room.currentBid=newBid; room.highestBidderId=p.id; room.lastBidderId=p.id; room.noIncreaseTurns=0;
    room.auctionLog.push({type:'BID',playerId:p.id,amount:newBid,increment:inc,at:Date.now()});
    nextTurn(room);
  });
  socket.on('bid:skip', () => {
    const room=[...rooms.values()].find(r=>r.players.some(p=>p.id===socket.id));
    if (!room || room.status!=='auction') return;
    const players=activePlayers(room), current=players[room.currentTurnIndex];
    if (!current || current.id!==socket.id || Date.now()>room.turnDeadline) return socket.emit('error:message','It is not your turn or your turn has expired.');
    passTurn(room,'SKIP');
  });
  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const p=room.players.find(x=>x.id===socket.id);
      if (p) { p.connected=false; emitRoom(room); }
    }
  });
});

app.use(express.static(path.join(__dirname,'..','dist')));
app.get('*', (req,res,next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname,'..','dist','index.html'));
});
server.listen(PORT,()=>console.log(`BATTLE AUCTION server listening on ${PORT}`));
