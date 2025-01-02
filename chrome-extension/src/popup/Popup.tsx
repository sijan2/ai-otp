import React, { useState, useEffect } from 'react'
import { oauthManager } from '../lib/oauth'
import { Button, buttonVariants } from '../components/ui/button'
import { cn } from '../lib/utils'
import { setupGmailWatch, WatchResponse } from '../lib/setup'

const Popup: React.FC = () => {
  const [session, setSession] = useState<boolean>(false)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [watchCreated, setWatchCreated] = useState<boolean>(false)
  const [watchResponse, setWatchResponse] = useState<WatchResponse | null>(null)
  const [showDebugInfo, setShowDebugInfo] = useState<boolean>(false)

  useEffect(() => {
    checkLoginStatus()
  }, [])

  const checkLoginStatus = async () => {
    try {
      const tokenResponse = await oauthManager.getTokenResponse()
      if (tokenResponse && tokenResponse.access_token) {
        setSession(true)
        const accessToken = tokenResponse.access_token
        const responseData = await setupGmailWatch(accessToken)
        setWatchCreated(true)
        setWatchResponse(responseData)
      } else {
        setSession(false)
      }
    } catch (error) {
      console.error('Error checking login status:', error)
      setError('Failed to check login status')
    }
  }

  const loginWithGoogle = async () => {
    setIsLoading(true)
    setError(null)
    setMessage(null)
    try {
      const tokenResponse = await oauthManager.login()
      const accessToken = tokenResponse.access_token
      setSession(true)
      const responseData = await setupGmailWatch(accessToken)
      setWatchCreated(true)
      setWatchResponse(responseData)
    } catch (error) {
      console.error('Login failed:', error)
      setError('Login failed')
    } finally {
      setIsLoading(false)
    }
  }

  const handleLogout = async () => {
    setIsLoading(true)
    setError(null)
    setMessage(null)
    try {
      await oauthManager.logout()
      setSession(false)
      setWatchCreated(false)
      setWatchResponse(null)
      setShowDebugInfo(false)
      setMessage('Logged out successfully')
    } catch (error) {
      console.error('Logout failed:', error)
      setError('Logout failed')
    } finally {
      setIsLoading(false)
    }
  }

  // Updated handler function to revoke access token and logout
  const handleRevokeAccessToken = async () => {
    setIsLoading(true)
    setError(null)
    setMessage(null)
    try {
      await oauthManager.revokeAccessToken()
      await oauthManager.logout()
      setSession(false)
      setWatchCreated(false)
      setWatchResponse(null)
      setShowDebugInfo(false)
      setMessage('Access token revoked and logged out successfully')
    } catch (error) {
      console.error('Failed to revoke access token and logout:', error)
      setError('Failed to revoke access token and logout')
    } finally {
      setIsLoading(false)
    }
  }

  const calculateDaysUntilExpiration = (
    expirationTimestamp: string
  ): number => {
    const expirationDate = new Date(parseInt(expirationTimestamp))
    const currentDate = new Date()
    const timeDifference = expirationDate.getTime() - currentDate.getTime()
    const daysDifference = Math.ceil(timeDifference / (1000 * 3600 * 24))
    return daysDifference
  }

  const formatExpirationDate = (expirationTimestamp: string): string => {
    const expirationDate = new Date(parseInt(expirationTimestamp))
    return expirationDate.toLocaleString()
  }

  return (
    <div className='flex flex-col w-[300px] rounded bg-slate-50 p-4'>
      <Button
        type='button'
        className={cn(buttonVariants({ variant: 'outline' }))}
        onClick={session ? handleLogout : loginWithGoogle}
        disabled={isLoading}
      >
        {isLoading
          ? 'Processing...'
          : session
          ? `Logged in Successfully`
          : 'Login with Google'}
      </Button>
      {error && <div className='text-red-500 mb-2'>Error: {error}</div>}
      {message && <div className='text-green-500 mb-2'>{message}</div>}

      {watchResponse && (
        <Button
          type='button'
          className={cn(buttonVariants({ variant: 'ghost' }), 'mt-2')}
          onClick={() => setShowDebugInfo(!showDebugInfo)}
        >
          {showDebugInfo ? 'Hide Debug Information' : 'Show Debug Information'}
        </Button>
      )}

      {showDebugInfo && watchResponse && (
        <div className='text-green-500 mt-2'>
          <p>Watch created successfully.</p>
          <p>History ID: {watchResponse.historyId}</p>
          <p>
            Expires in: {calculateDaysUntilExpiration(watchResponse.expiration)}{' '}
            days
          </p>
          <p>
            Expiration Date: {formatExpirationDate(watchResponse.expiration)}
          </p>
        </div>
      )}

      {/* Revoke Access Token and Logout Button */}
      {session && (
        <Button
          type='button'
          className={cn(buttonVariants({ variant: 'outline' }), 'mt-2')}
          onClick={handleRevokeAccessToken}
          disabled={isLoading}
        >
          Revoke Access Token
        </Button>
      )}
    </div>
  )
}

export default Popup
