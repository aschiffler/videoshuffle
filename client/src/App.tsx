// App.tsx

import { useState, useEffect, useRef } from 'react';
import { WEBSOCKET_URL } from './config';
import './App.css';

function App() {
  const [sessionCode, setSessionCode] = useState<string>('');
  const [participantName, setParticipantName] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [_, setParticipants] = useState<string[]>([]); // New state for participants
  const [partnerName, setPartnerName] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string>('Waiting for connection...');
  const [countdown, setCountdown] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on component unmount
      if (wsRef.current) wsRef.current.close();
      if (pcRef.current) pcRef.current.close();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('Tab is visible again.');

        // Attempt to play videos in case they were paused by the browser
        remoteVideoRef.current?.play().catch(e => console.error("Error resuming remote video:", e));
        localVideoRef.current?.play().catch(e => console.error("Error resuming local video:", e));

        // If we were in a session but are now disconnected, try to reconnect.
        if (sessionCode && participantName && !isConnected && !isConnecting) {
          console.log('Connection lost, attempting to reconnect...');
          startSession();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isConnected, isConnecting, sessionCode, participantName]); // Rerun if these state variables change

  const startSession = async () => {
    if (!sessionCode || !participantName) {
      alert('Please enter a session code and your name.');
      return;
    }
    setIsConnecting(true);
    // 1. Get user media
    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then(stream => {
        // This block executes only after the stream is successfully acquired.
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        // 2. Connect to WebSocket *after* getting the stream
        const ws = new WebSocket(WEBSOCKET_URL);
        wsRef.current = ws;

        ws.onopen = () => {
          console.log('WebSocket connected');
          setIsConnected(true);
          ws.send(JSON.stringify({
            type: 'joinSession',
            payload: { sessionCode, participantName }
          }));
        };

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          setIsConnecting(false); // Reset connecting state on error
        };

        ws.onmessage = async (event: MessageEvent) => {
          const data = JSON.parse(event.data);
          switch (data.type) {
            case 'shuffle':
              const { partnerId: newPartnerId, partnerName: newPartnerName, polite } = data.payload;
              console.log(`Shuffling to new partner: ${newPartnerId} (${newPartnerName}). Polite: ${polite}`);
              setStatusMessage(`Connected to ${newPartnerName}!`);
              setPartnerId(newPartnerId);
              setPartnerName(newPartnerName);
              // The "impolite" peer (polite=false) will initiate the connection.
              await handleWebRTCConnection(newPartnerId, polite, stream); // Pass the stream directly
              break;
            case 'webrtc-signal':
              if (pcRef.current) {
                const signal = data.payload.signal;
                if (signal.sdp) {
                  await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                  if (signal.sdp.type === 'offer') {
                    const answer = await pcRef.current.createAnswer();
                    await pcRef.current.setLocalDescription(answer);
                    wsRef.current?.send(JSON.stringify({
                      type: 'webrtc-signal',
                      payload: { to: data.payload.from, signal: { sdp: answer } }
                    }));
                  }
                } else if (signal.candidate) {
                  await pcRef.current.addIceCandidate(new RTCIceCandidate(signal.candidate));
                }
              }
              break;
            case 'shuffle-countdown':
              let duration = data.payload.duration;
              setStatusMessage(`Shuffling in ${duration} seconds...`);
              setCountdown(duration);
              const countdownInterval = setInterval(() => {
                duration--;
                setCountdown(duration);
                if (duration <= 0) {
                  clearInterval(countdownInterval);
                  setCountdown(null);
                  setStatusMessage('Shuffling...');
                }
              }, 1000);
              break;
            case 'participantListUpdate':
              // When the participant list updates, it might be because our partner left.
              // We reset the partner state and wait for a new 'shuffle' message.
              if (partnerId) {
                setStatusMessage('Partner has left, finding a new one...');
                setPartnerId(null);
                setPartnerName('');
                if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
              }
              setParticipants(data.payload);
              console.log('Participants updated:', data.payload);
              break;
            default:
              console.log('Unhandled message type:', data.type);
          }
        };

        ws.onclose = () => {
          console.log('WebSocket disconnected');
          setIsConnected(false);
          setIsConnecting(false);
          setPartnerId(null);
          setPartnerName('');
          setCountdown(null);
          setStatusMessage('Waiting for connection...');
          if (pcRef.current) pcRef.current.close();
          if (localStreamRef.current) {
            localStreamRef.current.getTracks().forEach(track => track.stop());
            localStreamRef.current = null;
          }
        };
      })
      .catch(error => {
        setIsConnecting(false); // Reset on media stream error
        console.error('Error starting session:', error);
        alert('Could not access camera. Please check permissions and try again.');
      });
  };

  const leaveSession = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
  };

  const handleWebRTCConnection = async (newPartnerId: string, polite: boolean, stream: MediaStream) => {
    if (!stream) {
      console.error("Local stream is not available.");
      return;
    }

    // 1. Close existing connection and create a new one
    if (pcRef.current) {
      pcRef.current.close();
    }
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "turn:213.23.236.27:8080?transport=tcp", username: "a", credential: "a"}
      ]
    });
    pcRef.current = pc;

    // 2. Add local stream tracks to the peer connection
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });

    // 3. Handle incoming remote stream
    pc.ontrack = event => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    // 4. Handle ICE candidates
    pc.onicecandidate = event => {
      if (event.candidate && wsRef.current) {
        wsRef.current.send(JSON.stringify({
          type: 'webrtc-signal',
          payload: { to: newPartnerId, signal: { candidate: event.candidate } }
        }));
      }
    };

    // 5. Create and send offer only if we are the "impolite" peer.
    // The "polite" peer will wait for an offer to arrive.
    if (!polite) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (wsRef.current) {
        wsRef.current.send(JSON.stringify({
          type: 'webrtc-signal',
          payload: { to: newPartnerId, signal: { sdp: offer } }
        }));
      }
    }
  };

  return (
    <div className="App bg-gray-900 text-white min-h-screen flex flex-col">
      <header className="py-4">
        <h1 className="text-2xl text-orange-600 md:text-3xl font-bold text-center">UNINOVIS Video Shuffle</h1>
      </header>
      <main className="flex-grow flex items-center justify-center p-4">
        {!isConnected ? (
          <div className="lobby bg-gray-800 p-8 rounded-lg shadow-lg max-w-sm w-full flex flex-col gap-4">
            <input
              type="text"
              placeholder="Session Code"
              value={sessionCode}
              onChange={e => setSessionCode(e.target.value)}
              className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <input
              type="text"
              placeholder="Your Name"
              value={participantName}
              onChange={e => setParticipantName(e.target.value)}
              className="w-full p-3 bg-gray-700 rounded-md border border-gray-600 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <button
              onClick={startSession}
              disabled={isConnecting}
              className="w-full p-3 bg-orange-600 rounded-md text-white font-bold hover:bg-orange-700 transition-colors disabled:bg-gray-500 disabled:cursor-not-allowed"
            >
              {isConnecting ? 'Connecting...' : 'Start Session'}
            </button>
          </div>
        ) : (
          <div className="w-full max-w-5xl flex flex-col items-center gap-4">
            <div className="w-full flex justify-between items-center px-2">
              <div className="text-sm md:text-base text-gray-300">
                {countdown !== null ? `Shuffling in ${countdown}...` : statusMessage}
              </div>
              <button 
                className="px-4 py-2 bg-red-600 rounded-md text-white font-bold hover:bg-red-700 transition-colors" 
                onClick={leaveSession}
              >
                Leave
              </button>
            </div>
            <div className="relative w-full h-[65vh] bg-black rounded-lg shadow-lg overflow-hidden">
              <video ref={remoteVideoRef} className="w-full h-full object-contain" autoPlay playsInline></video>
              {partnerName && <div className="absolute top-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded-md">{partnerName}</div>}
            </div>
            <video ref={localVideoRef} className="w-48 h-auto rounded-lg shadow-lg self-center" autoPlay muted playsInline></video>
          </div>
        )}
      </main>
      <footer className="py-4 text-center text-xs text-gray-500">
        <p>&copy; {new Date().getFullYear()} plan.bee</p>
      </footer>
    </div>
  );
}

export default App;