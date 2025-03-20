const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors')

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*', // Permitir todas las conexiones
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const games = {};

function generateGameCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString(); // Genera un número entre 1000 y 9999
  } while (games[code]); // Evita colisiones
  return code;
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
  
    if (player.isHost) {
      game.host = socket.id;
      console.log(`Host actualizado: ${socket.id} para gameId ${gameId}`);
    }
  
    // Transferir voto si existe
    if (game.votes[oldSocketId]) {
      game.votes[socket.id] = game.votes[oldSocketId];
      delete game.votes[oldSocketId];
    }
  
    delete game.players[oldSocketId];
    game.players[socket.id] = player;
  
    const stateToSend = {
      state: game.state,
      day: game.day,
      time: game.time,
      players: Object.values(game.players).map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        isHost: p.isHost,
      })),
    };
  
    const hasVoted = !!game.votes[socket.id]; // Verificar si el jugador ya votó
    console.log(`Restaurando sesión para ${socket.id}, hasVoted: ${hasVoted}`); // Log para depurar
    socket.emit('sessionRestored', {
      playerId: player.id,
      gameId,
      role: player.isHost ? null : player.role,
      alive: player.alive,
      isHost: player.isHost,
      hasVoted, // Enviar estado correcto
      state: stateToSend,
    });
  
    io.to(games[gameId].host).emit('playerReconnected', { playerId: player.id, name: player.name, isHost: player.isHost });
    io.to(gameId).emit('updatePlayers', Object.values(games[gameId].players).map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
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
        role: p.isHost ? null : p.role
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
      socket.emit('error', { message: 'Se necesitan al menos 4 jugadores activos (excluyendo al anfitrión)', type: 'insufficientPlayers' }); // Añadir tipo
      return;
    }
    
    games[data.gameId].state = 'playing';
    games[data.gameId].day = 1;
    games[data.gameId].time = 'night';
    
    // Inicializar el estado previo al comenzar la partida
    games[data.gameId].previousPlayersState = Object.values(games[data.gameId].players)
    .filter(p => !p.isHost && !p.disconnected)
    .map(p => ({ id: p.id, name: p.name, alive: p.alive }));

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
        role: p.isHost ? null : p.role
      })),
    });
  });

  socket.on('cancelGame', ({ gameId }) => {
    if (!games[gameId] || games[gameId].host !== socket.id || games[gameId].state !== 'lobby') {
      socket.emit('error', { message: 'No tienes permisos para cancelar esta sala o la partida ya comenzó' });
      return;
    }
  
    // Desconectar a todos los jugadores
    const players = Object.values(games[gameId].players);
    players.forEach(player => {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        playerSocket.disconnect(true);
      }
    });
  
    // Notificar a todos y eliminar la partida
    io.to(gameId).emit('gameCancelled');
    delete games[gameId];
  });

  socket.on('updateHostSocket', ({ gameId, playerId }) => {
    console.log('Actualizando socket del host:', { gameId, playerId, newSocketId: socket.id });
    if (games[gameId] && games[gameId].players[playerId] && games[gameId].players[playerId].isHost) {
      games[gameId].host = socket.id;
      games[gameId].players[playerId].id = socket.id;
      console.log('Socket del host actualizado con éxito:', { gameId, hostId: socket.id });
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
      const player = games[gameId].players[playerId];
      const previousAlive = player.alive;
      player.alive = alive;
  
      console.log(`[Update] Jugador: ${player.name}, Anterior: ${previousAlive}, Nuevo: ${alive}`);
  
      io.to(gameId).emit('updateGameState', {
        state: games[gameId].state,
        day: games[gameId].day,
        time: games[gameId].time,
        players: Object.values(games[gameId].players).map(p => ({
          id: p.id,
          name: p.name,
          alive: p.alive,
          isHost: p.isHost,
          role: p.isHost ? null : p.role
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
    console.log('Solicitud de lista de jugadores recibida:', { gameId, socketId: socket.id });
    if (games[gameId] && games[gameId].host === socket.id) {
      const players = Object.values(games[gameId].players);
      console.log('Enviando jugadores al cliente:', players);
      const mappedPlayers = players.map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        isHost: p.isHost,
        role: p.isHost ? null : p.role,
        disconnected: p.disconnected
      }));
      if (games[gameId].state === 'lobby') {
        socket.emit('playersList', mappedPlayers); // Para "Expulsar" en el lobby
      } else {
        socket.emit('playersListForManage', mappedPlayers); // Para "Gestionar Jugadores"
        socket.emit('playersListForRoles', mappedPlayers);  // Para "Mostrar Roles"
      }
    } else {
      console.log('Permiso denegado para requestPlayers:', { gameId, socketId: socket.id });
    }
  });

  socket.on('dayVote', ({ gameId, targetId }) => {
    if (!games[gameId] || games[gameId].time !== 'day' || !games[gameId].players[targetId]) return;
    if (!games[gameId].players[socket.id] || !games[gameId].players[socket.id].alive || games[gameId].players[socket.id].isHost) return;
  
    if (games[gameId].votes[socket.id]) { // Usar socket.id consistentemente
      socket.emit('error', { message: 'Ya has votado en esta ronda. No puedes cambiar tu voto.' });
      return;
    }
  
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
        role: p.isHost ? null : p.role
      })),
    });
  });

  socket.on('advancePhase', (gameId) => {
    console.log('Solicitud de avanzar fase recibida:', { gameId, socketId: socket.id, hostId: games[gameId]?.host });
    if (!games[gameId] || games[gameId].host !== socket.id) {
      console.log('Permiso denegado para avanzar fase:', { gameId, socketId: socket.id });
      return;
    }
    const game = games[gameId];
  
    const previousPlayersState = game.previousPlayersState || Object.values(game.players)
      .filter(p => !p.isHost && !p.disconnected)
      .map(p => ({ id: p.id, name: p.name, alive: p.alive }));
  
      if (game.time === 'night') {
        game.time = 'day';
        const currentAlivePlayers = Object.values(game.players)
          .filter(p => !p.isHost && p.alive && !p.disconnected)
          .map(p => p.id);
        const deadPlayers = previousPlayersState
          .filter(player => player.alive && !currentAlivePlayers.includes(player.id))
          .map(player => player.name);
    
        let message = deadPlayers.length === 0
          ? 'Nadie ha muerto esta noche.'
          : `${deadPlayers.join(', ')} ${deadPlayers.length > 1 ? 'han muerto' : 'ha muerto'} esta noche.`;
        let type = deadPlayers.length === 0 ? 'success' : 'error';
    
        console.log('Emitiendo nightEnd:', { message, type }); // Log para depurar
        io.to(gameId).emit('nightEnd', { deadPlayers, message, type });
    
        game.previousPlayersState = Object.values(game.players)
          .filter(p => !p.isHost && !p.disconnected)
          .map(p => ({ id: p.id, name: p.name, alive: p.alive }));
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
    
        let message;
        let type;
        if (Object.keys(voteCounts).length === 0) {
          message = 'Nadie ha sido eliminado esta vez.';
          type = 'success';
        } else {
          const maxVotes = Math.max(...Object.values(voteCounts));
          const tiedPlayers = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes);
    
          if (tiedPlayers.length > 1) {
            message = 'Ha habido un empate de votos. Ningún jugador es eliminado.';
            type = 'warning';
          } else if (tiedPlayers.length === 1) {
            const selectedPlayer = tiedPlayers[0];
            game.players[selectedPlayer].alive = false;
            eliminatedPlayerName = game.players[selectedPlayer].name;
            message = `${eliminatedPlayerName} ha sido eliminado por votación.`;
            type = 'info';
          }
        }
    
        console.log('Emitiendo dayEnd:', { message, type }); // Log para depurar
        io.to(gameId).emit('dayEnd', { eliminatedPlayer: eliminatedPlayerName, message, type });
    
        game.votes = {};
        io.to(gameId).emit('resetVotes');
        game.previousPlayersState = Object.values(game.players)
          .filter(p => !p.isHost && !p.disconnected)
          .map(p => ({ id: p.id, name: p.name, alive: p.alive }));
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
          role: p.isHost ? null : p.role
        })),
      });
      checkGameEnd(gameId);
    });

    socket.on('disconnect', () => {
      const playerId = socket.playerId;
      const gameId = socket.gameId;
      if (playerId && gameId && games[gameId] && games[gameId].players[playerId]) {
        games[gameId].players[playerId].disconnected = true;
        // Enviar mensaje SOLO al host
        io.to(games[gameId].host).emit('playerDisconnected', {
          playerId,
          name: games[gameId].players[playerId].name,
          isHost: games[gameId].players[playerId].isHost
        });
        // Opcional: Actualizar estado del juego para todos
        io.to(gameId).emit('updateGameState', {
          state: games[gameId].state,
          day: games[gameId].day,
          time: games[gameId].time,
          players: Object.values(games[gameId].players).map(p => ({
            id: p.id,
            name: p.name,
            alive: p.alive,
            isHost: p.isHost,
            role: p.isHost ? null : p.role,
            disconnected: p.disconnected
          })),
        });
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

  socket.on('kickPlayer', ({ gameId, targetId }) => {
    if (!games[gameId] || games[gameId].host !== socket.id || games[gameId].state !== 'lobby') {
      socket.emit('error', { message: 'No tienes permisos para expulsar o la partida no está en la sala de espera' });
      return;
    }
  
    const targetPlayer = games[gameId].players[targetId];
    if (!targetPlayer || targetPlayer.isHost) {
      socket.emit('error', { message: 'Jugador no encontrado o no puede ser expulsado' });
      return;
    }
  
    // Enviar mensaje específico al jugador expulsado antes de desconectarlo
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
    targetSocket.emit('kickedFromGame', { message: 'Has sido expulsado de la sala' });
    targetSocket.disconnect(true); // Desconectar después de enviar el mensaje
    }

    // Marcar al jugador como desconectado y eliminarlo del juego
    targetPlayer.disconnected = true;
    delete games[gameId].players[targetId];
  
    // Desconectar el socket del jugador objetivo
    if (targetSocket) {
      targetSocket.disconnect(true); // Forzar desconexión
    }
  
    // Notificar a todos los jugadores
    io.to(gameId).emit('playerKicked', {
      name: targetPlayer.name,
      players: Object.values(games[gameId].players).map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        alive: p.alive,
        isHost: p.isHost,
        disconnected: p.disconnected,
      })),
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor en funcionamiento en http://localhost:${PORT}`);
});
