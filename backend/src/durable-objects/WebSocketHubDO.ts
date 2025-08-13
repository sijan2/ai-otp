import { DurableObject } from "cloudflare:workers";
import { verifyWebSocketToken } from '../services/authService'; // Import the new function

export class WebSocketHub extends DurableObject<Env> { // Env should be from types.d.ts
  private sessions: Map<string, WebSocket> = new Map();
  private userId: string;
  protected env: Env;
  private explicitlyPassedUserId?: string; // To store userId from header

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.env = env;
    this.userId = state.id.name || 'default-user';
    // Keep minimal constructor log
    console.log(`[WebSocketHub CONSTRUCTOR] Initialized DO. state.id.name: '${state.id.name}', effective userId: '${this.userId}'`);
  }

  async fetch(request: Request): Promise<Response> {
    this.explicitlyPassedUserId = request.headers.get('X-User-Id') || undefined;
    // Remove header check logs
    // if (this.explicitlyPassedUserId) { ... } else { ... }

    const url = new URL(request.url);
    const path = url.pathname;

    // Handle WebSocket upgrade request
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    // Handle internal notification from Worker (triggered by Pub/Sub)
    if (path === "/internal/notify" && request.method === "POST") {
      const data = await request.json<{ type: string; payload?: any }>();
      return this.handleInternalNotification(data);
    }

    // Handle request for active connection count
    if (path === "/internal/get-connection-count" && request.method === "GET") {
      const activeConnections = this.ctx.getWebSockets().length;
      console.log(`[WebSocketHub:${this.userId}] Reporting active connections: ${activeConnections}`);
      return new Response(JSON.stringify({ activeConnections }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Log other paths for debugging
    console.log(`[WebSocketHub:${this.userId}] Received request for path: ${path}`);
    return new Response("Not found", { status: 404 });
  }

  private async handleWebSocketUpgrade(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get('token');

    // Determine the effective userId: Prefer explicitly passed header, then state.id.name
    const effectiveUserId = this.explicitlyPassedUserId || this.userId;

    console.log(`[WebSocketHub:${effectiveUserId}] Handling WebSocket upgrade attempt...`);

    // --- Token Validation Start ---
    if (!token) {
      console.error(`[WebSocketHub:${effectiveUserId}] Upgrade failed: Missing token.`);
      return new Response("Missing authentication token", { status: 401 });
    }

    if (!this.env.WEBSOCKET_JWT_SECRET) {
      console.error(`[WebSocketHub:${effectiveUserId}] CRITICAL: WEBSOCKET_JWT_SECRET is not set in environment.`,
        {
          stateId: this.ctx.id.toString(),
          stateName: this.ctx.id.name,
          explicitlyPassedUserId: this.explicitlyPassedUserId,
          derivedUserId: this.userId
        }
      );
      return new Response("Server configuration error for WebSocket authentication", { status: 500 });
    }

    try {
      // Verify the signed JWT
      // verifyWebSocketToken will also check if payload.sub matches effectiveUserId
      const tokenPayload = await verifyWebSocketToken(token, this.env.WEBSOCKET_JWT_SECRET, effectiveUserId);

      // Expiration is checked by verifyWebSocketToken
      // Subject (userId) match is checked by verifyWebSocketToken

      console.log(`[WebSocketHub:${effectiveUserId}] JWT validated successfully for user ${tokenPayload.sub}.`);

    } catch (e: any) {
      console.error(`[WebSocketHub:${effectiveUserId}] Upgrade failed: WebSocket token verification error: ${e.message}`);
      // Return a generic error to the client, but log the specific reason
      if (e.message && e.message.includes('Token subject (sub) does not match')) {
        return new Response("Token subject mismatch", { status: 403 }); // Forbidden
      }
      if (e.message && (e.message.includes('expired') || e.message.includes('expiration'))){
        return new Response("Token expired", { status: 401 });
      }
      return new Response("Invalid or expired token", { status: 401 });
    }
    // --- Token Validation End ---

    // Create a WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket connection using Hibernation API
    try {
      await this.ctx.acceptWebSocket(server);
      // Keep success log
      console.log(`[WebSocketHub:${effectiveUserId}] WebSocket accepted.`);
    } catch (error) {
      // Keep error log
      console.error(`[WebSocketHub:${effectiveUserId}] Error accepting WebSocket:`, error);
      return new Response('Error accepting WebSocket', { status: 500 });
    }

    // Store the connection (optional if only using getWebSockets)
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, server);

    // Remove connection state logs unless needed for debugging sessions specifically
    // console.log(`[WebSocketHub:${effectiveUserId}] New WebSocket connection established: sessionId=${sessionId}`);
    // this.logConnectionState();

    // Send welcome message
    server.send(JSON.stringify({
      type: "CONNECTED",
      sessionId,
      userId: effectiveUserId,
      message: "Successfully connected and authenticated"
    }));

    // Return the client end
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  // WebSocket message handler - called by the runtime when a message is received
  // This is part of the WebSocket Hibernation API
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      // Convert ArrayBuffer to string if needed
      const messageData = typeof message === 'string' ? message : new TextDecoder().decode(message);
      console.log(`[WebSocketHub:${this.userId}] Received message: ${messageData}`);

      const parsedMessage = JSON.parse(messageData);

      // Handle ping messages to keep the connection alive
      if (parsedMessage.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        console.log(`[WebSocketHub:${this.userId}] Sent pong response`);
        return;
      }

      // Handle debug/test request from extension
      if (parsedMessage.type === "test_connection") {
        console.log(`[WebSocketHub:${this.userId}] Received test connection request`);

        // Send a test historyId back to the client in the correct format
        const testResponse = {
          type: 'NEW_EMAIL',
          payload: {
            historyId: "9999999",
            emailAddress: `test-for-${this.userId}@example.com`
          }
        };

        console.log(`[WebSocketHub:${this.userId}] Sending test response: ${JSON.stringify(testResponse)}`);

        // Use setTimeout to ensure message is sent after connection is fully established
        setTimeout(() => {
          try {
            ws.send(JSON.stringify(testResponse));
            console.log(`[WebSocketHub:${this.userId}] Sent test historyId`);

            // Send another test message after a short delay to ensure it's received
            setTimeout(() => {
              try {
                ws.send(JSON.stringify({
                  type: 'NEW_EMAIL',
                  payload: {
                    historyId: "9999998",
                    emailAddress: "second-test@example.com"
                  }
                }));
                console.log(`[WebSocketHub:${this.userId}] Sent second test message`);
              } catch (error) {
                console.error(`[WebSocketHub:${this.userId}] Error sending second test message:`, error);
              }
            }, 1000);
          } catch (error) {
            console.error(`[WebSocketHub:${this.userId}] Error sending test message:`, error);
          }
        }, 500);

        return;
      }

      // Handle PING messages
      if (parsedMessage.type === "PING") {
        ws.send(JSON.stringify({ type: "PONG", timestamp: Date.now() }));
      }

    } catch (error) {
      console.error(`[WebSocketHub:${this.userId}] Error handling WebSocket message:`, error);
      ws.send(JSON.stringify({ type: "ERROR", error: "Invalid message format" }));
    }
  }

  // WebSocket close handler - called by the runtime when a connection is closed
  // This is part of the WebSocket Hibernation API
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Find the session ID for this WebSocket
    for (const [sessionId, socket] of this.sessions.entries()) {
      if (socket === ws) {
        console.log(`[WebSocketHub:${this.userId}] WebSocket session ${sessionId} closed: code=${code}, reason=${reason}, wasClean=${wasClean}`);
        this.sessions.delete(sessionId);
        break;
      }
    }

    // Log updated connection state
    console.log(`[WebSocketHub:${this.userId}] Connection closed, remaining connections: ${this.sessions.size}`);
  }

  // WebSocket error handler - called by the runtime when a connection has an error
  // This is part of the WebSocket Hibernation API
  async webSocketError(ws: WebSocket, error: Error): Promise<void> {
    console.error(`[WebSocketHub:${this.userId}] WebSocket error:`, error);

    // Find the session ID for this WebSocket and remove it
    for (const [sessionId, socket] of this.sessions.entries()) {
      if (socket === ws) {
        console.log(`[WebSocketHub:${this.userId}] Removing errored WebSocket session ${sessionId}`);
        this.sessions.delete(sessionId);
        break;
      }
    }
  }

  private async handleInternalNotification(data: { type: string; payload?: any }): Promise<Response> {
    // Simplify log
    console.log(`[WebSocketHub:${this.userId}] Received internal notification. Type: ${data.type || 'N/A'}`);

    // Remove logConnectionState call
    // this.logConnectionState();

    // Since this is a user-specific DO, we send the notification to all connections for this user
    const allSockets = this.ctx.getWebSockets();
    if (allSockets.length === 0) {
      console.log(`[WebSocketHub:${this.userId}] No active connections for this user`);
      return new Response("No active connections", { status: 200 });
    }

    // Ensure the message has the proper format for the Chrome extension
    if (!data.type) {
      data.type = "NEW_EMAIL";
    }

    // Send the notification to all sessions for this user
    const message = JSON.stringify(data);
    console.log(`[WebSocketHub:${this.userId}] Sending internal notification (Type: ${data.type}) to ${allSockets.length} clients.`);

    let successCount = 0;
    for (const ws of allSockets) {
      try {
        ws.send(message);
        successCount++;
      } catch (error) {
        console.error(`[WebSocketHub:${this.userId}] Error sending message:`, error);
      }
    }

    return new Response(`Notification sent to ${successCount}/${allSockets.length} clients`, { status: 200 });
  }
}
