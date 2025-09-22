// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs'); // To read certificate files
const { v4: uuidv4 } = require('uuid');

const app = express();
const USE_HTTPS = process.env.USE_HTTPS;
const PORT = process.env.PORT || 3000; // Use port 443 for standard HTTPS

let server;

if (USE_HTTPS) {
  // --- HTTPS Configuration ---
  // Make sure to replace these paths with the actual location of your key and cert files.
  const privateKey = fs.readFileSync('certs/key.pem', 'utf8');
  const certificate = fs.readFileSync('certs/cert.pem', 'utf8');
  const credentials = { key: privateKey, cert: certificate };
  server = https.createServer(credentials, app); // Create the server with HTTPS credentials
} else {
  server = http.createServer(app); // Create a standard HTTP server
}

const wss = new WebSocket.Server({ server });

// In-memory data storage for active sessions
const sessions = {};

app.use((req, res, next) => {
    // Allow connections from the client's origin for WebSocket.
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; connect-src 'self' ws: wss:;"
    );
    next();
});

// Serve the React frontend (assuming it's built and in a 'public' folder)
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket connection handling
wss.on('connection', ws => {
    ws.id = uuidv4();
    console.log(`New participant connected with ID: ${ws.id}`);

    ws.on('message', message => {
        const data = JSON.parse(message);
        // ... (rest of your WebSocket message handling logic remains the same)
        switch (data.type) {
            case 'joinSession':
                const { sessionCode, participantName } = data.payload;
                if (!sessions[sessionCode]) {
                    sessions[sessionCode] = {
                        participants: {},
                        links: {},
                        timer: null
                    };
                }
                sessions[sessionCode].participants[ws.id] = { name: participantName, socket: ws };
                ws.sessionCode = sessionCode; // Store session code on the websocket connection
                console.log(`Participant ${participantName} joined session ${sessionCode}`);

                const participantList = Object.values(sessions[sessionCode].participants).map(p => p.name);
                broadcastToSession(sessionCode, { type: 'participantListUpdate', payload: participantList });

                if (Object.keys(sessions[sessionCode].participants).length >= 2) {
                    initiateShuffleCycle(sessionCode);
                }
                break;
            case 'webrtc-signal':
                const { to, signal } = data.payload;
                const recipient = sessions[ws.sessionCode]?.participants[to]?.socket;
                if (recipient) {
                    recipient.send(JSON.stringify({ type: 'webrtc-signal', payload: { from: ws.id, signal } }));
                }
                break;
        }
    });

    ws.on('close', () => {
        for (const sessionCode in sessions) {
            if (sessions[sessionCode].participants[ws.id]) {
                delete sessions[sessionCode].participants[ws.id];
                console.log(`Participant ${ws.id} left session ${sessionCode}`);

                if (Object.keys(sessions[sessionCode].participants).length === 0) {
                    clearInterval(sessions[sessionCode].timer);
                    delete sessions[sessionCode];
                    console.log(`Session ${sessionCode} closed.`);
                } else {
                    // Broadcast the updated participant list to the remaining members
                    const participantList = Object.values(sessions[sessionCode].participants).map(p => p.name);
                    broadcastToSession(sessionCode, { type: 'participantListUpdate', payload: participantList });
                    if (Object.keys(sessions[sessionCode].participants).length > 1) {
                        initiateShuffleCycle(sessionCode);
                    }
                }
                break;
            }
        }
    });
});

function broadcastToSession(sessionCode, message) {
    const session = sessions[sessionCode];
    if (session) {
        Object.values(session.participants).forEach(participant => {
            if (participant.socket.readyState === WebSocket.OPEN) {
                participant.socket.send(JSON.stringify(message));
            }
        });
    }
}

function performShuffle(sessionCode) {
    const session = sessions[sessionCode];
    if (!session) return;

    const participantIds = Object.keys(session.participants);
    for (let i = participantIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [participantIds[i], participantIds[j]] = [participantIds[j], participantIds[i]];
    }

    const newLinks = {};
    for (let i = 0; i < participantIds.length; i++) {
        const currentId = participantIds[i];
        const nextId = participantIds[(i + 1) % participantIds.length];
        newLinks[currentId] = nextId;
    }

    session.links = newLinks;

    Object.keys(newLinks).forEach(fromId => {
        const toId = newLinks[fromId];
        const fromSocket = session.participants[fromId].socket;
        const partnerName = session.participants[toId].name;
        // Simple way to decide who is "polite": the one with the lexicographically smaller ID.
        // This ensures one peer initiates and the other waits, avoiding "glare".
        const polite = fromId > toId;

        if (fromSocket.readyState === WebSocket.OPEN) {
            console.log(`Shuffling ${fromId} to ${toId}`);
            fromSocket.send(JSON.stringify({ type: 'shuffle', payload: { partnerId: toId, partnerName: partnerName, polite: polite } }));
        }
    });
}

function initiateShuffleCycle(sessionCode) {
    const session = sessions[sessionCode];
    if (!session) return;

    // Clear any existing timer to avoid multiple intervals running
    if (session.timer) {
        clearInterval(session.timer);
        session.timer = null;
    }

    // Perform the first shuffle immediately
    performShuffle(sessionCode);

    // If there are more than 2 participants, start the recurring shuffle timer
    if (Object.keys(session.participants).length > 2) {
        session.timer = setInterval(() => {
            broadcastToSession(sessionCode, { type: 'shuffle-countdown', payload: { duration: 10 } });
            setTimeout(() => performShuffle(sessionCode), 3000); // Shuffle after a 3s delay to show countdown
        }, 10000*60); // Cycle repeats every 10 minutes
    }
}

server.listen(PORT, () => console.log(`${USE_HTTPS ? 'HTTPS' : 'HTTP'} Server running on port ${PORT}`));