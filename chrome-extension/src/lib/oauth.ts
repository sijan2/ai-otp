import { config } from "./config"
import { Storage } from "./storage"

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
  id_token?: string
  expiryTimestamp: number // Milliseconds since epoch
  email?: string
  userId?: string
}

type AuthSuccessCallback = (idToken: string) => void;

class OAuthManager {
  // Required OAuth scopes.
  // OpenID scopes are included to ensure Google returns an ID token,
  // which is necessary for backend registration and WebSocket authentication.
  private static readonly SCOPES = [
    "openid",
    "email",
    "profile",
    "https://mail.google.com/",
  ]

  private storage: Storage
  private authInProgress: boolean = false
  private authPromise: Promise<string | null> | null = null
  private authSuccessCallbacks: AuthSuccessCallback[] = []

  constructor() {
    this.storage = new Storage()
    console.log("[OAuthManager] Initialized");
  }

  /**
   * Registers a callback to be executed upon successful authentication.
   * If authentication has already occurred, the callback is invoked immediately.
   * @param callback Function to execute with the ID token.
   */
  public onAuthSuccess(callback: AuthSuccessCallback): void {
    this.authSuccessCallbacks.push(callback)
    console.log("[OAuthManager] Auth success callback registered.");

    // If already authenticated, trigger callback immediately.
    this.getTokenResponse().then(tokenResponse => {
      if (tokenResponse?.id_token && !this.isTokenExpired(tokenResponse)) {
        console.log('[OAuthManager] Already authenticated, triggering callback immediately for newly registered listener.');
        callback(tokenResponse.id_token)
      }
    }).catch(err => {
      console.error('[OAuthManager] Error checking existing token for immediate callback:', err)
    })
  }

  /**
   * Executes all registered authentication success callbacks.
   * @param idToken The ID token to pass to the callbacks.
   */
  private triggerAuthSuccessCallbacks(idToken: string): void {
    console.log(`[OAuthManager] Triggering ${this.authSuccessCallbacks.length} auth success callbacks with new ID token (first 10 chars): ${idToken ? idToken.substring(0,10) : "null"}`);
    for (const callback of this.authSuccessCallbacks) {
      try {
        callback(idToken)
      } catch (error) {
        console.error('[OAuthManager] Error in auth success callback:', error)
      }
    }
  }

  /**
   * Ensures the user is authenticated and returns a valid ID token.
   * If a valid token is not found or is expired, this method attempts to refresh it via the backend.
   * If backend refresh fails or is not possible, and `interactiveLoginPermitted` is true,
   * it initiates the interactive login flow.
   * @param interactiveLoginPermitted If true, allows fallback to interactive login. Defaults to true.
   * @returns A promise that resolves with the ID token, or null if authentication fails and interactive login is not permitted.
   */
  public async getIdToken(interactiveLoginPermitted: boolean = true): Promise<string | null> {
    try {
      console.log(`[OAuthManager.getIdToken] Called. Interactive permitted: ${interactiveLoginPermitted}, Auth in progress: ${this.authInProgress}`);
      if (this.authInProgress && this.authPromise) {
        // console.log("[OAuthManager.getIdToken] Auth already in progress, awaiting existing promise.");
        return this.authPromise;
      }

      const tokenResponse = await this.getTokenResponse();

      if (tokenResponse && tokenResponse.id_token && !this.isTokenExpired(tokenResponse)) {
        console.log("[OAuthManager.getIdToken] Returning valid cached ID token (first 10 chars):", tokenResponse.id_token.substring(0,10));
        return tokenResponse.id_token;
      }
      
      console.log("[OAuthManager.getIdToken] Local token invalid, expired, or missing. Proceeding to full token refresh sequence.");
      // The condition `!tokenResponse || !tokenResponse.id_token || this.isTokenExpired(tokenResponse)` is met.
      
      if (!interactiveLoginPermitted && (!tokenResponse || !tokenResponse.id_token)) {
        // If interactive login is not permitted, AND there's absolutely no token to attempt a backend refresh with,
        // then we can't do anything.
        // Note: _performFullTokenRefreshSequence will handle the case where backend refresh is possible
        // but interactive login is subsequently disallowed if backend refresh fails.
        console.log("[OAuthManager.getIdToken] Interactive login not permitted and no token for backend refresh. Returning null.");
        return null;
      }
      
      // Delegate to the centralized refresh sequence.
      // authInProgress and authPromise will be managed by _performFullTokenRefreshSequence
      // and its callers (getIdToken, forceRefreshAndConnect).
      // console.log("[OAuthManager.getIdToken] Calling _performFullTokenRefreshSequence(false).");
      this.authPromise = this._performFullTokenRefreshSequence(false); // isForceRefresh = false
      return this.authPromise;

    } catch (error: any) {
      console.error("[OAuthManager.getIdToken] Error:", error.message, error.stack);
      // Ensure authInProgress and authPromise are cleared if an unexpected error occurs here,
      // though _performFullTokenRefreshSequence should handle its own state.
      this.authInProgress = false;
      this.authPromise = null;
      throw error; // Rethrow other unexpected errors
    }
  }

  /**
   * Initiates the OAuth 2.0 authorization code flow using `chrome.identity.launchWebAuthFlow`.
   * This method communicates with the backend to handle the OAuth dance with Google,
   * ultimately receiving an ID token, email, expiry timestamp, and user ID.
   * @returns A promise that resolves with an object containing the id_token, email, expiryTimestamp, and userId.
   */
  private async launchWebAuthFlow(): Promise<{ id_token: string, email: string, expiryTimestamp: number, userId: string }> {
    console.log("[OAuthManager.launchWebAuthFlow] Initiating interactive login.");
    const backendLoginUrl = new URL(config.BACKEND_URL + '/auth/login');
    // The extension callback URL must match what's configured in the Google Cloud Console
    // and what the backend expects to redirect to.
    const extensionCallbackUrl = `https://${chrome.runtime.id}.chromiumapp.org`;
    backendLoginUrl.searchParams.set('redirectUrl', extensionCallbackUrl);

    console.log("[OAuthManager.launchWebAuthFlow] Attempting to launch with URL:", backendLoginUrl.toString());

    if (!navigator.onLine) {
      console.warn("[OAuthManager.launchWebAuthFlow] Network appears to be offline. launchWebAuthFlow may fail.");
      // Optionally, you could throw an error here or implement a brief delay/retry,
      // but for now, just logging is fine as launchWebAuthFlow itself will likely fail and be caught.
    }

    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        {
          url: backendLoginUrl.toString(),
          interactive: true,
        },
        (callbackUrl) => {
          if (chrome.runtime.lastError || !callbackUrl) {
            console.error("[OAuthManager.launchWebAuthFlow] Error object:", chrome.runtime.lastError);
            return reject(
              new Error(
                `launchWebAuthFlow error: ${
                  chrome.runtime.lastError?.message || "No callback URL received from backend redirect"
                }`
              )
            )
          }
          
          console.log("[OAuthManager.launchWebAuthFlow] Successfully received callback URL:", callbackUrl);
          const urlParams = new URLSearchParams(callbackUrl.split('?')[1] || "");
          const id_token = urlParams.get("id_token");
          const error = urlParams.get("error");
          const email = urlParams.get("email");
          const expiryTimestampStr = urlParams.get("expiry_timestamp"); // Seconds
          const userId = urlParams.get("user_id");

          if (error) {
            return reject(new Error(`OAuth callback error from backend: ${error}`))
          }

          if (!id_token || !email || !expiryTimestampStr || !userId) {
            return reject(
              new Error('Required token information (id_token, email, expiry, userId) not returned in callback URL from backend.')
            )
          }

          const expiryTimestamp = parseInt(expiryTimestampStr, 10) * 1000; // Convert to ms
          if (isNaN(expiryTimestamp)) {
            return reject(new Error('Invalid expiry_timestamp received from backend.'));
          }

          resolve({ id_token, email, expiryTimestamp, userId });
        }
      )
    })
  }

  /**
   * Initiates the login flow. It calls `launchWebAuthFlow` to obtain token information
   * from the backend (which handles the Google OAuth interaction) and stores a minimal
   * `TokenResponse` locally.
   * @returns A promise that resolves with the `TokenResponse`.
   */
  public async login(): Promise<TokenResponse> {
    // This method is now primarily called by _performFullTokenRefreshSequence.
    // The authInProgress flag is managed by the caller (_performFullTokenRefreshSequence or its own callers).
    console.log("[OAuthManager.login] Starting interactive login process via launchWebAuthFlow.");
    try {
      const { id_token, email, expiryTimestamp, userId } = await this.launchWebAuthFlow();
      console.log("[OAuthManager.login] launchWebAuthFlow successful. Received id_token (first 10 chars):", id_token ? id_token.substring(0,10) : "null");
      console.log("[OAuthManager.login] Interactive login flow successful. Storing new token.");

      const minimalTokenResponse: TokenResponse = {
          id_token: id_token,
          email: email,
          expiryTimestamp: expiryTimestamp, // Already in ms
          userId: userId,
          access_token: "managed_by_backend", // Placeholder, as backend manages the actual access token
          expires_in: Math.max(0, Math.floor((expiryTimestamp - Date.now()) / 1000)), // Calculated from ms expiry
          token_type: "Bearer",
          scope: OAuthManager.SCOPES.join(" "), // Default scope
      };

      await this.storage.set("tokenResponse", minimalTokenResponse);
      console.log("[OAuthManager.login] Token response stored successfully.");
      return minimalTokenResponse;

    } catch (error) {
      console.error("[OAuthManager.login] Login method failed:", error);
      await this.storage.remove("tokenResponse"); // Ensure local token is cleared on error
      throw error; // Re-throw to be caught by _performFullTokenRefreshSequence
    }
  }

  /**
   * Retrieves the current `TokenResponse` from storage.
   * Handles migration from an old token format if necessary.
   * @returns A promise that resolves with the `TokenResponse` or null if not found.
   */
  public async getTokenResponse(): Promise<TokenResponse | null> {
    console.log("[OAuthManager.getTokenResponse] Attempting to retrieve token from storage.");
    const tokenResponse = await this.storage.get<any>("tokenResponse");

    if (!tokenResponse) {
      console.log("[OAuthManager.getTokenResponse] No token found in storage.");
      return null;
    }

    // Migration for tokens stored with 'expiryDate' instead of 'expiryTimestamp'
    if (tokenResponse.expiryDate && typeof tokenResponse.expiryDate === 'string' && !tokenResponse.expiryTimestamp) {
      console.log("[OAuthManager.getTokenResponse] Migrating token format from old expiryDate to new expiryTimestamp.");
      const { expiryDate, ...restOfOldToken } = tokenResponse; // Destructure to remove expiryDate

      const newExpiryTimestamp = new Date(expiryDate).getTime();

      const migratedTokenResponse: TokenResponse = {
        access_token: restOfOldToken.access_token || "managed_by_backend",
        refresh_token: restOfOldToken.refresh_token, // Will be undefined if not present, which is fine for an optional field
        expires_in: restOfOldToken.expires_in !== undefined 
          ? restOfOldToken.expires_in 
          : Math.max(0, Math.floor((newExpiryTimestamp - Date.now()) / 1000)),
        token_type: restOfOldToken.token_type || "Bearer",
        scope: restOfOldToken.scope || OAuthManager.SCOPES.join(" "),
        id_token: restOfOldToken.id_token,
        expiryTimestamp: newExpiryTimestamp,
        email: restOfOldToken.email,
        userId: restOfOldToken.userId,
      };
      // expiryDate is not part of migratedTokenResponse due to destructuring, so no delete needed.

      await this.storage.set("tokenResponse", migratedTokenResponse);
      console.log("[OAuthManager.getTokenResponse] Token found in storage. ID token (first 10 chars):", migratedTokenResponse.id_token ? migratedTokenResponse.id_token.substring(0,10) : "null", "IsExpired:", this.isTokenExpired(migratedTokenResponse));
      return migratedTokenResponse;
    }
    console.log("[OAuthManager.getTokenResponse] Token found in storage. ID token (first 10 chars):", tokenResponse.id_token ? tokenResponse.id_token.substring(0,10) : "null", "IsExpired:", this.isTokenExpired(tokenResponse));
    return tokenResponse as TokenResponse;
  }

  /**
   * Clears local token data, notifies the backend to log out the user,
   * and requests the background script to close any active WebSocket connection.
   */
  public async logout(): Promise<void> {
    console.log("[OAuthManager.logout] Initiating logout.");
    try {
      const tokenResponse = await this.getTokenResponse();

      if (tokenResponse && tokenResponse.id_token) {
        if (config.BACKEND_URL) {
          try {
            // console.log("[OAuthManager] Calling backend /auth/logout");
            const response = await fetch(`${config.BACKEND_URL}/auth/logout`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${tokenResponse.id_token}`,
                'Content-Type': 'application/json',
              },
            });
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({ message: 'Failed to logout from backend, unknown error' }));
              console.error('Backend logout failed:', response.status, errorData.message || 'Unknown error');
            } else {
              // console.log('[OAuthManager] Successfully logged out from backend.');
            }
          } catch (fetchError: any) {
            console.error('[OAuthManager.logout] Backend logout fetch error:', fetchError.message);
          }
        } else {
          console.warn("[OAuthManager] Backend URL is not configured. Skipping backend logout.");
        }
      } else {
        // console.warn('[OAuthManager] No ID token found locally. Skipping backend logout call.');
      }

      // Client-side revocation of Google access token is generally not effective here
      // as the actual access token is managed by the backend.
      // await this.revokeGoogleAccessTokenInternally(tokenResponse);

      try {
        // console.log("[OAuthManager] Requesting background script to close WebSocket.");
        await chrome.runtime.sendMessage({ action: "explicitWsClose" });
      } catch (e: any) {
        // This can happen if the background script is inactive (e.g., during extension uninstall/reload)
        // console.warn("[OAuthManager] Could not send explicitWsClose to background (it might be inactive):", e.message);
      }

    } catch (error: any) {
      console.error("Error during logout process:", error.message)
    } finally {
      console.log("[OAuthManager.logout] Clearing local tokenResponse.");
      await this.storage.remove("tokenResponse")
      // console.log("[OAuthManager] Local tokenResponse cleared.");
    }
  }

  /**
   * Checks if the stored token is expired.
   * A token is considered expired if its `expiryTimestamp` is in the past,
   * or within a small buffer window (5 minutes) to account for clock skew and processing time.
   * @param tokenResponse The token response to check.
   * @returns True if the token is expired or invalid, false otherwise.
   */
  private isTokenExpired(tokenResponse: TokenResponse | null): boolean {
    if (!tokenResponse || typeof tokenResponse.expiryTimestamp !== 'number') {
      return true; // No token, or timestamp is invalid/missing.
    }
    const expirationBuffer = 5 * 60 * 1000 // 5 minutes buffer.
    const isExpiredResult = tokenResponse.expiryTimestamp <= Date.now() + expirationBuffer;
    console.log(`[OAuthManager.isTokenExpired] Token expired status: ${isExpiredResult}`);
    return isExpiredResult;
  }

  /**
   * Checks if the user is currently authenticated with a valid (non-expired) token.
   * @returns A promise that resolves to true if authenticated, false otherwise.
   */
  public async isAuthenticated(): Promise<boolean> {
    const tokenResponse = await this.getTokenResponse();
    const isAuthenticatedResult = !!tokenResponse && !this.isTokenExpired(tokenResponse);
    console.log(`[OAuthManager.isAuthenticated] Authentication status: ${isAuthenticatedResult}`);
    return isAuthenticatedResult;
  }

  /**
   * Initiates a full token refresh sequence, attempting backend refresh first,
   * then falling back to interactive login if necessary. This is typically called
   * when an API call returns a 401, indicating the current ID token is definitively invalid.
   * It ensures only one such full refresh operation occurs at a time.
   * @returns A promise that resolves with the new ID token, or null if authentication fails.
   */
  public async forceRefreshAndConnect(): Promise<string | null> {
    console.log("[OAuthManager.forceRefreshAndConnect] Initiated due to explicit call (e.g., after 401).");
    if (this.authInProgress && this.authPromise) {
      console.log("[OAuthManager.forceRefreshAndConnect] Auth already in progress, awaiting existing promise.");
      return this.authPromise;
    }

    // console.log("[OAuthManager.forceRefreshAndConnect] Starting new full token refresh sequence.");
    this.authPromise = this._performFullTokenRefreshSequence(true);
    return this.authPromise;
  }

  /**
   * Performs the core logic of refreshing tokens, trying backend refresh first,
   * then interactive login. Manages the authInProgress state.
   * @param isForceRefresh If true, indicates the refresh was explicitly forced (e.g. by forceRefreshAndConnect)
   *                       and should attempt backend refresh even with a seemingly valid local token.
   * @returns A promise that resolves with the ID token, or null if all attempts fail.
   */
  private async _performFullTokenRefreshSequence(isForceRefresh: boolean = false): Promise<string | null> {
    // console.log(`[OAuthManager._performFullTokenRefreshSequence] Called with isForceRefresh: ${isForceRefresh}. Current authInProgress: ${this.authInProgress}`);
    if (this.authInProgress) {
        // This case should ideally be handled by the callers (getIdToken, forceRefreshAndConnect)
        // by awaiting this.authPromise if this.authInProgress is true.
        // However, as a safeguard:
        console.warn("[OAuthManager._performFullTokenRefreshSequence] Re-entered while authInProgress was true. This might indicate a race condition if not handled by caller. Awaiting existing authPromise.");
        if (this.authPromise) return this.authPromise;
        // If authPromise is null here, something is very wrong.
        console.error("[OAuthManager._performFullTokenRefreshSequence] Auth in progress but no authPromise. This is unexpected. Aborting to prevent issues.");
        return null; 
    }

    this.authInProgress = true;
    // console.log(`[OAuthManager._performFullTokenRefreshSequence] Set authInProgress to true. Current promise: ${this.authPromise ? 'exists' : 'null'}`);

    try {
      console.log("[OAuthManager._performFullTokenRefreshSequence] Attempting backend token refresh.");
      const currentTokenResponse = await this.getTokenResponse();

      // For forceRefresh, we attempt backend refresh even if currentTokenResponse or its id_token is null/stale,
      // as the backend might still identify the user via cookies or other means if id_token is missing,
      // or use the stale id_token if present.
      // If not a forceRefresh, and no id_token, then backend refresh isn't possible.
      if (!isForceRefresh && (!currentTokenResponse || !currentTokenResponse.id_token)) {
        console.log("[OAuthManager._performFullTokenRefreshSequence] No local ID token available for non-forced backend refresh. Skipping to interactive login.");
      } else {
        const maxRetries = 1;
        const retryDelay = 2000; // 2 seconds
        let backendRefreshSuccessful = false;

        for (let currentAttempt = 0; currentAttempt <= maxRetries; currentAttempt++) {
          try {
            const backendRefreshResponse = await fetch(`${config.BACKEND_URL}/auth/refresh-google-tokens`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${currentTokenResponse?.id_token || ''}`,
                'Content-Type': 'application/json',
              },
            });

            if (backendRefreshResponse.ok) {
              const newTokens = await backendRefreshResponse.json();
              if (newTokens.id_token && typeof newTokens.id_token === 'string' &&
                  newTokens.new_id_token_expiry_timestamp && typeof newTokens.new_id_token_expiry_timestamp === 'number' &&
                  newTokens.email && typeof newTokens.email === 'string' &&
                  newTokens.user_id && typeof newTokens.user_id === 'string') {
                console.log("[OAuthManager._performFullTokenRefreshSequence] Backend refresh successful.");
                const refreshedTokenResponse: TokenResponse = {
                  id_token: newTokens.id_token,
                  expiryTimestamp: newTokens.new_id_token_expiry_timestamp * 1000,
                  access_token: "managed_by_backend",
                  email: newTokens.email,
                  userId: newTokens.user_id,
                  expires_in: Math.max(0, Math.floor((newTokens.new_id_token_expiry_timestamp * 1000 - Date.now()) / 1000)),
                  scope: currentTokenResponse?.scope || OAuthManager.SCOPES.join(" "),
                  token_type: "Bearer",
                };
                await this.storage.set("tokenResponse", refreshedTokenResponse);
                this.triggerAuthSuccessCallbacks(newTokens.id_token);
                backendRefreshSuccessful = true;
                return newTokens.id_token; // Success, exit sequence
              } else {
                console.warn("[OAuthManager._performFullTokenRefreshSequence] Backend refresh responded OK but did not return all required token data. No retry. Proceeding to interactive login.");
                backendRefreshSuccessful = false; // Explicitly mark as failed
                break; // Break retry loop, proceed to interactive
              }
            } else {
              // HTTP errors (4xx, 5xx) from backend - generally not retriable for this operation
              const errorData = await backendRefreshResponse.json().catch(() => ({ message: "Unknown error during backend refresh"}));
              console.warn(`[OAuthManager._performFullTokenRefreshSequence] Backend refresh failed (HTTP status: ${backendRefreshResponse.status}, Message: ${errorData.message}). No retry for this type of error. Proceeding to interactive login.`);
              backendRefreshSuccessful = false; // Explicitly mark as failed
              break; // Break retry loop, proceed to interactive
            }
          } catch (fetchError: any) {
            console.error(`[OAuthManager._performFullTokenRefreshSequence] Backend refresh fetch error (attempt ${currentAttempt + 1}/${maxRetries + 1}):`, fetchError);
            if (currentAttempt < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, retryDelay));
            } else {
              console.error("[OAuthManager._performFullTokenRefreshSequence] Max retries reached for backend refresh fetch errors. Proceeding to interactive login.");
              backendRefreshSuccessful = false; // Explicitly mark as failed
              // Loop will end, and we'll proceed to interactive login if backendRefreshSuccessful is false
            }
          }
        }
        // If loop finishes and backendRefreshSuccessful is false, then we proceed to interactive.
        if (!backendRefreshSuccessful) {
           console.log("[OAuthManager._performFullTokenRefreshSequence] Backend refresh attempts failed or were skipped. Proceeding to interactive login.");
        } else {
            // This case should not be reached if successful return happens inside the loop.
            // However, as a safeguard:
            return null; // Should have returned new id_token if successful
        }
      }

      // If backend refresh was not successful, proceed to interactive login.
      // This is implicitly handled now by backendRefreshSuccessful flag check before this block in original design,
      // or by falling through if backendRefreshSuccessful is false.
      console.log("[OAuthManager._performFullTokenRefreshSequence] Checking if interactive login is needed.");
      // The backendRefreshSuccessful flag is effectively used by letting the code fall through
      // if it's false, or returning early if true.
      // No explicit if (!backendRefreshSuccessful) needed here as the successful return is inside the loop.

      console.log("[OAuthManager._performFullTokenRefreshSequence] Proceeding to interactive login stage.");
      try {
        const interactiveTokenResponse = await this.login(); // login() already handles storage
        if (interactiveTokenResponse && interactiveTokenResponse.id_token) {
          console.log("[OAuthManager._performFullTokenRefreshSequence] Interactive login successful.");
          this.triggerAuthSuccessCallbacks(interactiveTokenResponse.id_token);
          return interactiveTokenResponse.id_token;
        } else {
          console.error("[OAuthManager._performFullTokenRefreshSequence] Interactive login did not return a valid id_token.");
          return null;
        }
      } catch (loginError) {
        console.error("[OAuthManager._performFullTokenRefreshSequence] Interactive login failed:", loginError);
        return null;
      }
    } catch (error) {
      console.error("[OAuthManager._performFullTokenRefreshSequence] Error during token refresh sequence:", error);
      return null;
    } finally {
      // console.log(`[OAuthManager._performFullTokenRefreshSequence] Entering finally block. Resetting authInProgress. Promise before reset: ${this.authPromise ? 'exists' : 'null'}`);
      this.authInProgress = false;
      this.authPromise = null; // Clear the promise once the operation is complete
      // console.log("[OAuthManager._performFullTokenRefreshSequence] Reset authInProgress to false and authPromise to null.");
    }
  }
}

export const oauthManager = new OAuthManager()
