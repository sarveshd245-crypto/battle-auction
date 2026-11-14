
import { io } from 'socket.io-client';
import './style.css';

const socket = io();

let room = null;
let playerName = localStorage.getItem('ba_name') || '';
let selectedUniverses = ['Marvel', 'DC'];
let selectedBidIncrement = 1;
let errorMessage = '';
let toastTimer;
let timerInterval;
let latestStateVersion = -1;

const root = document.querySelector('#root');

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

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

const me = () => room?.players?.find(player => player.id === socket.id);
const activePlayers = () => room?.players?.filter(player => player.connected) || [];

// Prefer the stable player ID supplied by the server.
// Keep the index fallback for compatibility with the older backend.
const currentPlayer = () => {
  if (room?.currentTurnPlayerId) {
    return room.players?.find(
      player => player.id === room.currentTurnPlayerId
    ) || null;
  }

  return activePlayers()[room?.currentTurnIndex] || null;
};

const money = value => `₹${Number(value || 0)}`;
const list = value => Array.isArray(value) ? value : [];
const isHost = () => room?.hostId === socket.id;

function acceptRoomUpdate(data) {
  if (!data) return;

  const incomingVersion = Number(data.stateVersion);

  // Ignore older updates from the same room.
  if (
    room &&
    data.code === room.code &&
    Number.isFinite(incomingVersion) &&
    incomingVersion > 0 &&
    latestStateVersion >= 0 &&
    incomingVersion < latestStateVersion
  ) {
    return;
  }

  if (
    Number.isFinite(incomingVersion) &&
    incomingVersion > 0
  ) {
    latestStateVersion = incomingVersion;
  }

  room = data;
  render();
}

function toast(message) {
  errorMessage = message;
  render();

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    errorMessage = '';
    render();
  }, 3500);
}

socket.on('room:created', data => {
  latestStateVersion = -1;
  room = data;
  if (Number(data?.stateVersion) > 0) {
    latestStateVersion = Number(data.stateVersion);
  }
  errorMessage = '';
  render();
});

socket.on('room:joined', data => {
  latestStateVersion = -1;
  room = data;
  if (Number(data?.stateVersion) > 0) {
    latestStateVersion = Number(data.stateVersion);
  }
  errorMessage = '';
  render();
});

socket.on('room:update', acceptRoomUpdate);

socket.on('error:message', toast);
socket.on('connect', render);

function shell(content) {
  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand-mark">BA</div>
        <div>
          <div class="brand">BATTLE <span>AUCTION</span></div>
          <div class="tagline">BUILD YOUR LEGENDARY SQUAD</div>
        </div>
        <div class="top-right">
          ${room ? `ROOM <b>${escapeHtml(room.code)}</b>` : 'MULTIPLAYER ARENA'}
        </div>
      </header>

      ${errorMessage ? `<div class="toast">${escapeHtml(errorMessage)}</div>` : ''}

      ${content}

      <footer>VIRTUAL GAME CURRENCY ONLY · BATTLE AUCTION 2.0</footer>
    </div>
  `;
}

function renderHome() {
  shell(`
    <main class="hero">
      <div class="eyebrow">THE ULTIMATE CHARACTER AUCTION</div>
      <h1>BUILD YOUR TEAM.<br><span>CLAIM THE CROWN.</span></h1>

      <p class="intro">
        Draft iconic characters, outbid your rivals and prove your team's strength
        in a tactical championship.
      </p>

      <div class="home-grid">
        <section class="panel">
          <h2>CREATE A ROOM</h2>
          <label>Your player name</label>
          <input id="createName" maxlength="24"
            placeholder="Enter your name"
            value="${escapeHtml(playerName)}">
          <button class="primary" id="createBtn">CREATE PRIVATE ROOM</button>
        </section>

        <section class="panel">
          <h2>JOIN A ROOM</h2>
          <label>Your player name</label>
          <input id="joinName" maxlength="24"
            placeholder="Enter your name"
            value="${escapeHtml(playerName)}">

          <label>Room code</label>
          <input id="roomCode" maxlength="6" placeholder="6-character code">
          <button class="secondary" id="joinBtn">JOIN ROOM</button>
        </section>
      </div>

      <div class="feature-row">
        <span>✦ 2–10 PLAYERS</span>
        <span>✦ CUSTOM UNIVERSES</span>
        <span>✦ ROUND-ROBIN CHAMPIONSHIP</span>
      </div>
    </main>
  `);

  document.querySelector('#createBtn').onclick = () => {
    const name = document.querySelector('#createName').value.trim();
    if (!name) return toast('Enter your player name.');

    playerName = name;
    localStorage.setItem('ba_name', name);
    socket.emit('room:create', { name });
  };

  document.querySelector('#joinBtn').onclick = () => {
    const name = document.querySelector('#joinName').value.trim();
    const code = document.querySelector('#roomCode').value.trim().toUpperCase();

    if (!name || !code) return toast('Enter your name and room code.');

    playerName = name;
    localStorage.setItem('ba_name', name);
    socket.emit('room:join', { name, code });
  };
}

function renderLobby() {
  const host = isHost();

  const playerRows = list(room.players).map(player => `
    <div class="player-row">
      <div class="avatar">${escapeHtml(player.name?.slice(0, 1).toUpperCase())}</div>
      <div>
        <b>${escapeHtml(player.name)}</b>
        <small>
          ${player.id === room.hostId ? 'HOST' : 'PLAYER'}
          · ${player.connected ? 'CONNECTED' : 'DISCONNECTED'}
        </small>
      </div>
      ${player.id === room.hostId ? '<span class="crown">♛</span>' : ''}
    </div>
  `).join('');

  shell(`
    <main class="content">
      <div class="section-head">
        <div>
          <div class="eyebrow">PRIVATE GAME ROOM</div>
          <h1>THE LOBBY</h1>
        </div>
        <div class="room-chip">
          ROOM CODE <b>${escapeHtml(room.code)}</b>
        </div>
      </div>

      <div class="lobby-grid">
        <section class="panel">
          <h2>PLAYERS <small>${room.players.length}/10</small></h2>
          <div class="player-list">${playerRows}</div>
        </section>

        <section class="panel">
          <h2>GAME CONFIGURATION</h2>

          ${host ? `
            <label>Genres (choose one or combine multiple)</label>

            <div class="universe-picks">
              ${GENRES.map(genre => `
                <label class="check">
                  <input type="checkbox"
                    value="${escapeHtml(genre)}"
                    ${selectedUniverses.includes(genre) ? 'checked' : ''}>
                  ${escapeHtml(genre)}
                </label>
              `).join('')}
            </div>

            <div class="two-inputs">
              <div>
                <label>Team size</label>
                <input id="teamSize" type="number" min="1" max="20"
                  value="${Number(room.settings?.teamSize || 3)}">
              </div>

              <div>
                <label>Turn seconds</label>
                <input id="turnSeconds" type="number" min="5" max="120"
                  value="${Number(room.settings?.turnSeconds || 10)}">
              </div>
            </div>

            <label>Starting bid (₹)</label>
            <input id="startingBid" type="number" min="1"
              value="${Number(room.settings?.startingBid || 1)}">

            <div class="notice">
              <b>Automatic character count</b>
              <p>Required characters = number of players × team size.</p>
              <p>Current requirement:
                <b id="requiredCount">${room.players.length * Number(room.settings?.teamSize || 3)} characters</b>
              </p>
              <p>Each player starts with ₹100.</p>
            </div>

            <button class="primary" id="startBtn"
              ${room.players.length < 2 ? 'disabled' : ''}>
              START AUCTION
            </button>

            <p class="muted">
              The server prepares the selected genre catalogues and checks
              that enough characters are available.
            </p>
          ` : `
            <div class="waiting">
              <div class="pulse"></div>
              <h3>WAITING FOR HOST</h3>
              <p>The host is configuring the auction.</p>
            </div>
          `}
        </section>
      </div>
    </main>
  `);

  document.querySelectorAll('.universe-picks input').forEach(input => {
    input.onchange = () => {
      selectedUniverses = [
        ...document.querySelectorAll('.universe-picks input:checked')
      ].map(element => element.value);
    };
  });

  const teamSizeInput = document.querySelector('#teamSize');

  if (teamSizeInput) {
    teamSizeInput.oninput = () => {
      const size = Math.max(1, Number(teamSizeInput.value || 1));
      document.querySelector('#requiredCount').textContent =
        `${room.players.length * size} characters`;
    };
  }

  const startButton = document.querySelector('#startBtn');

  if (startButton) {
    startButton.onclick = () => {
      const teamSize = Number(document.querySelector('#teamSize').value);
      const turnSeconds = Number(document.querySelector('#turnSeconds').value);
      const startingBid = Number(document.querySelector('#startingBid').value);

      if (!selectedUniverses.length) return toast('Select at least one genre.');

      if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 20) {
        return toast('Enter a valid team size.');
      }

      if (!Number.isInteger(turnSeconds) || turnSeconds < 5 || turnSeconds > 120) {
        return toast('Turn duration must be between 5 and 120 seconds.');
      }

      if (!Number.isInteger(startingBid) || startingBid < 1 || startingBid >= 100) {
        return toast('Starting bid must be between ₹1 and ₹99.');
      }

      startButton.disabled = true;
      startButton.textContent = 'PREPARING GAME...';

      socket.emit('room:start', {
        universes: selectedUniverses,
        teamSize,
        turnSeconds,
        startingBid
      });
    };
  }
}

function characterIcon(universe) {
  const icons = {
    Marvel: '✦',
    DC: '⚡',
    Football: '⚽',
    Cricket: '🏏',
    Anime: '✧',
    'Harry Potter': '✦',
    Ramayana: '◆',
    Mahabharata: '◆'
  };

  return icons[universe] || '★';
}

function renderCharacterDetails(character) {
  if (!character) {
    return '<p class="muted">Character information is not available.</p>';
  }

  const abilities = list(character.abilities);
  const strengths = list(character.strengths);
  const weaknesses = list(character.weaknesses);
  const sources = list(character.sources);

  return `
    <div class="character-card">
      <div class="character-glow"></div>

      ${character.imageUrl ? `
        <img class="character-image"
          src="${escapeHtml(character.imageUrl)}"
          alt="${escapeHtml(character.name)}"
          onerror="this.style.display='none'">
      ` : `
        <div class="character-art">${characterIcon(character.universe)}</div>
      `}

      <div class="universe-label">
        ${escapeHtml(character.universe)} · ${escapeHtml(character.version)}
      </div>

      <h2>${escapeHtml(character.name)}</h2>

      <div class="rating">
        POWER RATING <b>${Number(character.rating || 0)}/100</b>
      </div>

      ${character.description ? `
        <p class="character-description">${escapeHtml(character.description)}</p>
      ` : ''}

      ${character.combatStyle ? `
        <p class="character-description">
          <b>Combat style:</b> ${escapeHtml(character.combatStyle)}
        </p>
      ` : ''}

      ${abilities.length ? `
        <div class="detail-group">
          <h3>ABILITIES</h3>
          <div class="ability-tags">
            ${abilities.map(item => `<span>${escapeHtml(item)}</span>`).join('')}
          </div>
        </div>
      ` : ''}

      ${strengths.length ? `
        <div class="detail-group">
          <h3>STRENGTHS</h3>
          <ul>${strengths.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>
      ` : ''}

      ${weaknesses.length ? `
        <div class="detail-group">
          <h3>WEAKNESSES</h3>
          <ul>${weaknesses.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
        </div>
      ` : ''}

      ${sources.length ? `
        <div class="detail-group">
          <h3>REFERENCES</h3>
          <ul>${sources.map(source => `<li>${escapeHtml(source)}</li>`).join('')}</ul>
        </div>
      ` : ''}
    </div>
  `;
}

function startAuctionTimer() {
  clearInterval(timerInterval);

  const updateTimer = () => {
    if (!room || room.status !== 'auction') {
      clearInterval(timerInterval);
      return;
    }

    const timerElement = document.querySelector('#auctionTimer');
    if (!timerElement) return;

    const deadline = Number(room.turnDeadline || 0);
    const remaining = deadline
      ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      : 0;

    timerElement.textContent = `${remaining}s`;
    timerElement.classList.toggle('urgent', remaining <= 3);
  };

  updateTimer();
  timerInterval = setInterval(updateTimer, 250);
}

function renderAuction() {
  const player = me();
  const turn = currentPlayer();
  const myTurn = turn?.id === socket.id;
  const character = room.currentCharacter;

  const deadline = Number(room.turnDeadline || 0);
  const remaining = deadline
    ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
    : 0;

  const leader = room.players.find(
    player => player.id === room.highestBidderId
  );

  const teamSize = Number(room.settings?.teamSize || 0);
  const characterNumber = Math.max(0, Number(room.characterIndex || 0) + 1);
  const totalCharacters = room.characters?.length || 0;

  shell(`
    <main class="content">
      <div class="section-head">
        <div>
          <div class="eyebrow">
            LIVE AUCTION · CHARACTER ${characterNumber} OF ${totalCharacters}
          </div>
          <h1>THE BIDDING ARENA</h1>
        </div>
        <div class="room-chip">ROOM <b>${escapeHtml(room.code)}</b></div>
      </div>

      <div class="auction-layout">
        <section>${renderCharacterDetails(character)}</section>

        <section class="panel bid-panel">
          <div class="eyebrow">CURRENT HIGHEST BID</div>
          <div class="bid-value">${money(room.currentBid)}</div>
          <div class="bidder">
            ${leader ? `LEADING: ${escapeHtml(leader.name)}` : 'NO BIDS YET'}
          </div>

          <div class="turn-box">
            <div>
              <small>CURRENT TURN</small>
              <b>${escapeHtml(turn?.name || '—')}</b>
            </div>
            <div id="auctionTimer" class="timer ${remaining <= 3 ? 'urgent' : ''}">
              ${remaining}s
            </div>
          </div>

          ${myTurn ? `
            <div class="bid-controls">
              <div class="wallet-box">
                <small>YOUR REMAINING WALLET</small>
                <strong>${money(player?.budget)}</strong>
              </div>

              <label>INCREASE BY (₹)</label>
              <input id="bidAmount" type="number" min="1" step="1"
                value="${selectedBidIncrement}">

              <div class="quick-bids">
                <button data-bid="1">+₹1</button>
                <button data-bid="2">+₹2</button>
                <button data-bid="5">+₹5</button>
                <button data-bid="10">+₹10</button>
              </div>

              <button class="primary" id="bidBtn">INCREASE BID</button>
              <button class="skip" id="skipBtn">PASS THIS TURN</button>
            </div>
          ` : `
            <div class="waiting compact">
              <div class="pulse"></div>
              <b>WAITING FOR ${escapeHtml(turn?.name || 'PLAYER')}</b>
              <p>${turn ? 'Your turn will come around again.' : 'Waiting for an active player.'}</p>
            </div>
          `}
        </section>
      </div>

      <div class="stats-grid">
        ${room.players.map(pl => `
          <div class="stat-card ${pl.id === turn?.id ? 'active-player' : ''}">
            <b>${escapeHtml(pl.name)}</b>
            <strong>${money(pl.budget)}</strong>
            <small>${pl.team.length}/${teamSize} CHARACTERS</small>
          </div>
        `).join('')}
      </div>

      <section class="panel roster">
        <h2>YOUR TEAM <small>${player?.team?.length || 0} CHARACTERS</small></h2>
        <div class="mini-roster">
          ${(player?.team || []).map(character => `
            <span>
              ${escapeHtml(character.name)}
              <b>${character.allocatedFree ? 'FREE' : money(character.paid)}</b>
            </span>
          `).join('') || '<span class="muted">No characters purchased yet.</span>'}
        </div>
      </section>
    </main>
  `);

  const bidInput = document.querySelector('#bidAmount');

  if (bidInput) {
    bidInput.oninput = () => {
      selectedBidIncrement = bidInput.value;
    };
  }

  document.querySelectorAll('[data-bid]').forEach(button => {
    button.onclick = () => {
      selectedBidIncrement = Number(button.dataset.bid);
      if (bidInput) bidInput.value = selectedBidIncrement;
    };
  });

  const bidButton = document.querySelector('#bidBtn');

  if (bidButton) {
    bidButton.onclick = () => {
      const amount = Number(bidInput?.value);

      if (!Number.isInteger(amount) || amount < 1) {
        return toast('Enter a valid bid increase.');
      }

      selectedBidIncrement = amount;
      socket.emit('bid:increase', { amount });
    };
  }

  const skipButton = document.querySelector('#skipBtn');
  if (skipButton) skipButton.onclick = () => socket.emit('bid:skip');

  startAuctionTimer();
}

function renderAuctionReady() {
  const host = isHost();
  const characterNumber = Math.max(0, Number(room.characterIndex || 0) + 1);
  const totalCharacters = room.characters?.length || 0;
  const lastCharacter = room.currentCharacter;

  shell(`
    <main class="content">
      <div class="eyebrow">AUCTION PROGRESS</div>
      <h1>${characterNumber ? 'CHARACTER AUCTION RESOLVED' : 'READY TO BEGIN'}</h1>

      <section class="panel next-character-panel">
        <div class="eyebrow">AUCTION STATUS</div>
        <h2>
          ${characterNumber
            ? `CHARACTER ${characterNumber} OF ${totalCharacters} COMPLETED`
            : 'THE FIRST CHARACTER IS READY'}
        </h2>

        ${lastCharacter
          ? `<p class="intro">Last auction: <b>${escapeHtml(lastCharacter.name)}</b></p>`
          : '<p class="intro">The host will reveal the first randomly selected character.</p>'}

        <div class="progress-track">
          <div class="progress-fill"
            style="width:${totalCharacters ? Math.min(100, characterNumber / totalCharacters * 100) : 0}%">
          </div>
        </div>

        <p class="muted">${characterNumber} of ${totalCharacters} characters processed.</p>

        ${host ? `
          <button class="primary" id="nextCharacterBtn">
            ${characterNumber ? 'NEXT CHARACTER' : 'START FIRST AUCTION'}
          </button>
        ` : `
          <div class="waiting">
            <div class="pulse"></div>
            <h3>WAITING FOR HOST</h3>
            <p>The host controls when the next character appears.</p>
          </div>
        `}
      </section>

      <div class="stats-grid">
        ${room.players.map(player => `
          <div class="stat-card">
            <b>${escapeHtml(player.name)}</b>
            <strong>${money(player.budget)}</strong>
            <small>${player.team.length}/${room.settings.teamSize} CHARACTERS</small>
          </div>
        `).join('')}
      </div>

      <section class="panel roster">
        <h2>YOUR TEAM</h2>
        <div class="mini-roster">
          ${(me()?.team || []).map(character => `
            <span>
              ${escapeHtml(character.name)}
              <b>${character.allocatedFree ? 'FREE' : money(character.paid)}</b>
            </span>
          `).join('') || '<span class="muted">No characters yet.</span>'}
        </div>
      </section>
    </main>
  `);

  const nextButton = document.querySelector('#nextCharacterBtn');

  if (nextButton) {
    nextButton.onclick = () => {
      nextButton.disabled = true;
      nextButton.textContent = 'SELECTING CHARACTER...';
      socket.emit('auction:next-character');
    };
  }
}

function renderLoadingCharacters() {
  shell(`
    <main class="content">
      <section class="panel loading-panel">
        <div class="loading-orb">✦</div>
        <div class="eyebrow">PREPARING THE BATTLE</div>
        <h1>GENERATING CHARACTERS</h1>
        <p class="intro">
          Your selected genres are being prepared.
          The auction will begin as soon as the character pool is ready.
        </p>
        <div class="loading-bar">
          <div class="loading-bar-fill"></div>
        </div>
        <h3 class="loading-message">PLEASE WAIT...</h3>
        <p class="muted">
          This may take a little time while the character catalogue is generated.
        </p>
      </section>
    </main>
  `);
}

function renderTeamReveal() {
  const player = me();
  const team = list(player?.team);

  shell(`
    <main class="content">
      <div class="eyebrow">AUCTION COMPLETE</div>
      <h1>YOUR TEAM</h1>

      <p class="intro">
        Your team is complete. Take a moment to review your characters.
        Other players cannot see your team yet.
      </p>

      <section class="panel reveal-panel">
        <h2>YOUR SQUAD <small>${team.length}/${Number(room.settings?.teamSize || 0)}</small></h2>

        <div class="team-characters">
          ${team.map(character => `
            <div class="team-character">
              <b>${escapeHtml(character.name)}</b>
              <span>
                ${Number(character.rating || 0)}/100 ·
                ${character.allocatedFree ? 'FREE' : `Paid ${money(character.paid)}`}
              </span>
            </div>
          `).join('')}
        </div>

        <div class="team-total">
          REMAINING BUDGET <b>${money(player?.budget)}</b>
        </div>
      </section>

      <section class="panel waiting">
        <div class="pulse"></div>
        <h3>TEAM REVEAL IN PROGRESS</h3>
        <p>Your team is visible only to you.</p>
      </section>
    </main>
  `);
}

function renderReadyForFight() {
  const host = isHost();
  const player = me();
  const team = list(player?.team);

  shell(`
    <main class="content">
      <div class="eyebrow">AUCTION COMPLETE</div>
      <h1>YOUR TEAM IS READY</h1>

      <p class="intro">
        All players have completed their teams.
        Wait for the host to reveal the teams and begin the championship.
      </p>

      <section class="panel reveal-panel">
        <h2>YOUR TEAM <small>${team.length}/${Number(room.settings?.teamSize || 0)}</small></h2>

        <div class="team-characters">
          ${team.map(character => `
            <div class="team-character">
              <b>${escapeHtml(character.name)}</b>
              <span>
                ${Number(character.rating || 0)}/100 ·
                ${character.allocatedFree ? 'FREE' : `Paid ${money(character.paid)}`}
              </span>
            </div>
          `).join('') || '<p class="muted">Your team is not available.</p>'}
        </div>

        <div class="team-total">
          REMAINING BUDGET <b>${money(player?.budget)}</b>
        </div>
      </section>

      <div class="notice">
        <b>All teams are complete!</b>
        <p>The teams will remain private until the host presses COMPARE TEAMS.</p>
      </div>

      ${host ? `
        <button class="primary compare-button" id="fightBtn">
          COMPARE TEAMS
        </button>
      ` : `
        <div class="waiting">
          <div class="pulse"></div>
          <h3>WAITING FOR HOST</h3>
          <p>The host will reveal all teams and start the championship.</p>
        </div>
      `}
    </main>
  `);

  const fightButton = document.querySelector('#fightBtn');

  if (fightButton) {
    fightButton.onclick = () => {
      fightButton.disabled = true;
      fightButton.textContent = 'REVEALING TEAMS...';
      socket.emit('championship:start');
    };
  }
}

function matchPlayerName(match, side) {
  const playerId = side === 'a'
    ? match.teamAId || match.playerAId
    : match.teamBId || match.playerBId;

  const byId = room.players?.find(player => player.id === playerId);

  if (byId?.name) return byId.name;

  if (side === 'a') {
    return match.playerA?.name ||
      match.teamA?.name ||
      match.player1Name ||
      match.player1?.name ||
      'Team A';
  }

  return match.playerB?.name ||
    match.teamB?.name ||
    match.player2Name ||
    match.player2?.name ||
    'Team B';
}

function renderMatch(match, index) {
  const playerA = matchPlayerName(match, 'a');
  const playerB = matchPlayerName(match, 'b');

  const winnerId = match.winnerId || match.winner?.id;
  const winnerPlayer = room.players?.find(player => player.id === winnerId);
  const winner = winnerPlayer?.name ||
    match.winnerName ||
    match.winner?.name ||
    '';

  const isDraw =
    match.isDraw === true ||
    match.draw === true ||
    match.result === 'draw' ||
    (!winner && match.winnerId === null);

  const scoreA = match.scoreA ?? match.teamAScore ?? '';
  const scoreB = match.scoreB ?? match.teamBScore ?? '';

  return `
    <div class="match-card">
      <div class="match-number">MATCH ${index + 1}</div>

      <div class="match-teams">
        <b>${escapeHtml(playerA)}</b>
        <span class="match-vs">VS</span>
        <b>${escapeHtml(playerB)}</b>
      </div>

      ${scoreA !== '' || scoreB !== '' ? `
        <div class="match-score">${escapeHtml(scoreA)} – ${escapeHtml(scoreB)}</div>
      ` : ''}

      <div class="match-result">
        ${isDraw ? 'DRAW' : winner ? `WINNER: ${escapeHtml(winner)}` : escapeHtml(match.result || 'RESULT')}
      </div>

      ${match.explanation ? `
        <p class="muted">${escapeHtml(match.explanation)}</p>
      ` : ''}
    </div>
  `;
}

function findTeamEvaluation(player, championship) {
  if (player.evaluation) return player.evaluation;
  if (player.teamEvaluation) return player.teamEvaluation;
  if (player.analysis) return player.analysis;

  const evaluations = list(championship.teamEvaluations);
  return evaluations.find(item => item.playerId === player.id) || {};
}

function renderBulletList(items, emptyText = 'No details provided.') {
  const values = list(items);

  if (!values.length) {
    return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  }

  return `
    <ul class="analysis-list">
      ${values.map(item => {
        if (typeof item === 'string') {
          return `<li>${escapeHtml(item)}</li>`;
        }

        return `<li>${escapeHtml(
          item.description || item.contribution || item.reason || item.name || ''
        )}</li>`;
      }).join('')}
    </ul>
  `;
}

function renderContributions(items) {
  const values = list(items);

  if (!values.length) return '';

  return `
    <div class="analysis-section">
      <h4>KEY CHARACTER CONTRIBUTIONS</h4>
      <div class="contribution-list">
        ${values.map(item => `
          <div class="contribution-item">
            <b>${escapeHtml(item.characterName || item.name || 'Character')}</b>
            <p>${escapeHtml(item.contribution || item.description || '')}</p>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderTeamAnalysis(player, championship) {
  const evaluation = findTeamEvaluation(player, championship);

  const strengths = list(evaluation.strengths);
  const weaknesses = list(evaluation.weaknesses);
  const vulnerabilities = list(evaluation.vulnerabilities);
  const contributions = list(evaluation.keyContributions);

  const score = evaluation.score ??
    evaluation.teamScore ??
    player.teamStrength ??
    0;

  const summary = evaluation.summary ||
    evaluation.overallSummary ||
    player.aiSummary ||
    'A detailed evaluation was not returned for this team.';

  const synergy = evaluation.synergy;
  const balance = evaluation.balance;

  return `
    <section class="team-analysis-card">
      <div class="team-analysis-heading">
        <div>
          <div class="eyebrow">TEAM ANALYSIS</div>
          <h3>${escapeHtml(player.name)}</h3>
        </div>
        <div class="analysis-score">
          <strong>${Number(score)}/100</strong>
          <small>TEAM SCORE</small>
        </div>
      </div>

      <p class="analysis-summary">${escapeHtml(summary)}</p>

      ${evaluation.rankingRationale ? `
        <div class="analysis-section">
          <h4>WHY THIS TEAM GOT THIS RANK</h4>
          <p>${escapeHtml(evaluation.rankingRationale)}</p>
        </div>
      ` : ''}

      <div class="analysis-columns">
        <div class="analysis-section">
          <h4>STRENGTHS</h4>
          ${renderBulletList(strengths, 'No strengths were specified.')}
        </div>

        <div class="analysis-section">
          <h4>WEAKNESSES</h4>
          ${renderBulletList(weaknesses, 'No weaknesses were specified.')}
        </div>

        <div class="analysis-section">
          <h4>VULNERABILITIES</h4>
          ${renderBulletList(vulnerabilities, 'No specific vulnerabilities were listed.')}
        </div>
      </div>

      ${(synergy || balance) ? `
        <div class="analysis-columns">
          ${synergy ? `
            <div class="analysis-section">
              <h4>TEAM SYNERGY</h4>
              <p>${escapeHtml(
                typeof synergy === 'string'
                  ? synergy
                  : synergy.explanation || synergy.description || JSON.stringify(synergy)
              )}</p>
            </div>
          ` : ''}

          ${balance ? `
            <div class="analysis-section">
              <h4>TEAM BALANCE</h4>
              <p>${escapeHtml(
                typeof balance === 'string'
                  ? balance
                  : balance.explanation || balance.description || JSON.stringify(balance)
              )}</p>
            </div>
          ` : ''}
        </div>
      ` : ''}

      ${renderContributions(contributions)}
    </section>
  `;
}

function renderChampionship() {
  const championship = room.championship || {};
  const standings = list(championship.standings);
  const matches = list(championship.matches);
  const aiEvaluation = championship.aiEvaluation || {};

  const overallSummary = aiEvaluation.overallSummary ||
    championship.overallSummary ||
    '';

  const rankingExplanation = aiEvaluation.rankingExplanation ||
    championship.rankingExplanation ||
    '';

  shell(`
    <main class="content">
      <div class="eyebrow">CHAMPIONSHIP COMPLETE</div>
      <h1>THE BATTLE FOR THE CROWN</h1>

      <p class="intro">
        Every team has faced every other team. Here are the match results,
        final standings and detailed team evaluations.
      </p>

      ${overallSummary ? `
        <section class="panel championship-summary">
          <div class="eyebrow">CHAMPIONSHIP OVERVIEW</div>
          <h2>THE FINAL VERDICT</h2>
          <p>${escapeHtml(overallSummary)}</p>
        </section>
      ` : ''}

      <section class="panel">
        <h2>FINAL LEADERBOARD</h2>

        ${standings.length ? `
          <div class="leaderboard">
            <div class="leaderboard-row leaderboard-header">
              <span>RANK</span>
              <span>PLAYER</span>
              <span>W</span>
              <span>D</span>
              <span>L</span>
              <span>POINTS</span>
            </div>

            ${standings.map(player => `
              <div class="leaderboard-row">
                <b>#${Number(player.rank || 0)}</b>
                <strong>${escapeHtml(player.name)}</strong>
                <span>${Number(player.wins || 0)}</span>
                <span>${Number(player.draws || 0)}</span>
                <span>${Number(player.losses || 0)}</span>
                <b>${Number(player.points || 0)}</b>
              </div>
            `).join('')}
          </div>
        ` : '<p class="muted">The server did not return leaderboard data.</p>'}

        <div class="notice">
          <b>Ranking rules</b>
          <p>
            ${escapeHtml(
              Array.isArray(championship.rankingRules)
                ? championship.rankingRules.join(' · ')
                : championship.rankingRules ||
                  'Teams are ranked by points, then wins, score difference and team strength.'
            )}
          </p>
        </div>

        ${rankingExplanation ? `
          <div class="analysis-section ranking-explanation">
            <h3>WHY THE TEAMS ARE RANKED THIS WAY</h3>
            <p>${escapeHtml(rankingExplanation)}</p>
          </div>
        ` : ''}
      </section>

      <section class="panel">
        <h2>ALL MATCH RESULTS</h2>
        <div class="matches-grid">
          ${matches.length
            ? matches.map((match, index) => renderMatch(match, index)).join('')
            : '<p class="muted">No match reports are available.</p>'}
        </div>
      </section>

      <section class="panel">
        <h2>DETAILED TEAM EVALUATIONS</h2>
        <p class="muted">
          These evaluations explain what each team does well, where it is vulnerable
          and how its characters contribute to the overall team.
        </p>

        <div class="team-analysis-grid">
          ${room.players.map(player =>
            renderTeamAnalysis(player, championship)
          ).join('')}
        </div>
      </section>

      <section class="panel">
        <h2>FINAL TEAM ROSTERS</h2>
        <div class="team-grid">
          ${room.players.map(player => {
            const evaluation = findTeamEvaluation(player, championship);
            const standing = standings.find(
              item => item.playerId === player.id
            );

            return `
              <section class="panel">
                <h2>${escapeHtml(player.name)}</h2>
                <div class="team-characters">
                  ${player.team.map(character => `
                    <div class="team-character">
                      <b>${escapeHtml(character.name)}</b>
                      <span>
                        ${Number(character.rating || 0)}/100 ·
                        ${character.allocatedFree ? 'FREE' : `Paid ${money(character.paid)}`}
                      </span>
                    </div>
                  `).join('')}
                </div>
                <div class="team-total">
                  TEAM STRENGTH
                  <b>${Number(
                    standing?.teamStrength ??
                    evaluation.score ??
                    evaluation.teamScore ??
                    0
                  )}</b>
                </div>
              </section>
            `;
          }).join('')}
        </div>
      </section>

      <button class="secondary" id="homeBtn">RETURN TO HOME</button>
    </main>
  `);

  document.querySelector('#homeBtn').onclick = () => {
    room = null;
    latestStateVersion = -1;
    errorMessage = '';
    render();
  };
}

function renderIncomplete() {
  shell(`
    <main class="content">
      <div class="eyebrow">AUCTION FINISHED</div>
      <h1>TEAMS COULD NOT BE COMPLETED</h1>

      <section class="panel">
        <h2>INCOMPLETE TEAM WARNING</h2>
        <p class="intro">
          The available characters were not sufficient to fill every team slot.
        </p>

        <div class="notice">
          ${escapeHtml(room.completionError ||
            'The server could not allocate enough reserve characters to complete all teams.')}
        </div>

        <div class="team-grid">
          ${room.players.map(player => `
            <section class="panel">
              <h2>${escapeHtml(player.name)}</h2>
              <p>${player.team.length}/${room.settings.teamSize} characters</p>
              <div class="team-characters">
                ${player.team.map(character => `
                  <div class="team-character">
                    <b>${escapeHtml(character.name)}</b>
                    <span>${Number(character.rating || 0)}/100</span>
                  </div>
                `).join('')}
              </div>
            </section>
          `).join('')}
        </div>
      </section>
    </main>
  `);
}

function renderPaused() {
  shell(`
    <main class="content">
      <div class="eyebrow">AUCTION PAUSED</div>
      <h1>WAITING FOR PLAYERS</h1>
      <section class="panel waiting">
        <div class="pulse"></div>
        <h3>THE AUCTION IS PAUSED</h3>
        <p>
          There are currently no connected players available to continue.
          Reconnect to the room to continue.
        </p>
      </section>
    </main>
  `);
}

function render() {
  clearInterval(timerInterval);

  if (!room) return renderHome();

  switch (room.status) {
    case 'lobby':
      return renderLobby();

    case 'loading_characters':
      return renderLoadingCharacters();

    case 'auction_ready':
      return renderAuctionReady();

    case 'auction':
      return renderAuction();

    case 'auction_paused':
      return renderPaused();

    case 'team_reveal':
      return renderTeamReveal();

    case 'ready_for_fight':
      return renderReadyForFight();

    case 'championship':
      return renderChampionship();

    case 'incomplete':
      return renderIncomplete();

    default:
      shell(`
        <main class="content">
          <h1>UNKNOWN GAME STATUS</h1>
          <p class="muted">Status received: ${escapeHtml(room.status)}</p>
        </main>
      `);
  }
}

render();
