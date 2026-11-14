
import { io } from 'socket.io-client';
import './style.css';

const socket = io();

let room = null;
let playerName = localStorage.getItem('ba_name') || '';
let selectedUniverses = ['Marvel', 'DC'];
let selectedBidIncrement = 1;
let errorMessage = '';
let toastTimer;
let renderTimer;

const root = document.querySelector('#root');

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);

const me = () => room?.players?.find(player => player.id === socket.id);

const activePlayers = () =>
  room?.players?.filter(player => player.connected) || [];

const currentPlayer = () =>
  activePlayers()[room?.currentTurnIndex];

const money = value => `₹${Number(value || 0)}`;

const list = value => Array.isArray(value) ? value : [];

const isHost = () => room?.hostId === socket.id;

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
  room = data;
  errorMessage = '';
  render();
});

socket.on('room:joined', data => {
  room = data;
  errorMessage = '';
  render();
});

socket.on('room:update', data => {
  room = data;
  render();
});

socket.on('error:message', toast);

socket.on('connect', () => {
  render();
});

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

    if (!name || !code) {
      return toast('Enter your name and room code.');
    }

    playerName = name;
    localStorage.setItem('ba_name', name);

    socket.emit('room:join', { name, code });
  };
}

function renderLobby() {
  const host = isHost();

  const universeOptions = [
    'Marvel',
    'DC',
    'Naruto',
    'Dragon Ball',
    'Ramayana',
    'Mahabharata'
  ];

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
            <label>Universes (choose one or more)</label>

            <div class="universe-picks">
              ${universeOptions.map(universe => `
                <label class="check">
                  <input type="checkbox"
                    value="${escapeHtml(universe)}"
                    ${selectedUniverses.includes(universe) ? 'checked' : ''}>
                  ${escapeHtml(universe)}
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
                <input id="turnSeconds" type="number" min="5" max="60"
                  value="${Number(room.settings?.turnSeconds || 10)}">
              </div>
            </div>

            <label>Starting bid (₹)</label>
            <input id="startingBid" type="number" min="1"
              value="${Number(room.settings?.startingBid || 1)}">

            <div class="notice">
              <b>Automatic character count</b>
              <p>
                Required characters =
                number of players × team size.
              </p>
              <p>
                Current requirement:
                <b id="requiredCount">${room.players.length * Number(room.settings?.teamSize || 3)} characters</b>
              </p>
              <p>Each player starts with ₹100.</p>
            </div>

            <button class="primary" id="startBtn"
              ${room.players.length < 2 ? 'disabled' : ''}>
              START AUCTION
            </button>

            <p class="muted">
              The server checks whether the selected universes contain enough
              characters before starting.
            </p>
          ` : `
            <div class="waiting">
              <div class="pulse"></div>
              <h3>WAITING FOR HOST</h3>
              <p>
                The host is configuring the auction. The game will begin
                when they start it.
              </p>
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
      const count = room.players.length * size;
      document.querySelector('#requiredCount').textContent =
        `${count} characters`;
    };
  }

  const startButton = document.querySelector('#startBtn');

  if (startButton) {
    startButton.onclick = () => {
      const teamSize = Number(document.querySelector('#teamSize').value);
      const turnSeconds = Number(document.querySelector('#turnSeconds').value);
      const startingBid = Number(document.querySelector('#startingBid').value);

      if (!selectedUniverses.length) {
        return toast('Select at least one universe.');
      }

      if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 20) {
        return toast('Enter a valid team size.');
      }

      if (!Number.isInteger(turnSeconds) || turnSeconds < 5 || turnSeconds > 60) {
        return toast('Turn duration must be between 5 and 60 seconds.');
      }

      if (!Number.isInteger(startingBid) || startingBid < 1 || startingBid >= 100) {
        return toast('Starting bid must be between ₹1 and ₹99.');
      }

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
    Naruto: '忍',
    'Dragon Ball': '✧',
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
        <div class="character-art">
          ${characterIcon(character.universe)}
        </div>
      `}

      <div class="universe-label">
        ${escapeHtml(character.universe)} · ${escapeHtml(character.version)}
      </div>

      <h2>${escapeHtml(character.name)}</h2>

      <div class="rating">
        POWER RATING <b>${Number(character.rating || 0)}/100</b>
      </div>

      ${character.description ? `
        <p class="character-description">
          ${escapeHtml(character.description)}
        </p>
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
          <ul>
            ${sources.map(source => `<li>${escapeHtml(source)}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
    </div>
  `;
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

        <div class="room-chip">
          ROOM <b>${escapeHtml(room.code)}</b>
        </div>
      </div>

      <div class="auction-layout">
        <section>
          ${renderCharacterDetails(character)}
        </section>

        <section class="panel bid-panel">
          <div class="eyebrow">CURRENT HIGHEST BID</div>

          <div class="bid-value">${money(room.currentBid)}</div>

          <div class="bidder">
            ${leader
              ? `LEADING: ${escapeHtml(leader.name)}`
              : 'NO BIDS YET'}
          </div>

          <div class="turn-box">
            <div>
              <small>CURRENT TURN</small>
              <b>${escapeHtml(turn?.name || '—')}</b>
            </div>

            <div class="timer ${remaining <= 3 ? 'urgent' : ''}">
              ${remaining}s
            </div>
          </div>

          ${myTurn ? `
            <div class="bid-controls">
              <label>INCREASE BY (₹)</label>

              <input id="bidAmount" type="number"
                min="1" step="1"
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
              <p>
                ${turn
                  ? 'Your turn will come around again.'
                  : 'Waiting for an active player.'}
              </p>
            </div>
          `}
        </section>
      </div>

      <div class="stats-grid">
        ${room.players.map(pl => `
          <div class="stat-card ${pl.id === turn?.id ? 'active-player' : ''}">
            <b>${escapeHtml(pl.name)}</b>
            <strong>${money(pl.budget)}</strong>
            <small>
              ${pl.team.length}/${teamSize} CHARACTERS
            </small>
          </div>
        `).join('')}
      </div>

      <section class="panel roster">
        <h2>
          YOUR TEAM
          <small>${player?.team?.length || 0} CHARACTERS</small>
        </h2>

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

  // Preserve the selected increment when the screen refreshes.
  const bidInput = document.querySelector('#bidAmount');

  if (bidInput) {
    bidInput.oninput = () => {
      selectedBidIncrement = bidInput.value;
    };
  }

  document.querySelectorAll('[data-bid]').forEach(button => {
    button.onclick = () => {
      selectedBidIncrement = Number(button.dataset.bid);
      if (bidInput) {
        bidInput.value = selectedBidIncrement;
      }
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

      // Only this button submits the bid.
      socket.emit('bid:increase', { amount });
    };
  }

  const skipButton = document.querySelector('#skipBtn');

  if (skipButton) {
    skipButton.onclick = () => socket.emit('bid:skip');
  }

  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    if (room?.status === 'auction') render();
  }, 1000);
}

function renderAuctionReady() {
  const host = isHost();
  const characterNumber = Math.max(0, Number(room.characterIndex || 0) + 1);
  const totalCharacters = room.characters?.length || 0;
  const finished = characterNumber;

  const lastCharacter = room.currentCharacter;

  shell(`
    <main class="content">
      <div class="eyebrow">AUCTION PROGRESS</div>
      <h1>${finished ? 'CHARACTER AUCTION RESOLVED' : 'READY TO BEGIN'}</h1>

      <section class="panel next-character-panel">
        <div class="eyebrow">AUCTION STATUS</div>

        <h2>
          ${finished
            ? `CHARACTER ${finished} OF ${totalCharacters} COMPLETED`
            : 'THE FIRST CHARACTER IS READY'}
        </h2>

        ${lastCharacter ? `
          <p class="intro">
            Last auction: <b>${escapeHtml(lastCharacter.name)}</b>
          </p>
        ` : `
          <p class="intro">
            The host will reveal the first randomly selected character.
          </p>
        `}

        <div class="progress-track">
          <div class="progress-fill"
            style="width:${totalCharacters ? Math.min(100, finished / totalCharacters * 100) : 0}%">
          </div>
        </div>

        <p class="muted">
          ${finished} of ${totalCharacters} characters processed.
        </p>

        ${host ? `
          <button class="primary" id="nextCharacterBtn">
            ${finished ? 'NEXT CHARACTER' : 'START FIRST AUCTION'}
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
            <small>
              ${player.team.length}/${room.settings.teamSize} CHARACTERS
            </small>
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

function renderReadyForFight() {
  const host = isHost();

  shell(`
    <main class="content">
      <div class="eyebrow">AUCTION COMPLETE</div>
      <h1>YOUR TEAMS ARE READY</h1>

      <p class="intro">
        All team slots have been filled. Review your squads before the
        championship begins.
      </p>

      <div class="team-grid">
        ${room.players.map(player => `
          <section class="panel">
            <h2>${escapeHtml(player.name)}</h2>

            <div class="team-characters">
              ${player.team.map(character => `
                <div class="team-character">
                  <b>${escapeHtml(character.name)}</b>
                  <span>
                    ${Number(character.rating || 0)}/100 ·
                    ${character.allocatedFree ? 'Reserve allocation' : `Paid ${money(character.paid)}`}
                  </span>
                </div>
              `).join('')}
            </div>

            <div class="team-total">
              REMAINING BUDGET <b>${money(player.budget)}</b>
            </div>
          </section>
        `).join('')}
      </div>

      <div class="notice">
        <b>Reserve characters allocated:</b>
        ${Number(room.reserveCount || 0)}
        <p>
          Any unsold characters used to complete teams were allocated
          automatically without duplicate assignments.
        </p>
      </div>

      ${host ? `
        <button class="primary" id="fightBtn">FIGHT — START CHAMPIONSHIP</button>
      ` : `
        <div class="waiting">
          <div class="pulse"></div>
          <h3>WAITING FOR HOST</h3>
          <p>The host will start the championship.</p>
        </div>
      `}
    </main>
  `);

  const fightButton = document.querySelector('#fightBtn');

  if (fightButton) {
    fightButton.onclick = () => {
      fightButton.disabled = true;
      fightButton.textContent = 'PREPARING CHAMPIONSHIP...';
      socket.emit('championship:start');
    };
  }
}

function matchPlayerName(match, side) {
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

  const winner =
    match.winnerName ||
    match.winner?.name ||
    '';

  const isDraw =
    match.isDraw === true ||
    match.draw === true ||
    match.result === 'draw';

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
        <div class="match-score">
          ${escapeHtml(scoreA)} – ${escapeHtml(scoreB)}
        </div>
      ` : ''}

      <div class="match-result">
        ${isDraw
          ? 'DRAW'
          : winner
            ? `WINNER: ${escapeHtml(winner)}`
            : escapeHtml(match.result || 'RESULT')}
      </div>

      ${match.explanation ? `
        <p class="muted">${escapeHtml(match.explanation)}</p>
      ` : ''}
    </div>
  `;
}

function renderChampionship() {
  const championship = room.championship || {};
  const standings = list(championship.standings);
  const matches = list(championship.matches);

  shell(`
    <main class="content">
      <div class="eyebrow">CHAMPIONSHIP COMPLETE</div>
      <h1>THE BATTLE FOR THE CROWN</h1>

      <p class="intro">
        Every team has faced every other team. Here are the match results
        and final standings.
      </p>

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
        ` : `
          <p class="muted">The server did not return leaderboard data.</p>
        `}

        <div class="notice">
          <b>Ranking rules</b>
          <p>
            ${escapeHtml(
              championship.rankingRules ||
              'Teams are ranked by points, then wins, score difference and team strength.'
            )}
          </p>
        </div>
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
        <h2>FINAL TEAM ROSTERS</h2>

        <div class="team-grid">
          ${room.players.map(player => `
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
                  standings.find(item => item.id === player.id)?.teamStrength || 0
                )}</b>
              </div>
            </section>
          `).join('')}
        </div>
      </section>

      <button class="secondary" id="homeBtn">RETURN TO HOME</button>
    </main>
  `);

  document.querySelector('#homeBtn').onclick = () => {
    room = null;
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
          ${escapeHtml(
            room.completionError ||
            'The server could not allocate enough reserve characters to complete all teams.'
          )}
        </div>

        <div class="team-grid">
          ${room.players.map(player => `
            <section class="panel">
              <h2>${escapeHtml(player.name)}</h2>
              <p>
                ${player.team.length}/${room.settings.teamSize} characters
              </p>

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
  clearTimeout(renderTimer);

  if (!room) return renderHome();

  switch (room.status) {
    case 'lobby':
      return renderLobby();

    case 'auction_ready':
      return renderAuctionReady();

    case 'auction':
      return renderAuction();

    case 'auction_paused':
      return renderPaused();

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
          <p class="muted">
            Status received: ${escapeHtml(room.status)}
          </p>
        </main>
      `);
  }
}

render();
