import { Router } from 'itty-router';

import { WebSocketHub } from './durable-objects/WebSocketHubDO';
import { TokenStoreDO } from './durable-objects/TokenStoreDO';

// Import services from new location
import {
  generateAuthUrl,
  generatePKCE,
  exchangeCodeForTokens,
  verifyAndDecodeIdToken,
  revokeGoogleToken,
  generateWebSocketToken,
  processAndStoreRefreshedGoogleTokens,
  validatePubSubJwt
} from './services/authService';
import {
  setupGmailWatch,
  handleGmailPushNotification,
  stopGmailWatch,
  listGmailLabels,
  setupGmailOtpAutomation,
  recreateOtpFilter
} from './services/gmailService';
import { parsePubSubMessage } from './services/pubsubService';

// Removed imports from deleted ./utils/token-store

// Create a new router
const router = Router();

// Session state storage (for OAuth flow)
const sessionStates = new Map<string, { codeVerifier: string, redirectUrl?: string }>();


const MASTER_TOKEN_STORE_ID = "MASTER_TOKEN_STORE";
function getTokenStoreDOStub(env: Env): TokenStoreDO {
  const id = env.TOKEN_STORE_DO.idFromName(MASTER_TOKEN_STORE_ID);
  return env.TOKEN_STORE_DO.get(id) as unknown as TokenStoreDO;
}

// Helper to get user-specific WebSocketHubDO stub
function getWebSocketHubStub(env: Env, userId: string): WebSocketHub {
    const id = env.WEBSOCKET_HUB.idFromName(userId);
    return env.WEBSOCKET_HUB.get(id) as unknown as WebSocketHub;
}

// Route: OAuth login
router.get('/auth/login', async (request: Request, env: Env): Promise<Response> => {
  try {
    const url = new URL(request.url);
    const redirectUrlParam = url.searchParams.get('redirectUrl');
    if (!redirectUrlParam) {
      return new Response('Missing redirectUrl parameter', { status: 400 });
    }

    let redirectUrl: string;
    try {
      const ru = new URL(redirectUrlParam);
      const extId = env.CHROME_EXTENSION_ID;
      const allowedHost = extId ? `${extId}.chromiumapp.org` : '';
      const isAllowed = ru.protocol === 'https:' && ((allowedHost && ru.hostname === allowedHost) || (!allowedHost && /\.chromiumapp\.org$/i.test(ru.hostname)));
      if (!isAllowed) {
        return new Response('Invalid redirectUrl parameter', { status: 400 });
      }
      // Persist only origin to avoid path-based open redirects
      redirectUrl = ru.origin;
    } catch {
      return new Response('Invalid redirectUrl parameter', { status: 400 });
    }

    const { verifier, challenge } = await generatePKCE();
    const state = crypto.randomUUID();
    sessionStates.set(state, { codeVerifier: verifier, redirectUrl });
    const authUrl = generateAuthUrl(env.GOOGLE_CLIENT_ID, env.GOOGLE_REDIRECT_URI, state, challenge);
    return Response.redirect(authUrl, 302);
  } catch (error: any) {
    console.error('Error initiating OAuth flow:', error);
    return new Response('Error initiating OAuth flow', { status: 500 });
  }
});

// Route: OAuth callback
router.get('/auth/callback', async (request: Request, env: Env): Promise<Response> => {
  try {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return new Response('Missing code or state parameter', { status: 400 });
    const session = sessionStates.get(state);
    if (!session) return new Response('Invalid state parameter', { status: 400 });
    sessionStates.delete(state);

    const tokens = await exchangeCodeForTokens(code, session.codeVerifier, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
    if (!tokens.id_token) throw new Error('ID token missing from Google response');

    const idTokenPayload = await verifyAndDecodeIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID);
    const tokenStoreStub = getTokenStoreDOStub(env);

    // Store tokens ONLY in TokenStoreDO
    // Pass default watchedLabelIds, storeTokens will handle preserving if already set
    await tokenStoreStub.storeTokens(
        idTokenPayload.sub,
        idTokenPayload.email,
        tokens.access_token,
        tokens.refresh_token || '',
        Math.floor(Date.now() / 1000) + tokens.expires_in,
        [] // Explicitly pass empty array, matching new default in storeTokens
    );

    // REMOVE automatic Gmail watch setup on login/callback
    /*
    const currentTokenData = await tokenStoreStub.getTokenByUserId(idTokenPayload.sub);
    const labelsToWatch = currentTokenData?.watchedLabelIds || []; // Default to empty if not set

    if (labelsToWatch.length > 0) { // Only attempt watch if there are labels to watch
      try {
        console.log(`[OAuth Callback] Setting up initial Gmail watch for user ${idTokenPayload.sub} with labels: ${labelsToWatch.join(', ')}`);
        await setupGmailWatch(tokens.access_token, env.PUBSUB_TOPIC_NAME, labelsToWatch);
        console.log(`[OAuth Callback] Initial Gmail watch setup successful for user ${idTokenPayload.sub}`);
      } catch(watchError: any) {
          console.error(`[OAuth Callback] Failed to setup initial Gmail watch for user ${idTokenPayload.sub}: ${watchError.message}`);
      }
    } else {
        console.log(`[OAuth Callback] No labels configured to watch for user ${idTokenPayload.sub}. Skipping initial watch setup.`);
    }
    */
    console.log(`[OAuth Callback] User ${idTokenPayload.sub} authenticated. Tokens stored.`);

    // --- Gmail OTP Automation Setup ---
    const currentTokenData = await tokenStoreStub.getTokenByUserId(idTokenPayload.sub);
    if (currentTokenData && !currentTokenData.isGmailAutomationSetup) {
      console.log(`[OAuth Callback] User ${idTokenPayload.sub}: Gmail OTP automation not yet set up. Attempting setup...`);
      try {
        const automationResult = await setupGmailOtpAutomation(tokens.access_token, idTokenPayload.sub);
        // Simplified log for automation result
        if (automationResult.success) {
            console.log(`[OAuth Callback] User ${idTokenPayload.sub}: Gmail OTP Automation successful. LabelID: ${automationResult.otpLabelId}, FilterID: ${automationResult.filterId}`);
        } else {
            console.error(`[OAuth Callback] User ${idTokenPayload.sub}: Gmail OTP Automation FAILED. Message: ${automationResult.message}`);
        }

        if (automationResult.success && automationResult.otpLabelId) {
          await tokenStoreStub.updateOtpLabelAndFilterIds(idTokenPayload.sub, automationResult.otpLabelId, automationResult.filterId ?? null);
          await tokenStoreStub.markGmailAutomationSetupComplete(idTokenPayload.sub, true);
          await tokenStoreStub.updateWatchedLabelIds(idTokenPayload.sub, [automationResult.otpLabelId]);
          // console.log(`[OAuth Callback] User ${idTokenPayload.sub}: Stored OTP Label ID ${automationResult.otpLabelId} and Filter ID ${automationResult.filterId ?? 'N/A'}. Marked setup complete. Now watching OTP label.`); // Remove this more verbose log

          const setupWatchResult = await setupGmailWatch(tokens.access_token, env.PUBSUB_TOPIC_NAME, [automationResult.otpLabelId]);
          await tokenStoreStub.updateHistoryId(idTokenPayload.sub, setupWatchResult.historyId);
          console.log(`[OAuth Callback] User ${idTokenPayload.sub}: Gmail watch started for OTP label. History ID: ${setupWatchResult.historyId}`);

        } else {
          console.error(`[OAuth Callback] User ${idTokenPayload.sub}: Gmail OTP automation setup failed: ${automationResult.message}`);
          // Do not mark as setup, it can be retried on next login or manually
        }
      } catch (automationError: any) {
        console.error(`[OAuth Callback] User ${idTokenPayload.sub}: Exception during Gmail OTP automation setup: ${automationError.message}`);
      }
    } else if (currentTokenData && currentTokenData.isGmailAutomationSetup && currentTokenData.otpLabelId) {
      console.log(`[OAuth Callback] User ${idTokenPayload.sub}: Gmail OTP automation already set up. Ensuring watch is active for OTP label: ${currentTokenData.otpLabelId}`);
      try {
        // Ensure watch is active for the OTP label
        const setupWatchResult = await setupGmailWatch(tokens.access_token, env.PUBSUB_TOPIC_NAME, [currentTokenData.otpLabelId]);
        await tokenStoreStub.updateHistoryId(idTokenPayload.sub, setupWatchResult.historyId);
        console.log(`[OAuth Callback] User ${idTokenPayload.sub}: Gmail watch refreshed for OTP label. History ID: ${setupWatchResult.historyId}`);
      } catch (watchError: any) {
          console.error(`[OAuth Callback] User ${idTokenPayload.sub}: Failed to refresh Gmail watch for OTP label: ${watchError.message}`);
      }
    } else {
        console.warn(`[OAuth Callback] User ${idTokenPayload.sub}: Cannot determine Gmail automation status or missing OTP label ID. Skipping automatic watch setup.`);
    }

    // Redirect back to extension
    const redirectUrl = session.redirectUrl || 'chrome-extension://your-extension-id/callback.html'; // Placeholder
    // const redirectWithToken = `${redirectUrl}?id_token=${tokens.id_token}`;
    const redirectParams = new URLSearchParams({
      id_token: tokens.id_token,
      email: idTokenPayload.email, // Add verified email
      // exp is a standard claim in idTokenPayload from a verified token
      expiry_timestamp: idTokenPayload.exp ? idTokenPayload.exp.toString() : '', // Add verified expiry (seconds)
      user_id: idTokenPayload.sub, // Add verified user_id (sub)
    });
    const redirectWithTokenAndInfo = `${redirectUrl}?${redirectParams.toString()}`;
    return Response.redirect(redirectWithTokenAndInfo, 302);

  } catch (error: any) {
    console.error('Error in OAuth callback:', error);
    return new Response('Error in OAuth callback: ' + error.message, { status: 500 });
  }
});

// Routes: /auth/token and /auth/refresh - These seem specific to a different auth flow (e.g., extension manual code entry?)
// They currently store tokens in KV. They should be updated to use TokenStoreDO if this flow is still needed.
// For now, commenting them out as they rely on the removed KV storeUserTokens.
/*
router.post('/auth/token', ...);
router.post('/auth/refresh', ...);
*/

// Route: /websocket/:userId (Actual WebSocket connection)
router.get('/websocket/:userId', async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  const requestUrl = new URL(request.url);
  const userId = (request as any).params?.userId;

  if (!userId || typeof userId !== 'string') {
    console.error(`[WebSocket Route V3] Critical: userId from request.params is invalid. Value: '${userId}', Type: ${typeof userId}. Full params: ${JSON.stringify((request as any).params)}`);
    return new Response('User ID (from path :userId) is required, string, and was not correctly found.', { status: 400 });
  }

  // Log the exact userId being passed to getWebSocketHubStub - KEEPING THIS LOG FOR NOW
  console.log(`[WebSocket Route V3] Extracted valid userId: '${userId}'. Calling getWebSocketHubStub.`);

  const wsHubStub = getWebSocketHubStub(env, userId);

  // *** REINSTATE HEADER WORKAROUND ***
  // Create a new Headers object for the DO fetch, including the X-User-Id
  const doRequestHeaders = new Headers(request.headers);
  doRequestHeaders.set('X-User-Id', userId);

  // Create a new request to pass to the DO, with the added header
  const doRequest = new Request(request.url, {
    method: request.method,
    headers: doRequestHeaders,
    // For a WebSocket upgrade GET request, body is null, redirect is manual.
    // If other properties are needed, copy them from original `request`
  });

  // return wsHubStub.fetch(request); // Incorrect call without header
  return wsHubStub.fetch(doRequest); // Correct call with header
});

// Legacy WebSocket route - /websocket?userId=...
router.get('/websocket', async (request: Request, env: Env): Promise<Response> => {
  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');
    if (!userId) return new Response('Missing userId parameter', { status: 400 });

    const wsHubStub = getWebSocketHubStub(env, userId);

    // Forward the request to the DO.
    return wsHubStub.fetch(request);

  } catch (error: any) {
    console.error(`[WebSocket Route Legacy] Error handling connection: ${error.message}`);
    return new Response(`WebSocket connection error: ${error.message}`, { status: 500 });
  }
});

// Route: Generate a JWT token for WebSocket authentication
// This seems to create a simple non-standard JWT. Consider using a proper library or mechanism.
router.post('/auth/ws-token', async (request: Request, env: Env): Promise<Response> => {
  try {
    const body = await request.json() as { idToken?: string };
    if (!body.idToken) return new Response(JSON.stringify({ error: 'missing_id_token' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const idTokenPayload = await verifyAndDecodeIdToken(body.idToken, env.GOOGLE_CLIENT_ID);
    const userId = idTokenPayload.sub;

    if (!env.WEBSOCKET_JWT_SECRET) {
      console.error('[WS Token Route] CRITICAL: WEBSOCKET_JWT_SECRET is not set in environment.');
      return new Response(JSON.stringify({ error: 'server_configuration_error', message: 'WebSocket token generation is misconfigured.' }), { status: 500, headers: { 'Content-Type': 'application/json' }});
    }

    // Generate a signed JWT for WebSocket authentication
    const wsToken = await generateWebSocketToken(userId, env.WEBSOCKET_JWT_SECRET);

    return new Response(JSON.stringify({ token: wsToken, userId: userId }), { headers: { 'Content-Type': 'application/json' }});

  } catch (error: any) {
    console.error('Error generating WebSocket token:', error);
    if (error.message && (error.message.includes('Token expired') || error.message.includes('Invalid token') || error.message.includes('Failed to verify ID token'))) {
        return new Response(JSON.stringify({ error: 'invalid_id_token', message: error.message }), { status: 401, headers: { 'Content-Type': 'application/json' }});
    }
    return new Response(JSON.stringify({ error: 'server_error', message: 'Failed to generate WebSocket token.' }), { status: 500, headers: { 'Content-Type': 'application/json' }});
  }
});

// Route: Watch Gmail for changes (manual trigger, potentially for testing/initiation)
// Should use TokenStoreDO now
router.post('/api/watch-gmail', async (request: Request, env: Env): Promise<Response> => {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return new Response('Unauthorized', { status: 401 });
    const token = authHeader.substring(7); // ID Token

    const idTokenPayload = await verifyAndDecodeIdToken(token, env.GOOGLE_CLIENT_ID);
    const userId = idTokenPayload.sub;
    const tokenStoreStub = getTokenStoreDOStub(env);

    // Get a valid access token FROM TokenStoreDO
    const accessToken = await tokenStoreStub.getValidAccessToken(userId);

    const { historyId } = await setupGmailWatch(accessToken, env.PUBSUB_TOPIC_NAME, ['INBOX']);

    // Store history ID FOR TokenStoreDO
    await tokenStoreStub.updateHistoryId(userId, historyId);

    return new Response(JSON.stringify({ success: true, historyId }), { headers: { 'Content-Type': 'application/json' }});
  } catch (error: any) {
    console.error('Error setting up Gmail watch:', error);
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
});

// Route: Get user's currently watched labels
router.get('/api/get-watched-labels', async (request: Request, env: Env): Promise<Response> => {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Missing or invalid Authorization header.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const idToken = authHeader.substring(7);
    const idTokenPayload = await verifyAndDecodeIdToken(idToken, env.GOOGLE_CLIENT_ID);
    const userId = idTokenPayload.sub;

    const tokenStoreStub = getTokenStoreDOStub(env);
    const tokenData = await tokenStoreStub.getTokenByUserId(userId);

    if (!tokenData) {
      return new Response(JSON.stringify({ error: 'not_found', message: 'User token data not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    const watchedLabelIds = tokenData.watchedLabelIds || ['INBOX']; // Default if somehow not set
    return new Response(JSON.stringify({ watchedLabelIds }), { headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Get Watched Labels] Error:', error);
    return new Response(JSON.stringify({ error: 'server_error', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// Route: Update user's watched labels and re-initiate Gmail watch
router.post('/api/update-watched-labels', async (request: Request, env: Env): Promise<Response> => {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Missing or invalid Authorization header.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const idToken = authHeader.substring(7);
    const idTokenPayload = await verifyAndDecodeIdToken(idToken, env.GOOGLE_CLIENT_ID);
    const userId = idTokenPayload.sub;

    const body = await request.json() as { labelIds?: string[] };
    if (!body.labelIds || !Array.isArray(body.labelIds) || body.labelIds.some(id => typeof id !== 'string')) {
      return new Response(JSON.stringify({ error: 'bad_request', message: 'Invalid or missing labelIds array.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const newLabelIds = body.labelIds;
    console.log(`[Update Watched Labels] User ${userId} requested update to labels: [${newLabelIds.join(', ')}]`);

    const tokenStoreStub = getTokenStoreDOStub(env);
    const accessToken = await tokenStoreStub.getValidAccessToken(userId);

    // 1. Stop existing Gmail watch (always do this before updating preferences or starting new)
    try {
      console.log(`[Update Watched Labels] User ${userId} stopping existing Gmail watch.`);
      await stopGmailWatch(accessToken);
      console.log(`[Update Watched Labels] User ${userId} successfully stopped existing Gmail watch.`);
    } catch (stopWatchError: any) {
      console.warn(`[Update Watched Labels] User ${userId} error stopping Gmail watch: ${stopWatchError.message}. This might be okay if no watch was active.`);
    }

    // 2. Update stored label preferences
    await tokenStoreStub.updateWatchedLabelIds(userId, newLabelIds);
    console.log(`[Update Watched Labels] User ${userId} DB updated with new labels: [${newLabelIds.join(', ')}]`);

    if (newLabelIds.length === 0) {
      console.log(`[Update Watched Labels] User ${userId} provided an empty label list. Watch will remain stopped.`);
      // Ensure historyId is cleared if watch is stopped and no new labels are set.
      await tokenStoreStub.updateHistoryId(userId, ""); // Pass empty string or null to clear
      console.log(`[Update Watched Labels] User ${userId} historyId cleared as no labels are watched.`);
      return new Response(JSON.stringify({ success: true, message: 'Watch stopped and no labels are currently being monitored.' }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 3. Setup new Gmail watch with new labels (only if newLabelIds is not empty)
    console.log(`[Update Watched Labels] User ${userId} setting up new Gmail watch for labels: [${newLabelIds.join(', ')}]`);
    const { historyId } = await setupGmailWatch(accessToken, env.PUBSUB_TOPIC_NAME, newLabelIds);
    console.log(`[Update Watched Labels] User ${userId} successfully set up new Gmail watch. New historyId: ${historyId}`);

    // 4. Store the new historyId
    await tokenStoreStub.updateHistoryId(userId, historyId);
    console.log(`[Update Watched Labels] User ${userId} stored new historyId.`);

    return new Response(JSON.stringify({ success: true, message: 'Watched labels updated and Gmail watch re-initialized.', newHistoryId: historyId }), { headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Update Watched Labels] Error:', error);
    if (error.message && error.message.includes('No token data found for user')) {
        return new Response(JSON.stringify({ error: 'not_found', message: error.message }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'server_error', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// Route: Stop Gmail watch entirely for the user
router.post('/api/stop-watch', async (request: Request, env: Env): Promise<Response> => {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Missing or invalid Authorization header.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const idToken = authHeader.substring(7);
    const idTokenPayload = await verifyAndDecodeIdToken(idToken, env.GOOGLE_CLIENT_ID);
    const userId = idTokenPayload.sub;

    console.log(`[Stop Watch] User ${userId} requested to stop Gmail watch.`);

    const tokenStoreStub = getTokenStoreDOStub(env);
    const accessToken = await tokenStoreStub.getValidAccessToken(userId);

    // 1. Stop existing Gmail watch
    await stopGmailWatch(accessToken);
    console.log(`[Stop Watch] User ${userId} successfully stopped Gmail watch via API.`);

    // 2. Update stored label preferences to empty
    await tokenStoreStub.updateWatchedLabelIds(userId, []);
    console.log(`[Stop Watch] User ${userId} watchedLabelIds cleared in DB.`);

    // 3. Clear historyId
    await tokenStoreStub.updateHistoryId(userId, ""); // Pass empty string or null
    console.log(`[Stop Watch] User ${userId} historyId cleared in DB.`);

    return new Response(JSON.stringify({ success: true, message: 'Gmail watch successfully stopped.' }), { headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Stop Watch] Error:', error);
    if (error.message && error.message.includes('No token data found for user')) {
        return new Response(JSON.stringify({ error: 'not_found', message: error.message }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'server_error', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// Route: List user's Gmail labels
router.get('/api/list-labels', async (request: Request, env: Env): Promise<Response> => {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Missing or invalid Authorization header.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const idToken = authHeader.substring(7);
    const idTokenPayload = await verifyAndDecodeIdToken(idToken, env.GOOGLE_CLIENT_ID);
    const userId = idTokenPayload.sub;

    const tokenStoreStub = getTokenStoreDOStub(env);

    // Get a valid access token to call the Gmail API
    const accessToken = await tokenStoreStub.getValidAccessToken(userId);

    // List the labels
    const labels = await listGmailLabels(accessToken);

    return new Response(JSON.stringify({ labels }), { headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[List Labels] Error:', error);
    if (error.message && error.message.includes('No token data found for user')) {
        return new Response(JSON.stringify({ error: 'not_found', message: error.message }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
     if (error.message && error.message.includes('Failed to list Gmail labels')) {
        // Pass through specific Gmail API errors if needed
        return new Response(JSON.stringify({ error: 'gmail_api_error', message: error.message }), { status: 502, headers: { 'Content-Type': 'application/json' } }); // Bad Gateway
    }
    return new Response(JSON.stringify({ error: 'server_error', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// Route: Receive Pub/Sub notifications
router.post('/pubsub', async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
  try {
    console.log('[PubSub] Received PubSub notification');

    // --- JWT Validation for Pub/Sub --- START ---
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.error('[PubSub] Unauthorized: Missing or malformed Authorization header.');
      return new Response('Unauthorized: Missing or invalid Authorization header.', { status: 401 });
    }
    const token = authHeader.substring(7); // Extract token after 'Bearer '

    // Use the dedicated environment variable for Pub/Sub audience
    const expectedAudience = env.GOOGLE_PUBSUB_JWT_AUDIENCE;
    if (!expectedAudience) {
      console.error('[PubSub] CRITICAL: PUBSUB_AUDIENCE (or GOOGLE_PUBSUB_JWT_AUDIENCE) environment variable is not set.');
      return new Response('Server configuration error for Pub/Sub authentication.', { status: 500 });
    }

    const expectedServiceAccountEmail = env.PUBSUB_SERVICE_ACCOUNT_EMAIL;
    if (!expectedServiceAccountEmail) { // Add check for required environment variable
      console.error('[PubSub] CRITICAL: PUBSUB_SERVICE_ACCOUNT_EMAIL environment variable is not set.');
      return new Response('Server configuration error for Pub/Sub authentication.', { status: 500 });
    }

    try {
      await validatePubSubJwt(token, expectedAudience, expectedServiceAccountEmail);
      console.log('[PubSub] Pub/Sub JWT validation successful.');
    } catch (jwtError: any) {
      console.error(`[PubSub] Unauthorized: Pub/Sub JWT validation failed: ${jwtError.message}`);
      return new Response(`Unauthorized: JWT validation failed: ${jwtError.message}`, { status: 401 }); // 401 or 403
    }
    // --- JWT Validation for Pub/Sub --- END ---

    const body = await request.json() as any; // Use any for flexibility during parsing attempts
    const notification = parsePubSubMessage(body);
    console.log(`[PubSub] Parsed notification for ${notification.emailAddress}, historyId: ${notification.historyId}`);

    // Prepare config for gmailService function, including WebSocketHub namespace
    const gmailConfig: import('./services/gmailService').GmailHandlerConfig = {
        tokenStoreDONamespace: env.TOKEN_STORE_DO,
        webSocketHubDONamespace: env.WEBSOCKET_HUB,
        provider: env.AI_PROVIDER,
        // OpenAI specific config
        ...(env.AI_PROVIDER === 'openai' && {
            openAIApiKey: env.OPENAI_API_KEY,
            openAIModelName: env.OPENAI_MODEL_NAME,
            openAIEndpoint: env.OPENAI_ENDPOINT,
        }),
        // Gemini specific config
        ...(env.AI_PROVIDER === 'gemini' && {
            geminiApiKey: env.GOOGLE_API_KEY,
            geminiModelName: env.GEMINI_MODEL_NAME,
            geminiEndpoint: env.GEMINI_ENDPOINT,
        }),
    };

    // Call the consolidated handler from gmailService.ts
    // Use ctx.waitUntil to allow processing after response is sent to Pub/Sub
    ctx.waitUntil(handleGmailPushNotification(gmailConfig, notification)
        .then(() => {
            console.log(`[PubSub] Finished background processing for notification: ${notification.historyId}`);
        })
        .catch(err => {
            console.error(`[PubSub] Background processing failed for notification ${notification.historyId}:`, err);
        })
    );

    // Acknowledge Pub/Sub immediately
    return new Response('Notification received', { status: 200 });

  } catch (error: any) {
    console.error('Error handling Pub/Sub notification:', error);
    // Return 500 to indicate failure to Pub/Sub, causing potential retries
    return new Response(`Error handling Pub/Sub notification: ${error.message}`, { status: 500 });
  }
});

// Route: Refresh Google tokens using a stored refresh_token
router.post('/auth/refresh-google-tokens', async (request: Request, env: Env): Promise<Response> => {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Missing or invalid Authorization header.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const currentIdToken = authHeader.substring(7); // Extract token after 'Bearer '

    let userIdFromToken: string;
    try {
      // We decode the ID token primarily to get the userId (sub).
      // Pass true for ignoreExpiry for this specific refresh purpose.
      const idTokenPayload = await verifyAndDecodeIdToken(currentIdToken, env.GOOGLE_CLIENT_ID, true);
      userIdFromToken = idTokenPayload.sub;
    } catch (error: any) {
      // If token is too invalid to even get sub (e.g. aud/iss mismatch, malformed), then we can't proceed.
      console.warn(`[Refresh Route] Error validating provided ID token (even with expiry ignored): ${error.message}. Cannot determine user.`);
      return new Response(JSON.stringify({ error: 'invalid_token_structure', message: `Provided ID token is invalid or malformed: ${error.message}` }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    console.log(`[Refresh Route] Attempting token refresh for user: ${userIdFromToken}`);
    const tokenStoreStub = getTokenStoreDOStub(env);

    // 1. Get the stored refresh_token for the user
    const storedRefreshToken = await tokenStoreStub.getRefreshToken(userIdFromToken);
    if (!storedRefreshToken) {
      console.warn(`[Refresh Route: ${userIdFromToken}] No refresh token found in TokenStoreDO. Full re-authentication required.`);
      // It's important to let the client know a full auth is needed.
      return new Response(JSON.stringify({ error: 'refresh_token_not_found', message: 'No refresh token available. Please log in again.' }), { status: 403, headers: { 'Content-Type': 'application/json' } }); // 403 Forbidden, as re-auth is needed
    }

    // 2. Call the service to refresh tokens with Google and update TokenStoreDO
    const refreshResult = await processAndStoreRefreshedGoogleTokens(
      tokenStoreStub,
      userIdFromToken,
      storedRefreshToken,
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET
    );

    if (!refreshResult || !refreshResult.newIdToken) {
      console.warn(`[Refresh Route: ${userIdFromToken}] Token refresh process failed or no new ID token was returned. Full re-authentication may be required.`);
      // This could happen if the refresh_token was revoked at Google (invalid_grant)
      // processAndStoreRefreshedGoogleTokens handles deleting user from DO in that case.
      return new Response(JSON.stringify({ error: 'refresh_failed', message: 'Failed to refresh tokens. Please log in again.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    // 3. Success: return the new ID token and its expiry to the extension
    console.log(`[Refresh Route: ${userIdFromToken}] Successfully refreshed ID token.`);
    // Decode the new ID token to get its claims securely
    const newIdTokenPayload = await verifyAndDecodeIdToken(refreshResult.newIdToken, env.GOOGLE_CLIENT_ID);

    return new Response(JSON.stringify({
      id_token: refreshResult.newIdToken,
      // new_id_token_expiry_timestamp: refreshResult.newIdToken ? (await verifyAndDecodeIdToken(refreshResult.newIdToken, env.GOOGLE_CLIENT_ID)).exp : null
      new_id_token_expiry_timestamp: newIdTokenPayload.exp, // Already verified
      email: newIdTokenPayload.email, // Add verified email
      user_id: newIdTokenPayload.sub, // Add verified userId (sub)
    }), { headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Refresh Route] Unexpected error:', error);
    return new Response(JSON.stringify({ error: 'server_error', message: 'An unexpected error occurred during token refresh.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// Route: Logout user - stop Gmail watch and delete tokens
router.post('/auth/logout', async (request: Request, env: Env): Promise<Response> => {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: 'Missing or invalid Authorization header.' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const idToken = authHeader.substring(7); // Extract token after 'Bearer '

    const idTokenPayload = await verifyAndDecodeIdToken(idToken, env.GOOGLE_CLIENT_ID);
    const userId = idTokenPayload.sub;

    console.log(`[Logout] Initiating logout for user ${userId}`);

    const tokenStoreStub = getTokenStoreDOStub(env);

    // 1. Get current access token to stop the watch
    let accessTokenForWatchStop: string | null = null;
    try {
      accessTokenForWatchStop = await tokenStoreStub.getValidAccessToken(userId);
    } catch (error: any) {
      console.warn(`[Logout] User ${userId}: Could not retrieve access token to stop Gmail watch (possibly already expired or tokens deleted): ${error.message}`);
      // Continue with logout even if we can't get the token, as the main goal is to clear data
    }

    // 2. Stop Gmail Watch if we got an access token
    if (accessTokenForWatchStop) {
      try {
        console.log(`[Logout] User ${userId}: Attempting to stop Gmail watch.`);
        await stopGmailWatch(accessTokenForWatchStop); // Using the function from gmailService.ts
        console.log(`[Logout] User ${userId}: Successfully stopped Gmail watch.`);
      } catch (watchError: any) {
        console.error(`[Logout] User ${userId}: Failed to stop Gmail watch: ${watchError.message}. Proceeding with token deletion.`);
      }

      // 2b. Revoke Google Token
      try {
        console.log(`[Logout] User ${userId}: Attempting to revoke Google token.`);
        await revokeGoogleToken(accessTokenForWatchStop); // Using the access token obtained for stopping the watch
        console.log(`[Logout] User ${userId}: Successfully requested Google token revocation.`);
      } catch (revokeError: any) {
        console.error(`[Logout] User ${userId}: Failed to revoke Google token: ${revokeError.message}. Proceeding with local token deletion.`);
        // Log error but continue with deleting local tokens
      }
    } else {
      console.warn(`[Logout] User ${userId}: No valid access token found, skipping Gmail watch stop and Google token revocation.`);
    }

    // 3. Delete tokens from TokenStoreDO
    try {
      console.log(`[Logout] User ${userId}: Attempting to delete tokens from TokenStoreDO.`);
      await tokenStoreStub.deleteUser(userId);
      console.log(`[Logout] User ${userId}: Successfully deleted tokens from TokenStoreDO.`);
    } catch (deleteError: any) {
      console.error(`[Logout] User ${userId}: Failed to delete tokens from TokenStoreDO: ${deleteError.message}.`);
      // This is a more critical error, might want to return 500 if this fails
      return new Response(JSON.stringify({ error: 'server_error', message: 'Failed to delete user token data.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ success: true, message: 'Logout successful. Gmail watch stopped and tokens deleted.' }), { headers: { 'Content-Type': 'application/json' }});

  } catch (error: any) {
    if (error.message && (error.message.includes('Token expired') || error.message.includes('Invalid token'))) {
      return new Response(JSON.stringify({ error: 'unauthorized', message: `ID token issue: ${error.message}` }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    console.error('[Logout] Error during logout process:', error);
    return new Response(JSON.stringify({ error: 'server_error', message: 'An unexpected error occurred during logout.' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// Route: Get user preferences (including moveToTrash)
router.get('/api/get-user-preferences', async (request: Request, env: Env): Promise<Response> => {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const idToken = authHeader.substring(7);
    const idTokenPayload = await verifyAndDecodeIdToken(idToken, env.GOOGLE_CLIENT_ID);
    const userId = idTokenPayload.sub;

    const tokenStoreStub = getTokenStoreDOStub(env);
    const tokenData = await tokenStoreStub.getTokenByUserId(userId);

    if (!tokenData) {
      return new Response(JSON.stringify({ error: 'not_found', message: 'User data not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // Return relevant preferences
    const preferences = {
        moveToTrash: tokenData.moveToTrash ?? true // Default to true if undefined
        // Add other preferences here in the future if needed
    };

    return new Response(JSON.stringify(preferences), { headers: { 'Content-Type': 'application/json' } });

  } catch (error: any) {
    console.error('[Get User Preferences] Error:', error);
    if (error.message && (error.message.includes('Token expired') || error.message.includes('Invalid token'))) {
        return new Response(JSON.stringify({ error: 'unauthorized', message: error.message }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
     if (error.message && error.message.includes('User data not found')) {
        return new Response(JSON.stringify({ error: 'not_found', message: error.message }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'server_error', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// Route: Update moveToTrash preference and recreate filter
router.post('/api/update-trash-preference', async (request: Request, env: Env): Promise<Response> => {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    const idToken = authHeader.substring(7);
    const idTokenPayload = await verifyAndDecodeIdToken(idToken, env.GOOGLE_CLIENT_ID);
    const userId = idTokenPayload.sub;

    const body = await request.json() as { moveToTrash?: boolean };
    if (typeof body.moveToTrash !== 'boolean') {
      return new Response(JSON.stringify({ error: 'bad_request', message: 'Missing or invalid moveToTrash boolean field.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const moveToTrash = body.moveToTrash;
    console.log(`[Update Trash Preference] User ${userId} setting moveToTrash to ${moveToTrash}`);

    const tokenStoreStub = getTokenStoreDOStub(env);

    // 1. Update preference in DO
    await tokenStoreStub.updateMoveToTrashPreference(userId, moveToTrash);
    console.log(`[Update Trash Preference] User ${userId} preference updated in DO.`);

    // 2. Get access token
    const accessToken = await tokenStoreStub.getValidAccessToken(userId);
    console.log(`[Update Trash Preference] User ${userId} obtained valid access token.`);

    // 3. Recreate the filter
    const filterResult = await recreateOtpFilter(accessToken, userId, tokenStoreStub);

    if (filterResult && filterResult.id) {
      console.log(`[Update Trash Preference] User ${userId} successfully recreated filter. New/verified ID: ${filterResult.id}`);
      return new Response(JSON.stringify({ success: true, message: 'Preference updated and filter recreated successfully.', filterId: filterResult.id }), { headers: { 'Content-Type': 'application/json' } });
    } else {
      console.error(`[Update Trash Preference] User ${userId} failed to recreate filter after updating preference.`);
      // Return success=true because preference was updated, but indicate filter issue
      return new Response(JSON.stringify({ success: true, message: 'Preference updated, but failed to recreate the Gmail filter.', filterId: null }), { status: 207, headers: { 'Content-Type': 'application/json' } }); // 207 Multi-Status might fit
    }

  } catch (error: any) {
    const userIdLog = request.headers.get('Authorization') ? 'AuthenticatedUser' : 'UnauthenticatedUser'; // Avoid logging actual token
    console.error(`[Update Trash Preference: ${userIdLog}] Error:`, error);
    // Handle specific errors like invalid token, user not found, etc.
    if (error.message && (error.message.includes('Token expired') || error.message.includes('Invalid token'))) {
        return new Response(JSON.stringify({ error: 'unauthorized', message: error.message }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    if (error.message && error.message.includes('No token data found')) {
        return new Response(JSON.stringify({ error: 'not_found', message: 'User data not found.' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    // Default server error
    return new Response(JSON.stringify({ error: 'server_error', message: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});

// Removed /register-test-user and /register-user routes that used KV store.
// If needed, they should be reimplemented using TokenStoreDO.

// Route: Default/404
router.all('*', (): Response => new Response('Not Found', { status: 404 }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log(`[Router] Request: ${request.method} ${new URL(request.url).pathname}`);
    try {
      return await router.handle(request, env, ctx); // Pass ctx for waitUntil
    } catch (error: any) {
      console.error(`[Router] Error:`, error);
      return new Response(`Server Error: ${error.message}`, { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;

// Export the Durable Objects
export { WebSocketHub, TokenStoreDO }; // Ensure class names match exports in DO files
