import { Hono } from 'hono';

type Env = {
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  REDIRECT_URI: string;
};

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

const app = new Hono<{ Bindings: Env }>();

async function exchangeToken(params: {
  url: string;
  body: Record<string, string>;
}): Promise<OAuthTokenResponse> {
  const response = await fetch(params.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params.body),
  });

  const data: any = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to exchange token');
  }

  return data as OAuthTokenResponse;
}

app.post('/api/auth/token', async (c) => {
  const body = await c.req.json<TokenRequestBody>();

  if (!body.code) {
    return c.json(
      { error: 'Authorization code is required' },
      HTTP_STATUS.BAD_REQUEST
    );
  }

  const now = Math.floor(Date.now() / 1000);

  try {
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
  } catch (error) {
    return c.json({ error: (error as Error).message }, HTTP_STATUS.BAD_REQUEST);
  }
});

app.post('/api/auth/refresh', async (c) => {
  const body = await c.req.json<TokenRequestBody>();

  if (!body.refresh_token) {
    return c.json(
      { error: 'Refresh token is required' },
      HTTP_STATUS.BAD_REQUEST
    );
  }

  const now = Math.floor(Date.now() / 1000);

  try {
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
  } catch (error) {
    return c.json({ error: (error as Error).message }, HTTP_STATUS.BAD_REQUEST);
  }
});

export default app;
