import { Storage } from './storage'

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope: string
  userName: string
  expiryDate: Date
}

class OAuthManager {
  private static readonly SCOPES = ['https://mail.google.com/']

  private storage: Storage

  constructor() {
    this.storage = new Storage()
  }

  async getAuthToken(): Promise<string> {
    const tokenResponse = await this.getTokenResponse()
    if (!tokenResponse || this.isTokenExpired(tokenResponse)) {
      return this.refreshToken(tokenResponse)
    }
    return tokenResponse.access_token
  }

  public async getTokenResponse(): Promise<TokenResponse | null> {
    return this.storage.get('tokenResponse')
  }

  private isTokenExpired(tokenResponse: TokenResponse): boolean {
    return new Date() > new Date(tokenResponse.expiryDate)
  }

  private async refreshToken(
    tokenResponse: TokenResponse | null
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: true }, async (token) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError)
        } else {
          const newTokenResponse = await this.fetchUserInfo(token!)
          await this.storage.set('tokenResponse', newTokenResponse)
          resolve(newTokenResponse.access_token)
        }
      })
    })
  }

  private async fetchUserInfo(token: string): Promise<TokenResponse> {
    const response = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    )
    const data = await response.json()

    return {
      access_token: token,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: OAuthManager.SCOPES.join(' '),
      userName: data.first_name,
      expiryDate: new Date(Date.now() + 3600 * 1000),
    }
  }

  async login(): Promise<TokenResponse> {
    const token = await this.getAuthToken()
    const tokenResponse = await this.fetchUserInfo(token)
    await this.storage.set('tokenResponse', tokenResponse)
    return tokenResponse
  }

  async logout(): Promise<void> {
    const tokenResponse = await this.getTokenResponse()
    if (tokenResponse) {
      await new Promise<void>((resolve) => {
        chrome.identity.removeCachedAuthToken(
          { token: tokenResponse.access_token },
          resolve
        )
      })
    }
    await this.storage.remove('tokenResponse')
  }

  async revokeAccessToken(): Promise<void> {
    const tokenResponse = await this.getTokenResponse()
    if (tokenResponse) {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `token=${tokenResponse.access_token}`,
      })
    }
  }
}

export const oauthManager = new OAuthManager()
