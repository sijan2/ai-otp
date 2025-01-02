import { Hono } from 'hono';

//
// -- Type Definitions
//

interface Env {
  WEBSOCKET_SERVER_URL: string;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  REDIRECT_URI: string;
}

interface PubSubMessage {
  message: {
    data: string;
  };
  subscription: string;
}

interface MessageData {
  emailAddress: string;
  historyId: string;
}

interface ProcessedResult {
  status: 'success' | 'error';
  message: string;
  emailAddress?: string;
  historyId?: string;
}

type OAuthTokenResponse = {
  access_token: string;
  expires_in: number;
  id_token?: string;
  scope: string;
  token_type: string;
  refresh_token?: string;
};

type TokenRequestBody = {
  code?: string;
  refresh_token?: string;
};

const HTTP_STATUS = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
} as const;

//
// -- Hono Setup
//

const app = new Hono<{ Bindings: Env }>();

//
// 1) Pub/Sub Push Endpoint
//    - Must match the URL path used in your Pub/Sub Subscription's push endpoint.
//
app.post('/pubsub', async (c) => {
  try {
    const pubsubRequest = await c.req.json<PubSubMessage>();

    if (!pubsubRequest.message || !pubsubRequest.message.data) {
      return c.json(
        { error: 'Invalid Pub/Sub message format' },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const decodedData = atob(pubsubRequest.message.data);
    const messageData = JSON.parse(decodedData) as MessageData;

    const result = await processMessage(messageData, c.env);
    return c.json(result, HTTP_STATUS.OK);
  } catch (err) {
    console.error('PubSub error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

//
// 2) OAuth Token Exchange Endpoint
//    - Exchanges an authorization code for an access token (and optionally a refresh token).
//
app.post('/api/auth/token', async (c) => {
  try {
    const body = await c.req.json<TokenRequestBody>();

    if (!body.code) {
      return c.json(
        { error: 'Authorization code is required' },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const tokenData = await exchangeToken({
      url: 'https://oauth2.googleapis.com/token',
      body: {
        code: body.code,
        client_id: c.env.CLIENT_ID,
        client_secret: c.env.CLIENT_SECRET,
        redirect_uri: c.env.REDIRECT_URI,
        grant_type: 'authorization_code',
      },
    });

    return c.json(
      {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: now + tokenData.expires_in,
      },
      HTTP_STATUS.OK
    );
  } catch (err) {
    console.error('Error exchanging token:', err);
    return c.json(
      { error: 'Failed to exchange token' },
      HTTP_STATUS.BAD_REQUEST
    );
  }
});

//
// 3) OAuth Token Refresh Endpoint
//    - Exchanges a refresh token for a new access token.
//
app.post('/api/auth/refresh', async (c) => {
  try {
    const body = await c.req.json<TokenRequestBody>();

    if (!body.refresh_token) {
      return c.json(
        { error: 'Refresh token is required' },
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const tokenData = await exchangeToken({
      url: 'https://oauth2.googleapis.com/token',
      body: {
        refresh_token: body.refresh_token,
        client_id: c.env.CLIENT_ID,
        client_secret: c.env.CLIENT_SECRET,
        grant_type: 'refresh_token',
      },
    });

    return c.json(
      {
        accessToken: tokenData.access_token,
        expiresAt: now + tokenData.expires_in,
      },
      HTTP_STATUS.OK
    );
  } catch (err) {
    console.error('Error refreshing token:', err);
    return c.json(
      { error: 'Failed to refresh token' },
      HTTP_STATUS.BAD_REQUEST
    );
  }
});

//
// -- Pub/Sub Processing Logic
//
async function processMessage(
  messageData: MessageData,
  env: Env
): Promise<ProcessedResult> {
  try {
    const { emailAddress, historyId } = messageData;
    console.log(
      `PubSub message: new email for ${emailAddress}, historyId=${historyId}`
    );

    // Convert WSS URL to HTTPS
    const serverUrl = env.WEBSOCKET_SERVER_URL.replace('wss://', 'https://');

    // Send HTTP POST request to the server
    const response = await fetch(serverUrl, {
      method: 'POST',
      body: JSON.stringify({ emailAddress, historyId }),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to send data: ${response.statusText}`);
    }

    return {
      status: 'success',
      message: 'Processed new email notification',
      emailAddress,
      historyId,
    };
  } catch (error) {
    console.error('processMessage error:', error);
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

//
// -- Utility to Exchange Tokens with Google OAuth
//
async function exchangeToken(params: {
  url: string;
  body: Record<string, string>;
}): Promise<OAuthTokenResponse> {
  const resp = await fetch(params.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params.body),
  });

  const data: any = await resp.json();

  if (!resp.ok) {
    throw new Error(data.error || 'Failed to exchange token');
  }

  return data as OAuthTokenResponse;
}

//
// -- Export the Fetch Handler
//    Cloudflare Workers will call this entry point on any incoming HTTP request.
//
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(request, env, ctx);
  },
};
