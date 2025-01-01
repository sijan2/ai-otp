import { config } from './config';
import { Storage } from './storage';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
  userName?: string;
  expiryDate: Date;
}

class OAuthManager {
  // Required scopes for your use case
  private static readonly SCOPES = ['https://mail.google.com/'];

  private static readonly CLIENT_ID = config.GMAIL_CLIENT_ID;
  private static readonly REDIRECT_URI = config.REDIRECT_URI;
  private static readonly TOKEN_EXCHANGE_URL = config.TOKEN_EXCHANGE_URL;
  private static readonly REFRESH_URL = config.REFRESH_URL;

  private storage: Storage;

  constructor() {
    this.storage = new Storage();
  }

  /**
   * Get a valid token. If none found or it's expired, refresh or re-initiate the flow.
   */
  public async getAuthToken(): Promise<string> {
    const tokenResponse = await this.getTokenResponse();
    if (!tokenResponse) {
      // No stored token, do a full login
      const newTokenResponse = await this.login();
      return newTokenResponse.access_token;
    } else if (this.isTokenExpired(tokenResponse)) {
      // Token is expired, try to refresh
      if (tokenResponse.refresh_token) {
        return this.refreshToken(tokenResponse);
      } else {
        // No refresh token => go through full login again
        const newTokenResponse = await this.login();
        return newTokenResponse.access_token;
      }
    }
    // Token is valid
    return tokenResponse.access_token;
  }

  /**
   * Initiates the OAuth flow, obtains an authorization code, exchanges for tokens, stores them.
   */
  public async login(): Promise<TokenResponse> {
    const authCode = await this.launchWebAuthFlow();
    const tokenResponse = await this.exchangeAuthCodeForTokens(authCode);
    await this.storage.set('tokenResponse', tokenResponse);
    return tokenResponse;
  }

  /**
   * Returns the current TokenResponse from storage (or null if none).
   */
  public async getTokenResponse(): Promise<TokenResponse | null> {
    return this.storage.get<TokenResponse>('tokenResponse');
  }

  /**
   * Clears local token data. If you previously used getAuthToken, you might also
   * removeCachedAuthToken from Chrome's internal cache, but not strictly needed here.
   */
  public async logout(): Promise<void> {
    await this.storage.remove('tokenResponse');
  }

  /**
   * Revokes the current stored access token via Google's revoke endpoint.
   * (Does not remove from local storage automatically; call logout() as well if desired.)
   */
  public async revokeAccessToken(): Promise<void> {
    const tokenResponse = await this.getTokenResponse();
    if (tokenResponse) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(tokenResponse.access_token)}`,
      });
    }
  }

  /**
   * If we have a refresh_token, call the Worker to get a new access token. Otherwise, do full login.
   */
  private async refreshToken(tokenResponse: TokenResponse): Promise<string> {
    if (!tokenResponse.refresh_token) {
      const newTokenResponse = await this.login();
      return newTokenResponse.access_token;
    }
    // Refresh via Worker
    const refreshed = await this.refreshAccessTokenViaServer(
      tokenResponse.refresh_token
    );
    await this.storage.set('tokenResponse', refreshed);
    return refreshed.access_token;
  }

  /**
   * Calls the refresh endpoint on the Worker with { refresh_token }
   */
  private async refreshAccessTokenViaServer(
    refreshToken: string
  ): Promise<TokenResponse> {
    const resp = await fetch(OAuthManager.REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!resp.ok) {
      throw new Error(`Failed to refresh token: ${await resp.text()}`);
    }
    const data = await resp.json();
    const expiryDate = new Date(Date.now() + data.expires_in * 1000);

    return {
      access_token: data.accessToken,
      refresh_token: data.refreshToken,
      expires_in: data.expires_in,
      token_type: 'Bearer',
      scope: OAuthManager.SCOPES.join(' '),
      expiryDate,
    };
  }

  /**
   * Uses launchWebAuthFlow to open the OAuth sign-in screen and parse out the "code" param.
   */
  private async launchWebAuthFlow(): Promise<string> {
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    const state = Math.random().toString(36).substring(7);

    authUrl.searchParams.set('client_id', OAuthManager.CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', OAuthManager.REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', OAuthManager.SCOPES.join(' '));
    authUrl.searchParams.set('state', state);

    // Required for obtaining refresh_token
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    return new Promise<string>((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive: true },
        (redirectUrl) => {
          if (chrome.runtime.lastError || !redirectUrl) {
            return reject(
              new Error(
                `launchWebAuthFlow error: ${
                  chrome.runtime.lastError?.message || 'No redirect URL'
                }`
              )
            );
          }

          const queryString = redirectUrl.split('?')[1] || '';
          const urlParams = new URLSearchParams(queryString);
          const code = urlParams.get('code');
          const returnedState = urlParams.get('state');

          if (!code) {
            return reject(
              new Error('No "code" parameter returned by OAuth flow.')
            );
          }
          if (state !== returnedState) {
            return reject(
              new Error('Invalid state parameter returned by OAuth flow.')
            );
          }

          resolve(code);
        }
      );
    });
  }

  /**
   * POSTs { code } to the Worker (TOKEN_EXCHANGE_URL) to get { accessToken, refreshToken, expiresAt }.
   */
  private async exchangeAuthCodeForTokens(
    code: string
  ): Promise<TokenResponse> {
    const resp = await fetch(OAuthManager.TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!resp.ok) {
      throw new Error(`Token exchange request failed: ${await resp.text()}`);
    }
    const data = await resp.json();

    // Our Worker returns { accessToken, refreshToken, expiresAt }
    return {
      access_token: data.accessToken,
      refresh_token: data.refreshToken, // may be undefined if user didn't grant offline access
      expires_in: data.expiresAt - Math.floor(Date.now() / 1000),
      token_type: 'Bearer',
      scope: OAuthManager.SCOPES.join(' '),
      expiryDate: new Date(data.expiresAt * 1000),
    };
  }

  /**
   * Check if the token is expired based on `expiryDate`.
   */
  private isTokenExpired(tokenResponse: TokenResponse): boolean {
    return new Date() > new Date(tokenResponse.expiryDate);
  }
}

export const oauthManager = new OAuthManager();
