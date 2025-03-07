const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors')

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*', // Permitir todas las conexiones (ajústalo a tu URL de GitHub Pages más tarde)
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const games = {};

function generateGameCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function assignRoles(players, gameId) {
  const nonHostPlayers = players.filter(p => !p.isHost && p.id && !p.disconnected);
  const playerCount = nonHostPlayers.length;
  const roles = [];

  if (playerCount >= 4) {
    roles.push('seer');
    roles.push('werewolf');
    roles.push('doctor');
    roles.push('villager');
  }
  if (playerCount >= 5) roles.push('witch');
  if (playerCount >= 6) roles.push('hunter');
  if (playerCount >= 7) roles.push('girl');
  if (playerCount >= 8) roles.push('werewolf');
  if (playerCount >= 9) roles.push('villager');
  if (playerCount >= 10) roles.push('cupid');
  if (playerCount >= 11) roles.push('fox');
  if (playerCount >= 12) roles.push('werewolf');

  let remainingPlayers = playerCount - roles.length;
  if (playerCount > 12) {
    const extraGroups = Math.floor(remainingPlayers / 4);
    const leftovers = remainingPlayers % 4;

    for (let i = 0; i < extraGroups; i++) {
      roles.push('villager');
      roles.push('villager');
      roles.push('villager');
      roles.push('werewolf');
    }
    for (let i = 0; i < leftovers; i++) roles.push('villager');
  }

  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  let roleIndex = 0;
  nonHostPlayers.forEach(player => {
    if (games[gameId] && games[gameId].players[player.id]) {
      games[gameId].players[player.id].role = roles[roleIndex++];
    }
  });
}

function resetGame(gameId) {
  if (games[gameId]) {
    const currentPlayers = { ...games[gameId].players };
    const hostPlayerId = games[gameId].host;
    games[gameId] = {
      host: hostPlayerId,
      players: currentPlayers,
      state: 'lobby',
      day: 0,
      time: 'day',
      votes: {},
      gameOver: false,
      winner: null,
    };
    Object.values(games[gameId].players).forEach(player => {
      if (!player.isHost) {
        player.role = null;
        player.alive = true;
        player.disconnected = false;
      }
    });
    io.to(gameId).emit('gameReset', {
      gameId,
      players: Object.values(games[gameId].players).map(p => ({
        id: p.id,
        name: p.name,
        role: p.role, // Incluir el rol aquí
        alive: p.alive,
        isHost: p.isHost,
      })),
    });
  }
}

io.on('connection', (socket) => {
  console.log('Usuario conectado:', socket.id);

  socket.on('restoreSession', ({ playerId, gameId }) => {
    gameId = gameId.toUpperCase();
    if (!games[gameId]) {
      socket.emit('error', { message: 'Partida no encontrada' });
      return;
    }
  
    const game = games[gameId];
    let player = Object.values(game.players).find(p => p.id === playerId || (p.disconnected && p.name === game.players[playerId]?.name));
  
    if (!player) {
      socket.emit('error', { message: 'Sesión no válida o jugador no encontrado' });
      return;
    }
  
    const oldSocketId = player.id;
    player.id = socket.id;
    player.disconnected = false;
    socket.join(gameId);
    socket.playerId = player.id;
    socket.gameId = gameId;
  
    delete game.players[oldSocketId];
    game.players[socket.id] = player;
  
    socket.emit('sessionRestored', {
      playerId: player.id,
      gameId,
      role: player.isHost ? null : player.role,
      alive: player.alive,
      isHost: player.isHost,
      state: {
        state: game.state,
        day: game.day,
        time: game.time,
        players: Object.values(game.players).map(p => ({
          id: p.id,
          name: p.name,
          alive: p.alive,
          isHost: p.isHost,
        })),
      },
    });
  
    io.to(gameId).emit('playerReconnected', { playerId: player.id, name: player.name, isHost: player.isHost });
    // Enviar roles completos al host
    io.to(gameId).emit('updatePlayers', Object.values(games[gameId].players).map(p => ({
      id: p.id,
      name: p.name,
      role: p.role, // Incluir el rol aquí
      alive: p.alive,
      isHost: p.isHost,
      disconnected: p.disconnected,
    })));
    io.to(gameId).emit('updateGameState', {
      state: games[gameId].state,
      day: games[gameId].day,
      time: games[gameId].time,
      players: Object.values(games[gameId].players).map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        isHost: p.isHost,
      })),
    });
  });

  socket.on('createGame', (hostName) => {
    const gameId = generateGameCode();
    games[gameId] = {
      host: socket.id,
      players: {},
      state: 'lobby',
      day: 0,
      time: 'day',
      votes: {},
      gameOver: false,
      winner: null,
    };
    
    games[gameId].players[socket.id] = {
      id: socket.id,
      name: hostName,
      role: null,
      alive: true,
      isHost: true,
      disconnected: false,
    };
    
    socket.join(gameId);
    socket.emit('gameCreated', { gameId, playerId: socket.id });
    io.to(gameId).emit('updatePlayers', Object.values(games[gameId].players).map(p => ({
      id: p.id,
      name: p.name,
      role: p.role, // Incluir el rol aquí
      alive: p.alive,
      isHost: p.isHost,
      disconnected: p.disconnected,
    })));
  });

  socket.on('joinGame', ({ gameId, playerName }) => {
    gameId = gameId.toUpperCase();
    
    if (!games[gameId]) {
      socket.emit('error', { message: 'Partida no encontrada' });
      return;
    }
    
    if (games[gameId].state !== 'lobby') {
      socket.emit('error', { message: 'La partida ya ha comenzado' });
      return;
    }
    
    games[gameId].players[socket.id] = {
      id: socket.id,
      name: playerName,
      role: null,
      alive: true,
      isHost: false,
      disconnected: false,
    };
    
    socket.join(gameId);
    socket.emit('gameJoined', { gameId, playerId: socket.id });
    io.to(gameId).emit('updatePlayers', Object.values(games[gameId].players).map(p => ({
      id: p.id,
      name: p.name,
      role: p.role, // Incluir el rol aquí
      alive: p.alive,
      isHost: p.isHost,
      disconnected: p.disconnected,
    })));
  });

  socket.on('startGame', (data) => {
    if (!games[data.gameId] || games[data.gameId].host !== data.playerId) {
      socket.emit('error', { message: 'No tienes permisos para iniciar esta partida o la partida no existe' });
      return;
    }
    
    const players = Object.values(games[data.gameId].players);
    const nonHostPlayers = players.filter(p => !p.isHost && !p.disconnected);
    
    if (nonHostPlayers.length < 4) {
      socket.emit('error', { message: 'Se necesitan al menos 4 jugadores activos (excluyendo al anfitrión)' });
      return;
    }
    
    games[data.gameId].state = 'playing';
    games[data.gameId].day = 1;
    games[data.gameId].time = 'night';
    
    assignRoles(players, data.gameId);
    
    players.forEach(player => {
      if (!player.isHost && player.id) {
        io.to(player.id).emit('roleAssigned', { role: games[data.gameId].players[player.id].role });
      }
    });
    
    io.to(games[data.gameId].host).emit('hostGameStarted', {
      players: Object.values(games[data.gameId].players).map(p => ({
        id: p.id,
        name: p.name,
        role: p.role, // Asegurar que el rol se envíe al host
        alive: p.alive,
      })),
    });
    
    io.to(data.gameId).emit('gameStarted');
    io.to(data.gameId).emit('updateGameState', {
      state: games[data.gameId].state,
      day: games[data.gameId].day,
      time: games[data.gameId].time,
      players: Object.values(games[data.gameId].players).map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        isHost: p.isHost,
      })),
    });
  });

  socket.on('updateHostSocket', ({ gameId, playerId }) => {
    if (games[gameId] && games[gameId].players[playerId] && games[gameId].players[playerId].isHost) {
      games[gameId].host = socket.id;
      games[gameId].players[playerId].id = socket.id;
    }
  });

  socket.on('flipCard', ({ gameId, playerId }) => {
    if (games[gameId] && games[gameId].players[playerId] && !games[gameId].players[playerId].isHost) {
      io.to(playerId).emit('cardFlipped');
    }
  });

  socket.on('updatePlayerStatus', ({ gameId, playerId, alive }) => {
    if (!games[gameId] || games[gameId].host !== socket.id) return;
    if (games[gameId].players[playerId] && !games[gameId].players[playerId].isHost) {
      games[gameId].players[playerId].alive = alive;
      io.to(gameId).emit('updateGameState', {
        state: games[gameId].state,
        day: games[gameId].day,
        time: games[gameId].time,
        players: Object.values(games[gameId].players).map(p => ({
          id: p.id,
          name: p.name,
          alive: p.alive,
          isHost: p.isHost,
        })),
      });
    }
  });

  socket.on('showPlayerRole', ({ gameId, playerId }) => {
    if (!games[gameId] || games[gameId].host !== socket.id) return;
    const player = games[gameId].players[playerId];
    if (player) { // Permitir mostrar cualquier carta, incluso la del host si se desea
      io.to(games[gameId].host).emit('displayPlayerRole', { name: player.name, role: player.role });
    }
  });

  socket.on('requestPlayers', (gameId) => {
    if (!games[gameId] || games[gameId].host !== socket.id) return;
    const players = Object.values(games[gameId].players).map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      alive: p.alive,
      isHost: p.isHost,
      disconnected: p.disconnected,
    }));
    io.to(socket.id).emit('playersList', players);
  });

  socket.on('dayVote', ({ gameId, targetId }) => {
    if (!games[gameId] || games[gameId].time !== 'day' || !games[gameId].players[targetId]) return;
    if (!games[gameId].players[socket.id] || !games[gameId].players[socket.id].alive || games[gameId].players[socket.id].isHost) return;

    const validPlayers = Object.values(games[gameId].players).filter(p => !p.isHost && p.alive);
    const isValidTarget = validPlayers.some(p => p.id === targetId);

    if (!isValidTarget) {
      socket.emit('error', { message: 'Jugador objetivo no válido o no está vivo' });
      return;
    }

    games[gameId].votes[socket.id] = targetId;

    io.to(gameId).emit('voteUpdate', {
      playerName: games[gameId].players[socket.id].name,
      targetName: games[gameId].players[targetId].name,
    });

    io.to(gameId).emit('updateGameState', {
      state: games[gameId].state,
      day: games[gameId].day,
      time: games[gameId].time,
      players: Object.values(games[gameId].players).map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        isHost: p.isHost,
      })),
    });
  });

  socket.on('advancePhase', (gameId) => {
    if (!games[gameId] || games[gameId].host !== socket.id) return;
    const game = games[gameId];
    if (game.time === 'night') {
      // Guardar estado previo para detectar muertes
      const previousAlivePlayers = Object.values(game.players)
        .filter(p => !p.isHost && p.alive)
        .map(p => p.id);
      
      game.time = 'day';
      
      // Detectar jugadores que murieron (simulado por el host en este caso)
      const currentAlivePlayers = Object.values(game.players)
        .filter(p => !p.isHost && p.alive)
        .map(p => p.id);
      const deadPlayers = previousAlivePlayers
        .filter(id => !currentAlivePlayers.includes(id))
        .map(id => game.players[id].name);
  
      io.to(gameId).emit('nightEnd', { deadPlayers });
    } else {
      game.time = 'night';
      game.day++;
      let eliminatedPlayerName = null;
      const voteCounts = {};
      for (const playerId in game.votes) {
        const vote = game.votes[playerId];
        if (vote && game.players[vote] && !game.players[vote].isHost && game.players[vote].alive) {
          voteCounts[vote] = (voteCounts[vote] || 0) + 1;
        }
      }
      let maxVotes = 0;
      let selectedPlayer = null;
      for (const [playerId, count] of Object.entries(voteCounts)) {
        if (count > maxVotes) {
          maxVotes = count;
          selectedPlayer = playerId;
        } else if (count === maxVotes && Math.random() < 0.5) {
          selectedPlayer = playerId;
        }
      }
      if (selectedPlayer && maxVotes > 0) {
        game.players[selectedPlayer].alive = false;
        eliminatedPlayerName = game.players[selectedPlayer].name;
      }
      game.votes = {};
      io.to(gameId).emit('dayEnd', { eliminatedPlayer: eliminatedPlayerName });
    }
    io.to(gameId).emit('updateGameState', {
      state: game.state,
      day: game.day,
      time: game.time,
      players: Object.values(game.players).map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        isHost: p.isHost,
      })),
    });
    checkGameEnd(gameId);
  });

  socket.on('disconnect', () => {
    const playerId = socket.playerId;
    const gameId = socket.gameId;
    if (playerId && gameId && games[gameId] && games[gameId].players[playerId]) {
      games[gameId].players[playerId].disconnected = true;
      io.to(gameId).emit('playerDisconnected', { playerId, name: games[gameId].players[playerId].name, isHost: games[gameId].players[playerId].isHost });
    }
  });

  socket.on('playAgain', (gameId) => {
    gameId = gameId.toUpperCase();
    if (games[gameId]) resetGame(gameId);
  });

  function checkGameEnd(gameId) {
    const game = games[gameId];
    if (!game) return;
    
    const alivePlayers = Object.values(game.players).filter(p => p.alive && !p.isHost);
    const aliveWerewolves = alivePlayers.filter(p => p.role === 'werewolf');
    const aliveVillagers = alivePlayers.filter(p => p.role !== 'werewolf');
    
    let gameOver = false;
    let winner = null;
    
    if (aliveWerewolves.length >= aliveVillagers.length) {
      gameOver = true;
      winner = 'werewolves';
    } else if (aliveWerewolves.length === 0) {
      gameOver = true;
      winner = 'villagers';
    }
    
    if (gameOver) {
      game.gameOver = true;
      game.winner = winner;
      io.to(gameId).emit('gameOver', {
        winner,
        roles: Object.values(game.players).filter(p => !p.isHost).map(p => ({
          name: p.name,
          role: p.role,
        })),
      });
    }
  }
});

const PORT = process.env.PORT || 25565;
server.listen(PORT, () => {
  console.log(`Servidor en funcionamiento en http://localhost:${PORT}`);
});