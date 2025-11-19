// App.tsx

import { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { WEBSOCKET_URL } from './config';
import './App.css';

interface Participant {
  id: string;
  name: string;
}

function App() {
  const [sessionCode, setSessionCode] = useState<string>('');
  const [participantName, setParticipantName] = useState<string>('');
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [, setParticipants] = useState<Participant[]>([]); // New state for participants
  const [, setPartnerName] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string>('Waiting for connection...');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const participantIdRef = useRef<string | null>(null);
  const partnerIdRef = useRef<string | null>(null); // Use a ref for the partner ID
  const initialConnectAttempted = useRef(false);

  useEffect(() => {
    // This effect runs once on component mount to establish a persistent client ID.
    // It checks localStorage for an ID, and if not found, creates and saves one.
    let clientId = localStorage.getItem('participantId');
    if (!clientId) {
      clientId = uuidv4();
      localStorage.setItem('participantId', clientId);
    }
    participantIdRef.current = clientId;
    setParticipantName(clientId.slice(0,7))
    setSessionCode("A");
    return () => {
      // Cleanup on component unmount
      if (wsRef.current) wsRef.current.close();
      if (pcRef.current) pcRef.current.close();
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []); // Empty dependency array ensures this runs only once on mount.

  useEffect(() => {
    // This effect triggers the initial session start once the session code and participant name are set.
    // It ensures that startSession() is called with the correct, updated state values.
    if (sessionCode && participantName && !isConnected && !isConnecting && !initialConnectAttempted.current) {
      initialConnectAttempted.current = true; // Prevent re-triggering on subsequent state changes
      startSession();
    }
  }, [sessionCode, participantName, isConnected, isConnecting]); // Dependencies ensure this runs when values are ready.

  useEffect(() => {
    // Effect to automatically clear the toast message after a few seconds
    if (toastMessage) {
      const timer = setTimeout(() => {
        setToastMessage(null);
      }, 2000); // Toast visible for 4 seconds

      return () => {
        clearTimeout(timer);
      };
    }
  }, [toastMessage]);

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
            payload: { sessionCode, participantName, participantId: participantIdRef.current }
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
              setStatusMessage(`Connected to ${newPartnerName}`);
              partnerIdRef.current = newPartnerId; // Set the ref value
              setPartnerName(newPartnerName);
              console.log(`Shuffling to new partner: ${newPartnerId} (${newPartnerName}). Polite: ${polite}`);
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
              const participantList: Participant[] = data.payload;
              setParticipants(participantList);
              console.log('Participants updated:', participantList);
              console.log('Current Partner Id:', partnerIdRef.current);
              // Check if our current partner has left the session.
              if (partnerIdRef.current && !participantList.some(p => p.id === partnerIdRef.current)) {
                console.log(`${partnerIdRef.current} has left.`);
                setStatusMessage(`Partner (${partnerIdRef.current}) has left, finding a new one...`);
                partnerIdRef.current = null;
                setPartnerName('');
                // Clear the remote video stream
                if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
              }
              break;
            default:
              console.log('Unhandled message type:', data.type);
          }
        };

        ws.onclose = () => {
          console.log('WebSocket disconnected');
          setIsConnected(false);
          setIsConnecting(false);
          partnerIdRef.current = null;
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
      {
        urls: "stun:stun.relay.metered.ca:80",
      },
      {
        urls: "turns:videoshuffle.thws.education:80?transport=tcp",
        username: "f97c9",
        credential: "WOgdya",
      },
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
        // Inspect the candidate to show a toast about the server type
        if (event.candidate.candidate.includes(' typ relay ')) {
          setToastMessage('Using TURN relay server for connection.');
        } else if (event.candidate.candidate.includes(' typ srflx ')) {
          setToastMessage('Using STUN server to find path.');
        }

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
    {toastMessage && (
      <div className="fixed top-5 right-5 bg-blue-600 text-white px-4 py-2 rounded-lg shadow-xl z-50">
        {toastMessage}
      </div>
    )}              
      <div className="fixed inset-0 bg-black">
        <video ref={remoteVideoRef} className="w-full h-full object-contain" autoPlay playsInline></video>
      </div>
      <div className="fixed top-5 left-5 text-sm md:text-base text-white bg-black bg-opacity-50 px-3 py-1 rounded-lg">
        {countdown !== null ? `Shuffling in ${countdown}...` : statusMessage}
      </div>
      {/* Local video preview, small in the corner */}
      <video ref={localVideoRef} className="fixed bottom-5 right-5 w-1/8 max-w-xs h-auto rounded-lg shadow-lg" autoPlay playsInline muted></video>
    </div>
  );
}

export default App;
