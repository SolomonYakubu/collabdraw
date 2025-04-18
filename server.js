// Socket.IO server for CollabDraw
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

// Initialize Socket.IO with CORS configuration
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins in development
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Store active rooms and users
const activeRooms = new Map();
// Map to track which room a socket is in
const userRooms = new Map();
// Store the latest canvas state for each room
const roomCanvasStates = new Map();

// Socket.IO connection handler
io.on('connection', (socket) => {
  const { userId, userTag, roomId } = socket.handshake.query;
  console.log(`User connected: ${userTag} (${userId}) in room ${roomId}`);
  
  // Keep track of the room for this socket for later
  if (roomId) {
    userRooms.set(socket.id, roomId);
  }
  
  // Handle join room event
  socket.on('join-room', (data) => {
    const { roomId, userId, userTag } = data;
    
    // Join the Socket.IO room
    socket.join(roomId);
    
    // Add user to room data
    if (!activeRooms.has(roomId)) {
      activeRooms.set(roomId, new Map());
    }
    
    activeRooms.get(roomId).set(userId, {
      id: userId,
      tag: userTag,
      socketId: socket.id
    });
    
    // Broadcast updated user list to everyone in the room
    const users = Array.from(activeRooms.get(roomId).values()).map(u => ({
      id: u.id,
      tag: u.tag,
    }));
    io.to(roomId).emit('active-users', { users });
    
    console.log(`User ${userTag} joined room ${roomId}`);
    
    // Request canvas state from an existing user or send stored state
    if (roomCanvasStates.has(roomId)) {
      // Send the stored canvas state directly to the new user
      socket.emit('canvas-state-sync', {
        roomId,
        userId: 'server',
        shapes: roomCanvasStates.get(roomId)
      });
      console.log(`Sent stored canvas state to new user ${userTag} in room ${roomId}`);
    } else if (users.length > 1) {
      // Request canvas state from another user (first user besides the one who just joined)
      const otherUsers = users.filter(u => u.id !== userId);
      if (otherUsers.length > 0) {
        // Find a socket to request state from
        const roomSockets = Array.from(io.sockets.adapter.rooms.get(roomId) || []);
        const otherSocketIds = roomSockets.filter(id => id !== socket.id);
        
        if (otherSocketIds.length > 0) {
          // Request canvas state from first other socket
          io.to(otherSocketIds[0]).emit('request-canvas-state', {
            roomId,
            targetUserId: userId
          });
          console.log(`Requested canvas state for new user ${userTag} in room ${roomId}`);
        }
      }
    }
  });
  
  // Handle canvas state sync responses
  socket.on('canvas-state-response', (data) => {
    const { roomId, targetUserId, shapes } = data;
    
    // Store the canvas state for future users
    if (shapes && shapes.length > 0) {
      roomCanvasStates.set(roomId, shapes);
    }
    
    // Find the target user's socket
    const targetUser = Array.from(activeRooms.get(roomId)?.values() || [])
      .find(user => user.id === targetUserId);
    
    // Send canvas state directly to the target user if found
    if (targetUser && targetUser.socketId) {
      io.to(targetUser.socketId).emit('canvas-state-sync', {
        roomId,
        userId: data.userId,
        shapes
      });
      console.log(`Sent canvas state from ${data.userId} to ${targetUserId}`);
    }
  });
  
  // Handle cursor position updates
  socket.on('cursor-position', (data) => {
    const { roomId, userId, x, y, tag } = data;
    
    // Only broadcast cursor position if we have complete data
    if (roomId && userId !== undefined && x !== undefined && y !== undefined) {
      console.log(`User ${userId} cursor position update in room ${roomId}:`, { x, y });
      
      // Broadcast the cursor position to all other clients in the room
      socket.to(roomId).emit('cursor-position', {
        userId,
        x,
        y,
        tag
      });
    } else {
      console.warn('Invalid cursor position data:', data);
    }
  });
  
  // Handle in-progress shape updates
  socket.on('shape-in-progress', (data) => {
    const { roomId, userId, shape } = data;
    // Broadcast the in-progress shape to all other users in the room
    if (roomId && shape) {
      console.log(`Broadcasting in-progress shape from user ${userId} in room ${roomId}`);
      socket.to(roomId).emit('shape-in-progress', {
        userId,
        shape
      });
    }
  });
  
  // Handle drawing state updates (isDrawing flag)
  socket.on('drawing-state', (data) => {
    const { roomId } = data;
    socket.to(roomId).emit('drawing-state', data);
  });
  
  // Handle canvas updates (main drawing events)
  socket.on('canvas-update', (data) => {
    const { roomId, userId, shapes, deletedShapeIds } = data;
    
    // Update stored canvas state
    if (shapes && shapes.length > 0) {
      // For a full update, replace the entire state
      if (data.fullUpdate) {
        roomCanvasStates.set(roomId, shapes);
      } 
      // For partial updates (single shapes), merge with existing state
      else if (roomCanvasStates.has(roomId)) {
        const currentShapes = roomCanvasStates.get(roomId);
        
        // Process each incoming shape
        shapes.forEach(incomingShape => {
          // Find the shape in our current state and update it
          const existingShapeIndex = currentShapes.findIndex(s => s.id === incomingShape.id);
          
          if (existingShapeIndex >= 0) {
            // Update existing shape
            currentShapes[existingShapeIndex] = incomingShape;
          } else {
            // Add new shape if not found
            currentShapes.push(incomingShape);
          }
        });
        
        // Update the room's canvas state
        roomCanvasStates.set(roomId, currentShapes);
      } else {
        // If we don't have a state yet, create one
        roomCanvasStates.set(roomId, shapes);
      }
    }
    
    // Handle shape deletions
    if (deletedShapeIds && deletedShapeIds.length > 0 && roomCanvasStates.has(roomId)) {
      const currentShapes = roomCanvasStates.get(roomId);
      const updatedShapes = currentShapes.filter(shape => 
        !deletedShapeIds.includes(shape.id)
      );
      roomCanvasStates.set(roomId, updatedShapes);
    }
    
    // Forward the update to all other clients in the room
    socket.to(roomId).emit('canvas-update', data);
  });
  
  // Handle get active users request
  socket.on('get-active-users', (data, callback) => {
    const { roomId } = data;
    
    if (activeRooms.has(roomId)) {
      const users = Array.from(activeRooms.get(roomId).values()).map(u => ({
        id: u.id,
        tag: u.tag,
      }));
      callback({ users });
    } else {
      callback({ users: [] });
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    const roomId = userRooms.get(socket.id);
    
    if (roomId && activeRooms.has(roomId)) {
      const room = activeRooms.get(roomId);
      
      // Find and remove the user from the room
      for (const [userId, userData] of room.entries()) {
        if (userData.socketId === socket.id) {
          room.delete(userId);
          console.log(`User ${userData.tag} left room ${roomId}`);
          break;
        }
      }
      
      // If room is empty, remove it and its canvas state
      if (room.size === 0) {
        activeRooms.delete(roomId);
        roomCanvasStates.delete(roomId);
        console.log(`Room ${roomId} is now empty and removed`);
      } else {
        // Broadcast updated user list
        const users = Array.from(room.values()).map(u => ({
          id: u.id,
          tag: u.tag,
        }));
        io.to(roomId).emit('active-users', { users });
      }
    }
    
    // Clean up userRooms mapping
    userRooms.delete(socket.id);
  });
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('CollabDraw Socket.IO server is running');
});

// API route to get active rooms info
app.get('/stats', (req, res) => {
  const stats = {
    activeRooms: activeRooms.size,
    rooms: Array.from(activeRooms.entries()).map(([roomId, users]) => ({
      roomId,
      userCount: users.size,
      hasCanvasState: roomCanvasStates.has(roomId)
    })),
  };
  res.json(stats);
});

// Handle termination gracefully
process.on('SIGINT', () => {
  console.log('Shutting down CollabDraw Socket.IO server...');
  server.close(() => {
    console.log('Server has been closed');
    process.exit(0);
  });
});