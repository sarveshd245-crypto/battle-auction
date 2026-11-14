import { io } from 'socket.io-client';
import './style.css';

const socket = io();
let room = null;
let playerName = localStorage.getItem('ba_name') || '';
let roomCode = '';
let selectedUniverses = ['Marvel','DC'];
let errorMessage = '';
let toastTimer;
const root = document.querySelector('#root');

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const me = () => room?.players?.find(p=>p.id===socket.id);
const currentPlayer = () => room?.players?.filter(p=>p.connected)?.[room.currentTurnIndex];
const money = n => `₹${Number(n||0)}`;

function toast(msg) {
  errorMessage=msg; render();
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>{errorMessage='';render()},3500);
}
socket.on('room:created', r=>{room=r;render()});
socket.on('room:joined', r=>{room=r;render()});
socket.on('room:update', r=>{room=r;render()});
socket.on('error:message', toast);
socket.on('connect',()=>render());

function shell(content) {
  root.innerHTML = `<div class="app-shell">
    <header class="topbar"><div class="brand-mark">BA</div><div><div class="brand">BATTLE <span>AUCTION</span></div><div class="tagline">BUILD YOUR LEGENDARY SQUAD</div></div><div class="top-right">${room?`ROOM <b>${room.code}</b>`:'MULTIPLAYER ARENA'}</div></header>
    ${errorMessage?`<div class="toast">${escapeHtml(errorMessage)}</div>`:''}
    ${content}
    <footer>VIRTUAL GAME CURRENCY ONLY · BATTLE AUCTION 2.0</footer>
  </div>`;
}
function renderHome() {
  shell(`<main class="hero">
    <div class="eyebrow">THE ULTIMATE CHARACTER AUCTION</div>
    <h1>BUILD YOUR TEAM.<br><span>CLAIM THE CROWN.</span></h1>
    <p class="intro">Draft iconic characters, outbid your rivals and prove your team's strength in a tactical championship.</p>
    <div class="home-grid">
      <section class="panel"><h2>CREATE A ROOM</h2><label>Your player name</label><input id="createName" maxlength="24" placeholder="Enter your name" value="${escapeHtml(playerName)}"><button class="primary" id="createBtn">CREATE PRIVATE ROOM</button></section>
      <section class="panel"><h2>JOIN A ROOM</h2><label>Your player name</label><input id="joinName" maxlength="24" placeholder="Enter your name" value="${escapeHtml(playerName)}"><label>Room code</label><input id="roomCode" maxlength="6" placeholder="6-character code"><button class="secondary" id="joinBtn">JOIN ROOM</button></section>
    </div>
    <div class="feature-row"><span>✦ 2–10 PLAYERS</span><span>✦ CUSTOM UNIVERSES</span><span>✦ GEMINI MATCH ANALYSIS</span></div>
  </main>`);
  document.querySelector('#createBtn').onclick=()=>{const n=document.querySelector('#createName').value.trim();if(!n)return toast('Enter your player name.');playerName=n;localStorage.setItem('ba_name',n);socket.emit('room:create',{name:n})};
  document.querySelector('#joinBtn').onclick=()=>{const n=document.querySelector('#joinName').value.trim();const c=document.querySelector('#roomCode').value.trim().toUpperCase();if(!n||!c)return toast('Enter your name and room code.');playerName=n;localStorage.setItem('ba_name',n);socket.emit('room:join',{name:n,code:c})};
}
function renderLobby() {
  const isHost=room.hostId===socket.id;
  shell(`<main class="content">
    <div class="section-head"><div><div class="eyebrow">PRIVATE GAME ROOM</div><h1>THE LOBBY</h1></div><div class="room-chip">ROOM CODE <b>${room.code}</b></div></div>
    <div class="lobby-grid"><section class="panel"><h2>PLAYERS <small>${room.players.length}/10</small></h2><div class="player-list">${room.players.map((p,i)=>`<div class="player-row"><div class="avatar">${escapeHtml(p.name.slice(0,1).toUpperCase())}</div><div><b>${escapeHtml(p.name)}</b><small>${p.id===room.hostId?'HOST':'PLAYER'} · ${p.connected?'CONNECTED':'DISCONNECTED'}</small></div>${p.id===room.hostId?'<span class="crown">♛</span>':''}</div>`).join('')}</div></section>
    <section class="panel"><h2>GAME CONFIGURATION</h2>${isHost?`
      <label>Universes (choose one or more)</label>
      <div class="universe-picks">${['Marvel','DC','Naruto','Dragon Ball','Ramayana','Mahabharata'].map(u=>`<label class="check"><input type="checkbox" value="${u}" ${selectedUniverses.includes(u)?'checked':''}> ${u}</label>`).join('')}</div>
      <label>Characters in this auction</label><input id="count" type="number" min="1" max="100" value="6">
      <div class="two-inputs"><div><label>Team size</label><input id="teamSize" type="number" min="1" max="20" value="3"></div><div><label>Turn seconds</label><input id="turnSeconds" type="number" min="5" max="60" value="10"></div></div>
      <label>Starting bid (₹)</label><input id="startingBid" type="number" min="1" value="1">
      <button class="primary" id="startBtn" ${room.players.length<2?'disabled':''}>START AUCTION</button>
      <p class="muted">The game randomly shuffles the available approved characters every time a new game starts. All players see the same order.</p>`:`<div class="waiting"><div class="pulse"></div><h3>WAITING FOR HOST</h3><p>The host is configuring the auction. The game will begin automatically when they start it.</p></div>`}</section></div>
  </main>`);
  document.querySelectorAll('.universe-picks input').forEach(el=>el.onchange=()=>{selectedUniverses=[...document.querySelectorAll('.universe-picks input:checked')].map(x=>x.value)});
  const start=document.querySelector('#startBtn');
  if(start) start.onclick=()=>socket.emit('room:start',{universes:selectedUniverses,characterCount:Number(document.querySelector('#count').value),teamSize:Number(document.querySelector('#teamSize').value),turnSeconds:Number(document.querySelector('#turnSeconds').value),startingBid:Number(document.querySelector('#startingBid').value)});
}
function renderAuction() {
  const p=me(), active=room.players.filter(x=>x.connected), turn=active[room.currentTurnIndex], myTurn=turn?.id===socket.id;
  const char=room.currentCharacter;
  const remaining=Math.max(0,Math.ceil((room.turnDeadline-Date.now())/1000));
  const leader=room.players.find(x=>x.id===room.highestBidderId);
  shell(`<main class="content">
    <div class="section-head"><div><div class="eyebrow">LIVE AUCTION · CHARACTER ${room.characterIndex+1} OF ${room.characters.length}</div><h1>THE BIDDING ARENA</h1></div><div class="room-chip">ROOM <b>${room.code}</b></div></div>
    <div class="auction-layout">
      <section class="character-card"><div class="character-glow"></div><div class="character-art">${char.universe==='Marvel'?'✦':char.universe==='DC'?'⚡':char.universe==='Naruto'?'忍':char.universe==='Dragon Ball'?'✧':'◆'}</div><div class="universe-label">${escapeHtml(char.universe)} · ${escapeHtml(char.version)}</div><h2>${escapeHtml(char.name)}</h2><div class="rating">POWER RATING <b>${char.rating}/100</b></div><div class="ability-tags">${char.abilities.map(a=>`<span>${escapeHtml(a)}</span>`).join('')}</div></section>
      <section class="panel bid-panel"><div class="eyebrow">CURRENT HIGHEST BID</div><div class="bid-value">${money(room.currentBid)}</div><div class="bidder">${leader?`LEADING: ${escapeHtml(leader.name)}`:'NO BIDS YET'}</div>
        <div class="turn-box"><div><small>CURRENT TURN</small><b>${escapeHtml(turn?.name||'—')}</b></div><div class="timer ${remaining<=3?'urgent':''}">${remaining}s</div></div>
        ${myTurn?`<div class="bid-controls"><label>INCREASE BY (₹)</label><input id="bidAmount" type="number" min="1" step="1" value="1"><div class="quick-bids"><button data-bid="1">+₹1</button><button data-bid="2">+₹2</button><button data-bid="5">+₹5</button><button data-bid="10">+₹10</button></div><button class="primary" id="bidBtn">INCREASE BID</button><button class="skip" id="skipBtn">SKIP THIS TURN</button></div>`:`<div class="waiting compact"><div class="pulse"></div><b>${myTurn?'YOUR TURN':'WAITING FOR '+escapeHtml(turn?.name||'PLAYER')}</b><p>${myTurn?'Choose to increase the bid or skip.':'Your turn will come around again. Skipping does not eliminate you.'}</p></div>`}
      </section>
    </div>
    <div class="stats-grid">${room.players.map(pl=>`<div class="stat-card ${pl.id===turn?.id?'active-player':''}"><b>${escapeHtml(pl.name)}</b><strong>${money(pl.budget)}</strong><small>${pl.team.length}/${room.settings.teamSize} CHARACTERS</small></div>`).join('')}</div>
    <section class="panel roster"><h2>YOUR TEAM <small>${p?.team.length||0} CHARACTERS</small></h2><div class="mini-roster">${(p?.team||[]).map(c=>`<span>${escapeHtml(c.name)} <b>${money(c.paid)}</b></span>`).join('')||'<span class="muted">No characters purchased yet.</span>'}</div></section>
  </main>`);
  document.querySelectorAll('[data-bid]').forEach(b=>b.onclick=()=>document.querySelector('#bidAmount').value=b.dataset.bid);
  const bid=document.querySelector('#bidBtn'); if(bid)bid.onclick=()=>socket.emit('bid:increase',{amount:Number(document.querySelector('#bidAmount').value)});
  const skip=document.querySelector('#skipBtn');if(skip)skip.onclick=()=>socket.emit('bid:skip');
  setTimeout(()=>{if(room?.status==='auction')render()},1000);
}
function renderChampionship() {
  const teams=room.players.map(p=>({name:p.name,team:p.team,budget:p.budget,wins:0,losses:0,ties:0}));
  shell(`<main class="content"><div class="eyebrow">AUCTION COMPLETE</div><h1>YOUR TEAMS ARE LOCKED</h1><p class="intro">The auction has ended. Review the team rosters below. Gemini-powered matchup and championship reporting can be enabled by configuring the server API key and completing the championship module.</p>
  <div class="team-grid">${teams.map(t=>`<section class="panel"><h2>${escapeHtml(t.name)}</h2><div class="team-characters">${t.team.map(c=>`<div class="team-character"><b>${escapeHtml(c.name)}</b><span>${c.rating}/100 · paid ${money(c.paid)}</span></div>`).join('')||'<p class="muted">No characters won.</p>'}</div><div class="team-total">REMAINING BUDGET <b>${money(t.budget)}</b></div></section>`).join('')}</div>
  <div class="notice"><b>Development note:</b> This starter build completes the room and auction flow. Round-robin match execution, persistent database storage, Gemini-grounded source research and AI battle reports are integration milestones, not yet implemented in this ZIP.</div>
  <button class="secondary" id="homeBtn">RETURN TO HOME</button></main>`);
  document.querySelector('#homeBtn').onclick=()=>{room=null;render()};
}
function render() {
  if(!room) return renderHome();
  if(room.status==='lobby') return renderLobby();
  if(room.status==='auction') return renderAuction();
  return renderChampionship();
}
render();
