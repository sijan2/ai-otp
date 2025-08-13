import { config } from "./lib/config"
import { oauthManager } from "./lib/oauth"

interface Message {
  action: string
  data: any
  timestamp: number
  retryCount?: number
}

let socket: WebSocket | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAY = 5000
const KEEP_ALIVE_INTERVAL = 30000
let authFailedTimestamp = 0
const AUTH_RETRY_COOLDOWN = 60000 // 1 minute cooldown between auth attempts
let manualAuthRequested = false // Flag to track if auth was manually requested
let intentionalDisconnect = false // New flag
let isConnectWebSocketAttemptInProgress = false; // New flag to track connection attempts

let messageQueue: Message[] = []
const contentScriptReadyTabs = new Set<number>()
const MAX_RETRY_COUNT = 5

// User ID and WebSocket token
let userId: string | null = null
let wsToken: string | null = null

// Track when the last check was performed to detect sleep/wake cycles
let lastCheckTime = Date.now();

// Periodically check WebSocket connection (keep)
setInterval(async () => {
  // Check for sleep/wake cycle by comparing timestamps
  const currentTime = Date.now();
  const timeSinceLastCheck = currentTime - lastCheckTime;
  const probableSleepWakeCycle = timeSinceLastCheck > 120000; // If more than 2 minutes passed, system likely slept
  
  if (probableSleepWakeCycle) {
    console.log(`[Background] Detected possible sleep/wake cycle (${Math.round(timeSinceLastCheck/1000)}s gap). Reconnecting WebSocket...`);
    // Force reconnection of WebSocket after sleep
    if (socket) {
      if (socket.readyState === WebSocket.OPEN) {
        console.log("[Background] Closing open WebSocket after sleep/wake detection");
        intentionalDisconnect = true;
        socket.close(1000, "Reconnecting after sleep/wake cycle");
      } else if (socket.readyState === WebSocket.CONNECTING) {
        console.log("[Background] WebSocket is in CONNECTING state after sleep/wake. Will let it continue.");
      } else if (socket.readyState === WebSocket.CLOSING) {
        console.log("[Background] WebSocket is in CLOSING state after sleep/wake. Will wait for close event.");
      } else { // CLOSED state
        console.log("[Background] WebSocket is in CLOSED state after sleep/wake. Will reconnect.");
        setTimeout(connectWebSocket, 500); // Small delay to allow for cleanup
      }
    } else {
      console.log("[Background] No WebSocket exists after sleep/wake. Creating a new connection.");
      setTimeout(connectWebSocket, 500); // Small delay to allow for cleanup
    }
  }
  
  // Update the last check time
  lastCheckTime = currentTime;
  try {
    const tokenResponse = await oauthManager.getTokenResponse(); 

    if (!tokenResponse || !tokenResponse.id_token) {
      console.log("Periodic check: No local token response. User is logged out. Waiting for manual login.");
      if (socket && socket.readyState === WebSocket.OPEN) { 
          console.warn("Periodic check: Closing WebSocket as user is logged out.");
          intentionalDisconnect = true;
          socket.close(1001, "User logged out, periodic check.");
          // socket = null; // onclose will handle
      }
      return; 
    }

    const isAuthenticated = await oauthManager.isAuthenticated(); 

    if (!isAuthenticated) {
      console.log("Periodic check: User not authenticated or id_token expired/nearing expiry. Attempting to refresh id_token...");
      try {
        console.log("[PeriodicCheck] Attempting to refresh id_token via oauthManager.getIdToken().");
        const newIdToken = await oauthManager.getIdToken(); 
        if (newIdToken) {
          console.log("Periodic check: id_token refreshed successfully. Clearing old wsToken to fetch a new one.");
          
          // Verify token validity by checking decoded expiry
          try {
            const tokenParts = newIdToken.split('.');
            if (tokenParts.length === 3) {
              const payload = JSON.parse(atob(tokenParts[1]));
              const expiry = payload.exp * 1000; // Convert to milliseconds
              const now = Date.now();
              console.log(`Token expiry check: Token expires in ${Math.round((expiry - now)/1000)}s`);
            }
          } catch (e) {
            console.warn("Could not decode token for debug purposes", e);
          }
          userId = null; // Force new wsToken fetch
          wsToken = null; // Force new wsToken fetch
          if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
            console.log("Periodic check: Closing existing WebSocket to reconnect with new token.");
            intentionalDisconnect = true; 
            socket.close(1000, "Reconnecting after id_token refresh");
            // socket = null; // onclose will handle
          }
          console.log("Periodic check: Ensuring WebSocket is connected with new token.");
          connectWebSocket(); 
        } else {
          console.warn("[PeriodicCheck] oauthManager.getIdToken() did not yield a new token. Auth may be lost or refresh failed silently within manager.");
          console.warn("Periodic check: id_token refresh attempt did not yield a new token. Auth may be lost.");
          if (socket && socket.readyState === WebSocket.OPEN) {
             console.warn("Periodic check: Closing WebSocket as authentication refresh failed.");
             intentionalDisconnect = true;
             socket.close(1000, "Authentication token expired and refresh failed");
             // socket = null; // onclose will handle
          }
        }
      } catch (refreshError: any) {
        console.error("Periodic check: Error during id_token refresh:", refreshError.message);
        console.error("[PeriodicCheck] Error during oauthManager.getIdToken() call:", refreshError);
        if (socket && socket.readyState === WebSocket.OPEN) {
            console.warn("Periodic check: Closing WebSocket due to error in authentication refresh.");
            intentionalDisconnect = true;
            socket.close(1000, "Authentication token refresh error");
            // socket = null; // onclose will handle
        }
      }
    } else {
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
        console.warn("Periodic check: WebSocket disconnected (while id_token is valid), attempting to reconnect...");
        connectWebSocket(); 
      }
    }
  } catch (authErr: any) { 
    console.error("Error in periodic WS check (outer try-catch):", authErr.message);
  }
}, 60000); // Keep interval

function authenticateWithGoogle(forceAuth: boolean = false): void {
  const now = Date.now();
  if (!forceAuth && authFailedTimestamp > 0 && (now - authFailedTimestamp) < AUTH_RETRY_COOLDOWN) {
    console.log("[AuthGoogle] Cooldown active, skipping manual auth attempt.");
    return;
  }
  if (forceAuth) {
    console.log("[AuthGoogle] Manual authentication requested (forceAuth=true).");
    manualAuthRequested = true;
  } else {
    console.log("[AuthGoogle] Authentication attempt (forceAuth=false).");
  }

  oauthManager.getIdToken() // interactiveLoginPermitted defaults to true
    .then(token => {
        if (token) {
            console.log("[AuthGoogle] ID token obtained successfully after auth flow. Token (first 10 chars):", token.substring(0,10));
            console.log("[AuthGoogle] Attempting WebSocket connection immediately.");
            connectWebSocket(); 
        } else {
            console.warn("[AuthGoogle] ID token *not* available after auth flow (token is null). WebSocket connection deferred. This might happen if user cancelled login.");
        }
    })
    .catch(error => {
      console.error("[AuthGoogle] Failed to authenticate with Google. Error:", error.message, error);
    });
}

function connectWebSocket(): void {
  // First check if there's a connection attempt in progress
  if (isConnectWebSocketAttemptInProgress) {
    console.log("[ConnectWS] Connection attempt already in progress, skipping redundant call");
    return;
  }
  
  // Set flag to prevent parallel connection attempts
  isConnectWebSocketAttemptInProgress = true;
  console.log("[ConnectWS] Attempting connection. wsToken exists: ", !!wsToken, " userId exists: ", !!userId, "isConnectWebSocketAttemptInProgress:", isConnectWebSocketAttemptInProgress);

  // Check if socket is already established before trying to connect
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) {
      console.log("[ConnectWS] WebSocket is already OPEN. No need to reconnect.");
      isConnectWebSocketAttemptInProgress = false;
      return;
    } else if (socket.readyState === WebSocket.CONNECTING) {
      console.log("[ConnectWS] WebSocket is already CONNECTING. Waiting for that connection to complete.");
      isConnectWebSocketAttemptInProgress = false;
      return;
    } else if (socket.readyState === WebSocket.CLOSING) {
      // If socket is closing, wait for it to fully close before attempting to reconnect
      console.log("[ConnectWS] WebSocket is currently CLOSING. Will wait until fully closed before reconnecting.");
      // Setup a one-time event listener that will trigger connect once the socket is fully closed
      socket.addEventListener('close', function reconnectAfterClose() {
        // Remove this listener to ensure it only runs once
        socket?.removeEventListener('close', reconnectAfterClose);
        console.log("[ConnectWS] Previous WebSocket now fully closed. Attempting to connect.");
        // Reset this flag since we're exiting the current function
        isConnectWebSocketAttemptInProgress = false;
        // Call connectWebSocket again now that socket is fully closed
        setTimeout(connectWebSocket, 100);
      }, { once: true });
      return;
    }
    // If we get here, the socket is CLOSED, so we can proceed to reconnect
  }
  console.log("[ConnectWS] Attempting to connect WebSocket. Current socket state: " + (socket ? getWebSocketStateString(socket.readyState) : 'null') + ". Existing wsToken: " + (wsToken ? 'yes' : 'no'));
  isConnectWebSocketAttemptInProgress = true;

  oauthManager.getTokenResponse().then(googleTokenResponse => {
    if (!googleTokenResponse?.id_token) {
      console.warn("[ConnectWS] Pre-flight check: Google ID token NOT available from oauthManager. Aborting connection attempt.");
      isConnectWebSocketAttemptInProgress = false;
      return; 
    }
    const googleIdToken = googleTokenResponse.id_token;

    if (userId && wsToken) {
      console.log(`[ConnectWS] Attempting to reuse existing userId (${userId ? userId.substring(0,5) : 'null'}) and wsToken.`);
      const wsUrl = `${config.WEBSOCKET_URL}/${userId}?token=${encodeURIComponent(wsToken)}`;
      establishWebSocketConnection(wsUrl, true); // true indicates token reuse
    } else {
      console.log("[ConnectWS] No existing wsToken or userId, or they were cleared. Fetching new WebSocket token from backend.");
      console.log("[ConnectWS] Fetching wsToken using Google ID token (first 10 chars):", googleIdToken ? googleIdToken.substring(0,10) : "null");
      fetch(`${config.BACKEND_URL}/auth/ws-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ idToken: googleIdToken })
      })
      .then(response => {
        console.log("[ConnectWS] Response received from /auth/ws-token. Status:", response.status);
        if (!response.ok) {
          return response.text().then(text => {
            throw new Error(`Failed to get WebSocket token: ${response.status} ${response.statusText}. Body: ${text.substring(0, 200)}`);
          }).catch(() => { 
            throw new Error(`Failed to get WebSocket token: ${response.status} ${response.statusText}. Could not read error body.`);
          });
        }
        return response.json();
      })
      .then(wsTokenData => { 
        console.log("[ConnectWS] WebSocket token data received from backend:", wsTokenData ? {userId: wsTokenData.userId, tokenExists: !!wsTokenData.token} : 'null/undefined');
        if (!wsTokenData || !wsTokenData.token || !wsTokenData.userId) {
            console.error("[ConnectWS] Invalid or incomplete response from /auth/ws-token. Data:", wsTokenData);
            isConnectWebSocketAttemptInProgress = false; 
            throw new Error("Invalid response from /auth/ws-token. Token or userId missing.");
        }
        userId = wsTokenData.userId;
        wsToken = wsTokenData.token;

        if (typeof wsToken !== 'string') {
            console.error("[ConnectWS] WebSocket token is not a string after validation:", typeof wsToken);
            isConnectWebSocketAttemptInProgress = false;
            throw new Error("WebSocket token is invalid after fetch (not a string).");
        }
        console.log("[ConnectWS] New UserID and wsToken acquired. Establishing WebSocket connection.");
        const wsUrl = `${config.WEBSOCKET_URL}/${userId}?token=${encodeURIComponent(wsToken!)}`;
        establishWebSocketConnection(wsUrl, false); // false indicates not reusing (new) token
      })
      .catch(error => {
        console.error("[ConnectWS] Error during WebSocket token fetch or processing:", error.message);
        console.error("[ConnectWS] Error details during WebSocket token fetch:", error);
        userId = null; 
        wsToken = null;
        isConnectWebSocketAttemptInProgress = false;
        if (error.message && error.message.includes("Failed to get WebSocket token: 401")) {
          console.warn("[ConnectWS] Received 401 fetching wsToken. ID token is likely invalid. Forcing full refresh.");
          oauthManager.forceRefreshAndConnect();
        } else {
          handleReconnection();
        }
      });
    }
  }).catch(error => {
      console.error("[ConnectWS] Critical error getting Google ID token for WS connection (outer getTokenResponse catch):", error.message, error);
      isConnectWebSocketAttemptInProgress = false;
      // If we can't get Google ID, reconnection is unlikely to succeed without re-auth.
  });
}

function establishWebSocketConnection(wsUrl: string, isReusingToken: boolean): void {
  // If existing socket is in CLOSING state, we should wait for it to fully close
  if (socket && socket.readyState === WebSocket.CLOSING) {
    console.log("[EstablishWS] Cannot establish new connection while previous socket is still closing");
    // Set up a listener to try again after close completes
    socket.addEventListener('close', () => {
      console.log("[EstablishWS] Previous socket now closed, can establish new connection");
      establishWebSocketConnection(wsUrl, isReusingToken);
    }, { once: true });
    return;
  }

  // If we already have an active socket, close it first
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.log("[EstablishWS] Closing existing socket before establishing a new one");
    intentionalDisconnect = true;
    socket.close(1000, "Replacing with new connection");
    // Set up a listener to create the new socket after the old one closes
    socket.addEventListener('close', () => {
      console.log("[EstablishWS] Previous socket closed, now creating new connection");
      establishWebSocketConnection(wsUrl, isReusingToken);
    }, { once: true });
    return;
  }
  
  // Create a new WebSocket instance
  socket = new WebSocket(wsUrl);

  // Connection opened
  socket.onopen = (): void => {
    console.log(`WebSocket connected successfully ${isReusingToken ? '(reused token)' : '(new token)'}`);
    reconnectAttempts = 0;
    isConnectWebSocketAttemptInProgress = false; 
    startWebSocketPing();
  };

  socket.onmessage = async (event: MessageEvent): Promise<void> => {
    try {
      const serverMessage = JSON.parse(event.data);

      if (serverMessage.type === "OTP_RESULT" && serverMessage.payload) {
          const { code, url } = serverMessage.payload;
          if (url && !code) {
              console.log(`[WebSocket] Auto-opening received URL: ${url.substring(0, 50)}...`);
              openUrlInNewTab(url);
              return; 
          }
          queueMessage({ action: "otpResultReceived", data: { code: code || null, url: url || null, messageId: serverMessage.payload.messageId || null }, timestamp: Date.now() });

      } else if (serverMessage.type === "pong" || serverMessage.type === "PONG") {
          // console.log("[WebSocket] Received pong:", serverMessage); // Keep commented or enable for debug
      } else if (serverMessage.type === "CONNECTED") {
           // console.log("[WebSocket] Connection confirmed by server:", serverMessage.message); // Keep commented
      } else {
          console.warn("[WebSocket] Received unknown message type:", serverMessage.type, serverMessage.payload); // Log payload too for context
      }

    } catch (error) { console.error("[WebSocket] Error handling message:", error); }
  };

  socket.onerror = (error: Event): void => {
    console.error("WebSocket error:", error);
    // isConnectWebSocketAttemptInProgress will be reset in onclose, which usually follows onerror
  };

  socket.onclose = (event: CloseEvent): void => {
    console.log(`[EstablishWS] WebSocket onclose event. Code: ${event.code}, Reason: '${event.reason}', Was intentional: ${intentionalDisconnect}, Was reusing token: ${isReusingToken}`);
    const reason = event.reason || 'No reason provided'
    console.warn(`WebSocket disconnected. Code: ${event.code}, Reason: ${reason.substring(0,100)}`);
    socket = null; 
    isConnectWebSocketAttemptInProgress = false; // Connection attempt is over

    // Ensure ping timer is cleared to avoid leaks and duplicate reconnects
    if (pingIntervalId) {
      clearInterval(pingIntervalId);
      pingIntervalId = null;
      console.log("[EstablishWS] Cleared ping interval on socket close.");
    }
    
    if (intentionalDisconnect) {
      console.log("WebSocket closed intentionally (e.g., due to logout). No reconnection attempt.");
      intentionalDisconnect = false; 
    } else {
      // If we were reusing a token and the connection closed unexpectedly,
      // the token might be invalid. Clear it to force a new fetch on next attempt.
      // Specific close codes (e.g., 1008, 4000-4999) could make this more precise.
      if (isReusingToken && (event.code === 1008 || (event.code >= 4000 && event.code <= 4999) || event.code === 1002 || event.code === 1003 || event.code === 1006 || event.code === 1011)) {
          console.log(`[ConnectWS] WebSocket closed (code ${event.code}) after reusing token. Clearing token for next attempt.`);
          userId = null;
          wsToken = null;
      }
      handleReconnection(); 
    }
  };
}

function handleReconnection(): void {
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    const delay = RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
    reconnectAttempts++;
    console.warn(`Reconnecting WebSocket in ${delay / 1000} seconds... (Attempt ${reconnectAttempts})`);
    setTimeout(connectWebSocket, delay);
  } else { console.error("Max WebSocket reconnection attempts reached."); }
}

function queueMessage(message: Message): void {
  message.timestamp = Date.now()
  messageQueue.push(message)
  processMessageQueue()
}

function processMessageQueue(): void {
  if (contentScriptReadyTabs.size === 0) {
    console.log("No content scripts are ready. Notifying user.")
    while (messageQueue.length > 0) {
      const message = messageQueue.shift()
      if (message) {
        handleMessageWithoutContentScript(message)
      }
    }
    return
  }

  while (messageQueue.length > 0) {
    const message = messageQueue.shift()
    if (message) {
      sendMessageToContentScript(message)
    }
  }
}

function handleMessageWithoutContentScript(message: Message): void {
  if (message.action === "otpResultReceived" && message.data) {
    const { code, url } = message.data;
    
    let notificationTitle = "Verification Info Received";
    let notificationMessage = "";
    let notificationUrlToOpen: string | null = null;

    if (url) {
        notificationTitle = "Verification Link Received";
        notificationMessage = `Click to open the verification link.`;
        try {
            const cleanUrl = new URL(url).toString();
            notificationUrlToOpen = cleanUrl;
            notificationMessage += `\nURL: ${cleanUrl.substring(0, 50)}...`;
        } catch (e) {
            console.error("Received invalid URL in otpResultReceived:", url, e);
            notificationMessage = "Received an invalid URL.";
        }
    } else if (code) {
        notificationTitle = "OTP Code Received";
        notificationMessage = `Code: ${code}`;
    } else {
        notificationTitle = "Notification Received";
        notificationMessage = "Received a notification from the server.";
        console.log("[Notification] Received OTP_RESULT with no code or URL.", message.data);
    }
    
    showChromeNotification(
      notificationTitle,
      notificationMessage,
      notificationUrlToOpen 
        ? () => { 
            console.log("Notification clicked, opening URL:", notificationUrlToOpen);
            openUrlInNewTab(notificationUrlToOpen!);
          } 
        : undefined
    );
  } else {
      console.warn("Handling unknown message action without content script:", message.action);
      showChromeNotification("Quick OTP Notification", `Received an update: ${JSON.stringify(message.data).substring(0, 100)}`);
  }
}

function sendMessageToContentScript(message: Message): void {
  if (contentScriptReadyTabs.size === 0) {
    console.log("No content script tabs available, handling message without content script")
    handleMessageWithoutContentScript(message)
    return
  }
  
  let deliveredToAnyTab = false
  
  const tabsToProcess = Array.from(contentScriptReadyTabs)
  
  tabsToProcess.forEach((tabId) => {
    try {
      chrome.tabs.sendMessage(
        tabId, 
        message, 
        (response) => {
          if (chrome.runtime.lastError) {
            console.error(
              `Error sending message to tab ${tabId}:`,
              chrome.runtime.lastError.message
            )
            contentScriptReadyTabs.delete(tabId)
            
            if (contentScriptReadyTabs.size === 0 && !deliveredToAnyTab) {
              message.retryCount = (message.retryCount || 0) + 1
              if (message.retryCount < MAX_RETRY_COUNT) {
                messageQueue.unshift(message)
                setTimeout(processMessageQueue, 1000)
              } else {
                console.error("Max retry attempts reached for message:", message)
                handleMessageWithoutContentScript(message)
              }
            }
          } else {
            deliveredToAnyTab = true
          }
        }
      )
    } catch (error) {
      console.error(`Error sending message to tab ${tabId}:`, error)
      contentScriptReadyTabs.delete(tabId)
    }
  })
}

function showChromeNotification(
  title: string,
  message: string,
  callback?: () => void
): void {
  const notificationId = "verification_" + Date.now()
  chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: "/icons/icon48.png",
    title: title,
    message: message,
    priority: 2,
    requireInteraction: true,
  })

  if (callback) {
    chrome.notifications.onClicked.addListener(function listener(clickedId) {
      if (clickedId === notificationId) {
        callback()
        chrome.notifications.onClicked.removeListener(listener)
      }
    })
  }
}

function openUrlInNewTab(url: string): void {
  if (!url) { console.error("Attempted to open null/empty URL"); return; }
  console.log("Opening URL in new tab (first 50 chars):", url.substring(0,50));
  
  try {
    chrome.tabs.create({ 
      url: url,
      active: true
    }, (tab) => {
      if (chrome.runtime.lastError) {
        console.error("Tab creation error:", chrome.runtime.lastError.message);
        
        tryFallbackUrlOpening(url);
      } else if (tab) {
        console.log("Successfully opened URL in tab:", tab.id);
      }
    });
  } catch (error) {
    console.error("Exception when creating tab:", error);
    tryFallbackUrlOpening(url);
  }
}

function tryFallbackUrlOpening(url: string): void {
  console.log("Using fallback URL opening methods for:", url);
  
  try {
    const cleanURL = new URL(url);
    const urlString = cleanURL.toString();
    console.log("Cleaned URL for fallback attempt:", urlString);
    
    chrome.tabs.create({ url: urlString }, (tab) => {
      if (chrome.runtime.lastError) {
        console.error("First fallback failed:", chrome.runtime.lastError.message);
        secondFallback(url);
      }
    });
  } catch (error) {
    console.error("URL cleaning failed:", error);
    secondFallback(url);
  }
}

function secondFallback(url: string): void {
  console.log("Attempting window creation as second fallback");
  
  try {
    chrome.windows.create({ 
      url: url,
      type: 'normal',
      focused: true
    }, (window) => {
      if (chrome.runtime.lastError) {
        console.error("Window creation failed:", chrome.runtime.lastError.message);
        
        finalFallback(url);
      }
    });
  } catch (error) {
    console.error("Window creation exception:", error);
    finalFallback(url);
  }
}

function finalFallback(url: string): void {
  console.log("Final fallback: Attempting to open in current window via chrome.tabs.query");
  
  chrome.tabs.query({active: true, lastFocusedWindow: true}, (tabs) => {
    if (chrome.runtime.lastError) {
      console.error("Final fallback failed:", chrome.runtime.lastError.message);
      return;
    }
    
    if (tabs && tabs[0] && tabs[0].id) {
      console.log("Opening URL in current tab as last resort");
      
      chrome.tabs.create({
        url: url,
        active: true,
        index: tabs[0].index + 1
      });
    }
  });
}

function keepAlive(): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "ping" }))
  }
}

let pingIntervalId: ReturnType<typeof setInterval> | null = null;

function startWebSocketPing(): void {
  pingIntervalId = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: "ping", timestamp: Date.now() })); }
      catch (error) { console.error("Error sending ping:", error); }
    } else {
      if (!socket || socket.readyState === WebSocket.CLOSED) { connectWebSocket(); }
    }
  }, KEEP_ALIVE_INTERVAL);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "contentScriptReady") {
    if (sender.tab?.id != null) {
      contentScriptReadyTabs.add(sender.tab.id);
      processMessageQueue();
      sendResponse({ status: "Background acknowledged readiness" });
    } else {
        sendResponse({ status: "Background received readiness, but no tab ID?" });
    }
    return true;
  } else if (message.action === "authSucceededInPopup") {
    console.log("[Background] Received 'authSucceededInPopup' message. Connecting WebSocket immediately.");
    userId = null; // Force new wsToken fetch after fresh auth
    wsToken = null; // Force new wsToken fetch after fresh auth
    oauthManager.getTokenResponse().then(tokenResponse => {
      if (tokenResponse?.id_token) {
        console.log("[Background] Token found after popup auth. Connecting WebSocket...");
        connectWebSocket();
        sendResponse({ success: true, message: "WebSocket connection initiated" });
      } else {
        console.warn("[Background] Popup reported successful auth but no token found in background context.");
        sendResponse({ success: false, message: "No token found" });
      }
    }).catch(error => {
      console.error("[Background] Error getting token after popup auth:", error);
      sendResponse({ success: false, error: error.message });
    });
    
    return true; // Keep the sendResponse channel open for the async response
  } else if (message.action === "loginManually") {
    console.log("[Background] Received 'loginManually' message. Initiating manual authentication."); // New log
    authenticateWithGoogle(true);
    sendResponse({ success: true, message: "Login process started" });
    return true;
  } else if (message.action === "getAuthStatus") {
    oauthManager.isAuthenticated().then(isAuthenticated => {
        if (isAuthenticated) {
             oauthManager.getTokenResponse().then(tokenResponse => {
                const email = tokenResponse?.email || "Unknown";
                const userId = tokenResponse?.userId || "Unknown"; // Optionally return userId too
                sendResponse({ isAuthenticated: true, email: email, userId: userId });
            }).catch(err => { // Add catch for getTokenResponse promise
                console.error("Error getting token response for auth status:", err);
                sendResponse({ isAuthenticated: true, email: "Error retrieving email", userId: "Error retrieving userId" });
            });
        } else {
            sendResponse({ isAuthenticated: false, lastFailedTimestamp: authFailedTimestamp });
        }
    }).catch(error => {
        console.error("Error checking auth status:", error);
        sendResponse({ isAuthenticated: false, error: error.message });
    });
    return true;
  } else if (message.action === "explicitWsClose") {
    console.log("[Background] Explicit WebSocket close requested due to logout.");

    // Always try to clear the ping interval, regardless of socket state.
    // This ensures any active ping interval is stopped during logout.
    if (pingIntervalId) {
      clearInterval(pingIntervalId);
      pingIntervalId = null;
      console.log("[Background] Cleared ping interval due to explicit close request.");
    }

    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      console.log("[Background] Closing active WebSocket connection intentionally.");
      intentionalDisconnect = true; // Set flag BEFORE closing
      socket.close(1000, "User logged out"); 
      socket = null; 
      // pingIntervalId is already cleared above
      sendResponse({ status: "WebSocket close initiated" });
    } else {
      console.log("[Background] No active WebSocket to close or already closing/closed.");
      sendResponse({ status: "No active WebSocket to close" });
    }
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (contentScriptReadyTabs.has(tabId)) {
    contentScriptReadyTabs.delete(tabId)
  }
})

function getWebSocketStateString(state: number): string {
  switch (state) {
    case WebSocket.CONNECTING: return "CONNECTING (0)"
    case WebSocket.OPEN: return "OPEN (1)"
    case WebSocket.CLOSING: return "CLOSING (2)"
    case WebSocket.CLOSED: return "CLOSED (3)"
    default: return `UNKNOWN (${state})`
  }
}

// Tab updated listener (keep)
chrome.tabs.onUpdated.addListener(
  async ( // Make the listener async to use await for the promise if needed, though not strictly necessary for just .catch
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab
  ) => {
    if (changeInfo.status === "complete") {
      // console.log(`Tab ${tabId} updated, status complete. Sending checkContentScriptReady.`); // Optional: for debugging if needed
      chrome.tabs.sendMessage(tabId, { action: "checkContentScriptReady" })
        .then(response => {
          // Optional: log response if content script replies, e.g., response.status
          // if (response && response.status) {
          //   console.log(`Content script in tab ${tabId} responded to check: ${response.status}`);
          // }
        })
        .catch(error => {
          // Gracefully handle the common "no receiving end" error
          if (error.message === "Could not establish connection. Receiving end does not exist." || 
              error.message?.includes("Receiving end does not exist")) {
            // This is expected for tabs where the content script isn't injected or isn't ready.
            // console.warn(`Failed to send checkContentScriptReady to tab ${tabId} (likely no content script): ${error.message}`);
          } else {
            // Log other unexpected errors
            console.error(`Error sending checkContentScriptReady to tab ${tabId}:`, error);
          }
        });
    }
    // Removed the OAuth callback URL log as it's not directly related to this error
  }
)

async function initializeConnectionOnStartup() {
  console.log("[Startup] Checking initial authentication state...");
  
  oauthManager.onAuthSuccess((idToken) => {
    console.log("[AuthSuccessCallback] Triggered. ID Token (first 10 chars):", idToken ? idToken.substring(0,10) : "null", ". Clearing old wsToken and initiating WebSocket connection.");
    // console.log("[Startup] Auth success callback triggered with valid token. Clearing old wsToken and initiating WebSocket connection..."); // Original log, commented out as new one is more specific
    userId = null; // Force new wsToken fetch
    wsToken = null; // Force new wsToken fetch
    connectWebSocket();
  });
  
  try {
    const isAuthenticated = await oauthManager.isAuthenticated();
    if (isAuthenticated) {
      console.log("[Startup] User is already authenticated. WebSocket connection will be initiated by auth callback.");
      // No need to explicitly call connectWebSocket() - the callback will handle it
    } else {
      console.log("[Startup] User is not authenticated. Attempting to refresh session immediately (silently)...");
      try {
        console.log("[Startup] Attempting silent id_token refresh via oauthManager.getIdToken(false).");
        const newIdToken = await oauthManager.getIdToken(false);
        if (!newIdToken) {
          // This will be hit if getIdToken(false) returns null
          console.log("[Startup] Silent id_token refresh via oauthManager.getIdToken(false) returned null. Manual login likely required.");
          console.log("[Startup] Silent authentication/refresh not possible (returned null). User needs to log in manually. Extension will wait.");
        }
        // If newIdToken exists, the auth success callback will handle connecting the WebSocket
      } catch (error: any) {
        // This catch block will now only handle unexpected errors from getIdToken
        console.error("[Startup] Error during initial silent oauthManager.getIdToken(false) call:", error);
        console.error("[Startup] Unexpected error during initial silent authentication/refresh attempt:", error.message, error.stack);
      }
    }
  } catch (error: any) { 
    console.error("[Startup] Error during initial authentication/refresh attempt:", error.message);
  }
}

initializeConnectionOnStartup();
console.log("Quick OTP Background Service Worker Loaded.");
