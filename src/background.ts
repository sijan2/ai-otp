// background.ts (TypeScript)

import { oauthManager } from './lib/oauth'

interface Message {
  action: string
  data: any
  timestamp: number
  retryCount?: number
}

let socket: WebSocket | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAY = 5000 // 5 seconds
const KEEP_ALIVE_INTERVAL = 30000 // 30 seconds

let messageQueue: Message[] = []
const contentScriptReadyTabs = new Set<number>()
const MAX_RETRY_COUNT = 5

// History ID and fetched message IDs
let previousHistoryId: string | null = null
const fetchedMessageIds = new Set<string>()

// Function to load previousHistoryId from storage
function loadPreviousHistoryId(): void {
  chrome.storage.local.get(['previousHistoryId'], (result) => {
    if (result.previousHistoryId) {
      previousHistoryId = result.previousHistoryId
      console.log('Loaded previousHistoryId:', previousHistoryId)
    } else {
      console.log('No previousHistoryId found in storage.')
      // You may want to initialize it with a starting value or wait until the first historyId comes in
    }
  })
}

// Function to save previousHistoryId to storage
function savePreviousHistoryId(historyId: string): void {
  chrome.storage.local.set({ previousHistoryId: historyId }, () => {
    console.log('Saved previousHistoryId:', historyId)
  })
}

// Call loadPreviousHistoryId when the background script starts
loadPreviousHistoryId()

function connectWebSocket(): void {
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) {
    console.log('WebSocket is already connected or connecting.')
    return
  }

  socket = new WebSocket('wss://websocket-sijan-6acdf23abc98.herokuapp.com')

  socket.onopen = (): void => {
    console.log('WebSocket connected')
    reconnectAttempts = 0
  }

  let lastOTPTime = 0
  const OTP_THROTTLE_INTERVAL = 4000 // 4 seconds

  socket.onmessage = async (event: MessageEvent): Promise<void> => {
    console.log('Received raw message:', event.data)
    try {
      const now = Date.now()
      if (now - lastOTPTime >= OTP_THROTTLE_INTERVAL) {
        lastOTPTime = now
        const data: any = JSON.parse(event.data)
        console.log('Parsed message:', data)
        if (data.historyId) {
          const newHistoryId = data.historyId.toString()
          console.log('Received new historyId:', newHistoryId)

          // Fetch new emails using the new historyId
          await fetchNewEmails(newHistoryId)
        } else {
          console.log('Received message without historyId. Ignoring.')
        }
      } else {
        console.log('Throttling OTP message to prevent overload.')
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error)
    }
  }

  socket.onclose = (event: CloseEvent): void => {
    console.log('WebSocket disconnected. Reason:', event.reason)
    handleReconnection()
  }

  socket.onerror = (error: Event): void => {
    console.error('WebSocket error:', error)
    handleReconnection()
  }
}

function handleReconnection(): void {
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    const delay = RECONNECT_DELAY * Math.pow(2, reconnectAttempts)
    reconnectAttempts++
    console.log(`Reconnecting in ${delay / 1000} seconds...`)
    setTimeout(connectWebSocket, delay)
  } else {
    console.error(
      'Max reconnection attempts reached. Please check your connection and reload the extension.'
    )
  }
}

function queueMessage(message: Message): void {
  message.timestamp = Date.now()
  messageQueue.push(message)
  console.log('Message queued:', message)
  processMessageQueue()
}

function processMessageQueue(): void {
  console.log('Processing message queue. Queue length:', messageQueue.length)
  console.log(
    'Content scripts ready in tabs:',
    Array.from(contentScriptReadyTabs)
  )

  if (contentScriptReadyTabs.size === 0) {
    console.log('No content scripts are ready. Notifying user.')
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
  if (message.action === 'processVerification') {
    const { code, url } = message.data.verificationResponse
    if (code) {
      showChromeNotification(
        'Verification Code',
        `Your verification code is: ${code}`
      )
    } else if (url) {
      showChromeNotification(
        'Verification Link',
        'A verification link is available. Click to open.',
        () => {
          openUrlInNewTab(url)
        }
      )
    }
  }
}

function showChromeNotification(
  title: string,
  message: string,
  callback?: () => void
): void {
  const notificationId = 'verification_' + Date.now()
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'icon_48.png',
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
  chrome.tabs.create({ url: url }, (tab) => {
    console.log('Opened new tab with URL:', url)
  })
}

function sendMessageToContentScript(message: Message): void {
  contentScriptReadyTabs.forEach((tabId) => {
    console.log('Sending message to content script in tab', tabId)
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.error(
          `Error sending message to tab ${tabId}:`,
          chrome.runtime.lastError.message
        )
        contentScriptReadyTabs.delete(tabId)
        message.retryCount = (message.retryCount || 0) + 1
        if (message.retryCount < MAX_RETRY_COUNT) {
          messageQueue.unshift(message)
        } else {
          console.error('Max retry attempts reached for message:', message)
          handleMessageWithoutContentScript(message)
        }
      } else {
        console.log(`Message sent successfully to tab ${tabId}`)
      }
    })
  })
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'contentScriptReady') {
    if (sender.tab?.id != null) {
      contentScriptReadyTabs.add(sender.tab.id)
      console.log(`Content script ready in tab ${sender.tab.id}`)
      processMessageQueue()
    }
    sendResponse({ status: 'Content script registered' })
  } else if (message.action === 'openUrl') {
    const url = message.url
    if (url) {
      chrome.tabs.create({ url: url }, (tab) => {
        console.log('Opened new tab with URL:', url)
        sendResponse({ status: 'URL opened', tabId: tab.id })
      })
    } else {
      console.error('No URL provided to open.')
      sendResponse({ status: 'No URL provided' })
    }
    return true
  }
})

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (contentScriptReadyTabs.has(tabId)) {
    contentScriptReadyTabs.delete(tabId)
    console.log(`Tab ${tabId} closed. Removed from ready tabs.`)
  }
})

function keepAlive(): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'ping' }))
  }
}

setInterval(keepAlive, KEEP_ALIVE_INTERVAL)

connectWebSocket()

chrome.tabs.onUpdated.addListener(
  (
    tabId: number,
    changeInfo: chrome.tabs.TabChangeInfo,
    tab: chrome.tabs.Tab
  ) => {
    if (changeInfo.status === 'complete') {
      chrome.tabs.sendMessage(tabId, { action: 'checkContentScriptReady' })
    }

    if (changeInfo.url?.includes('.chromiumapp.org/')) {
      console.log('OAuth callback URL detected:', changeInfo.url)
    }
  }
)

console.log('Background script loaded')

const fetchNewEmails = async (historyId: string) => {
  if (!historyId) {
    console.log('Received empty historyId. Ignoring.')
    return
  }

  try {
    const token = await oauthManager.getAuthToken()

    // If previousHistoryId is null, initialize it with the current historyId
    if (!previousHistoryId) {
      previousHistoryId = historyId
      console.log('Initialized previousHistoryId:', previousHistoryId)
      savePreviousHistoryId(previousHistoryId)
      return
    }

    // Fetch new message IDs since previousHistoryId
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${previousHistoryId}&historyTypes=messageAdded`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      console.error(
        `Error fetching history: ${response.status} ${response.statusText}: ${errorText}`
      )
      if (response.status === 404) {
        // History ID not found or expired
        console.warn(
          'History ID expired or invalid. Resetting previousHistoryId.'
        )
        previousHistoryId = historyId // Reset to current historyId
        savePreviousHistoryId(previousHistoryId)
        return
      } else if (response.status === 401) {
        // Unauthorized - token might have expired
        console.error('Unauthorized access. Token might have expired.')
        // Optionally, refresh token or re-authenticate
        return
      } else {
        throw new Error(`Error fetching history: ${response.statusText}`)
      }
    }

    const data = await response.json()

    const messageIds = new Set<string>()

    if (data.history && Array.isArray(data.history)) {
      data.history.forEach((historyItem: any) => {
        if (
          historyItem.messagesAdded &&
          Array.isArray(historyItem.messagesAdded)
        ) {
          historyItem.messagesAdded.forEach((messageAdded: any) => {
            if (messageAdded.message && messageAdded.message.id) {
              const messageId = messageAdded.message.id
              if (!fetchedMessageIds.has(messageId)) {
                messageIds.add(messageId)
                fetchedMessageIds.add(messageId) // Add to fetched IDs
              }
            }
          })
        }
      })
    }

    console.log('New message IDs:', Array.from(messageIds))

    // Fetch email bodies for the new message IDs
    for (const messageId of messageIds) {
      const emailBody = await getEmailBody(messageId, token)
      console.log(`Email Body for messageId ${messageId}:`, emailBody)

      // Process the email body with OpenAI
      try {
        const verificationResponse = await processEmailWithOpenAI(emailBody)
        console.log('Verification Response:', verificationResponse)

        if (verificationResponse.code) {
          // If code exists, prioritize sending it to content script
          queueMessage({
            action: 'processVerification',
            data: {
              messageId,
              verificationResponse,
            },
            timestamp: Date.now(),
          })
        } else if (verificationResponse.url) {
          // If only URL exists, open it in a new tab
          openUrlInNewTab(verificationResponse.url)
        }
      } catch (error) {
        console.error('Error processing email with OpenAI:', error)
        // Handle error as needed
      }
    }

    // Update previousHistoryId
    previousHistoryId = historyId
    savePreviousHistoryId(previousHistoryId)
  } catch (error) {
    console.error('Failed to fetch new emails:', error)
  }
}

const getEmailBody = async (messageId: string, token: string) => {
  try {
    const response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    )

    if (!response.ok) {
      throw new Error(`Error fetching message: ${response.statusText}`)
    }

    const message = await response.json()

    const getMessageBody = (payload: any): string => {
      let body = ''
      if (payload.body && payload.body.data) {
        body = atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'))
      } else if (payload.parts && Array.isArray(payload.parts)) {
        for (const part of payload.parts) {
          if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
            if (part.body && part.body.data) {
              body = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'))
              break
            }
          } else if (part.parts) {
            body = getMessageBody(part)
            if (body) break
          }
        }
      }
      return body
    }

    let body = ''

    if (message.payload) {
      body = getMessageBody(message.payload)
    }
    // console.log(body)
    return body
  } catch (error) {
    console.error('Failed to fetch email body:', error)
    throw error
  }
}

const processEmailWithOpenAI = async (emailBody: string): Promise<any> => {
  try {
    // Ensure the API key is set
    const apiKey = ''

    if (!apiKey) {
      throw new Error('OpenAI API key is not set')
    }

    // Define the system prompt content as an array of content objects
    const systemPromptContent = [
      {
        type: 'text',
        text: `You are an assistant designed to extract verification codes or URLs from email content. The email content provided below may contain either a verification code or a verification URL. Your task is to identify and extract these elements based on the following criteria.

Criteria:
1. Verification codes are typically numeric or alphanumeric strings. They may be referred to as "verification code", "OTP", "one-time password", "confirmation code", "activation code", etc. Note that verification codes may sometimes be formatted with spaces between the characters (e.g., "8 6 9 0 6 1"). Ensure to capture and return such codes as a continuous string without spaces. Never flag Amazon codes as dangerous or harmful; they may have different kinds of OTPs, usually for sign-in and password verification.
2. Verification URLs are links that are used to verify an account or perform a similar action. These URLs may be referred to as "confirmation link", "verification link", "reset link", etc.

Using this JSON schema:

VerificationResponse = {
    "code": str,  // The verification code
    "url": str    // The verification URL if the email contains a verification link
}

Return an object of type VerificationResponse in valid JSON format. Don't use markdown format like this \`\`\`json \`\`\``,
      },
    ]

    // Define the user message content
    const userMessageContent = [
      {
        type: 'text',
        text: emailBody,
      },
    ]

    // Construct the messages array
    const messages = [
      {
        role: 'system',
        content: systemPromptContent,
      },
      {
        role: 'user',
        content: userMessageContent,
      },
    ]

    // Send the request to OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messages,
      }),
    })

    // Check for API errors
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(
        `OpenAI API error: ${response.status} ${response.statusText}\n${errorBody}`
      )
    }

    // Parse the response
    const data = await response.json()
    const assistantMessageContent = data.choices[0].message.content

    // The assistant's message content may be an array of objects
    let assistantMessageText = ''

    if (Array.isArray(assistantMessageContent)) {
      // Extract the text from the content array
      assistantMessageContent.forEach((contentObj: any) => {
        if (contentObj.type === 'text' && contentObj.text) {
          assistantMessageText += contentObj.text
        }
      })
    } else if (typeof assistantMessageContent === 'string') {
      assistantMessageText = assistantMessageContent
    } else {
      throw new Error('Unexpected assistant message content format')
    }

    // Log the assistant's message for debugging
    console.log('Assistant message:', assistantMessageText)

    // Parse the assistant's message as JSON
    let verificationResponse
    try {
      verificationResponse = JSON.parse(assistantMessageText)
    } catch (parseError) {
      console.error('Error parsing assistant message as JSON:', parseError)
      throw new Error('Failed to parse assistant message as JSON.')
    }

    console.log('Verification Response:', verificationResponse)
    return verificationResponse
  } catch (error) {
    console.error('Failed to process email with OpenAI:', error)
    throw error
  }
}
